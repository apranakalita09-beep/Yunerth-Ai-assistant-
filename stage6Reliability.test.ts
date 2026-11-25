import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ConversationFlowController } from "./conversationFlow.ts";
import {
  buildClarificationFallbackPrompt,
  buildYunerthOrchestrationInstruction,
} from "./orchestration.ts";
import {
  SessionContextTracker,
  classifySilentUserTurn,
  detectVoiceSpeedCommand,
  isQuestionAboutVoiceSpeed,
  isVoiceModeOnlyUtterance,
  sanitizeSessionContextSummary,
} from "./sessionContext.ts";
import { LiveSession } from "./src/voice/LiveSession.ts";
import { StateManager } from "./src/voice/StateManager.ts";
import { createDefaultExpressionState, type VoiceSpeedMode } from "./src/voice/types.ts";
import {
  buildActiveVoiceSpeedBlock,
  buildUnifiedLiveSystemInstruction,
  getVoiceSpeedProfile,
} from "./voiceExpression.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTests(): Promise<void> {
  // =========================================================================
  // 1. LONGER CONVERSATION CONTEXT, BACK-REFERENCES, PIVOTS & UPDATES
  // =========================================================================
  {
    const tracker = new SessionContextTracker();

    // Multi-turn thread spanning 12+ turns across 2 topics + detail updates + back-reference
    tracker.recordTurn({
      userText: "I'm planning a phone upgrade in Bengaluru.",
      assistantText: "Nice! What kind of phone features or budget are you eyeing?",
    });
    tracker.recordTurn({
      userText: "My budget is ₹25,000 and I prefer good battery life.",
      assistantText: "Got it, around ₹25,000 with strong battery life gives great options.",
    });

    // Update constraint -> old budget/location should be replaced cleanly without colliding
    tracker.recordTurn({
      userText: "Actually, I updated my budget to ₹35,000 and I'm shopping from Mumbai now.",
      assistantText: "Understood—updated to ₹35,000 in Mumbai.",
    });

    // Ambiguous / clarifying assistant turn creates a pending question, then next turn resolves it
    tracker.recordTurn({
      userText: "Check the weather in...",
      assistantText: "Which city would you like me to check?",
    });
    let summary = tracker.getSummary();
    assert.ok(summary.pendingItems.length >= 1, "Clarification should record pending item");

    tracker.recordTurn({
      userText: "In Pune.",
      assistantText: "Right now in Pune it's 28°C and clear.",
    });

    // Add several more turns to exceed the 6-turn recent window
    for (let i = 1; i <= 8; i++) {
      tracker.recordTurn({
        userText: `Turn ${i}: Let's discuss solar panels and home inverters (${i}).`,
        assistantText: `Answer ${i}: Here is a concise note on home solar sizing (${i}).`,
      });
    }

    // Now test back-reference to the earlier phone topic
    tracker.recordTurn({
      userText: "Going back to what I said earlier about that phone topic, what fits my preference?",
      assistantText: "Sure—for your ₹35,000 phone budget focused on battery life, let's look closely.",
    });

    summary = tracker.getSummary();
    assert.equal(summary.turnCount, 14);
    assert.equal(summary.recentTurns.length, 6, "Recent turn digest stays bounded to 6 turns");
    assert.ok(
      summary.currentTopic?.toLowerCase().includes("phone"),
      `Expected reactivated phone topic, got: ${summary.currentTopic}`
    );
    assert.ok(
      summary.keyDetails.some((d) => d.includes("35,000")) &&
        !summary.keyDetails.some((d) => d.includes("25,000")),
      "New budget constraint must replace old budget instead of colliding"
    );
    assert.ok(
      summary.keyDetails.some((d) => d.includes("Mumbai")),
      "Updated location detail should be retained"
    );

    const block = tracker.buildContextSummaryBlock();
    assert.ok(block.includes("[STAGE 6 ACTIVE-SESSION WORKING MEMORY"));
    assert.ok(block.includes("Current topic:"));
    assert.ok(block.includes("Condensed recent turns"));

    // Sanitization & restore across auto-reconnect vs reset on disconnect
    const restored = sanitizeSessionContextSummary(JSON.parse(JSON.stringify(summary)));
    assert.ok(restored);
    assert.equal(restored.turnCount, 14);
    assert.equal(sanitizeSessionContextSummary(null), null);
    assert.equal(sanitizeSessionContextSummary("bad"), null);
    const sanitizedUnknown = sanitizeSessionContextSummary({ invalid: true });
    assert.ok(sanitizedUnknown);
    assert.equal(sanitizedUnknown.turnCount, 0);
    assert.equal(sanitizedUnknown.currentTopic, null);

    tracker.reset();
    assert.equal(tracker.getSummary().turnCount, 0);
    assert.equal(tracker.buildContextSummaryBlock(), "");
  }

  // =========================================================================
  // 2. NON-SILENT CLARIFICATION & TURN RECOVERY (FEATURE 2)
  // =========================================================================
  {
    assert.equal(classifySilentUserTurn("What is the weather in", true), "incomplete_trailing");
    assert.equal(classifySilentUserTurn("Compare Tokyo and...", true), "incomplete_trailing");
    assert.equal(classifySilentUserTurn("", true), "unclear_speech");
    assert.equal(classifySilentUserTurn("", false), null);

    const incompletePrompt = buildClarificationFallbackPrompt({
      reason: "incomplete_trailing",
      partialTranscript: "What is the weather in",
    });
    assert.ok(incompletePrompt.includes("What is the weather in"));
    assert.ok(incompletePrompt.includes("Do NOT stay silent"));

    const unclearPrompt = buildClarificationFallbackPrompt({
      reason: "unclear_speech",
    });
    assert.ok(unclearPrompt.includes("Sorry, I didn't quite catch that"));

    const clarifications: Array<{ reason: string; partialTranscript: string }> = [];
    const summaries: number[] = [];

    const flow = new ConversationFlowController({
      silenceDelayMs: 5000,
      greetingDelayMs: 5000,
      onSendGreeting: () => {},
      onSendSilenceReengagement: () => {},
      onSilentUserTurnDetected: (info) => {
        clarifications.push(info);
        return true;
      },
      onContextSummaryChange: (s) => {
        summaries.push(s.turnCount);
      },
    });

    flow.onSessionReady();

    // Case A: Unmute primer silence (no speech activity, no transcript) must NOT trigger clarification
    flow.onTurnComplete();
    assert.equal(clarifications.length, 0);

    // Case B: Incomplete user turn with zero model audio MUST trigger clarification
    flow.onClientState({ playbackActive: false, userSpeaking: true, muted: false });
    flow.onInputTranscription("What is the weather in");
    flow.onClientState({ playbackActive: false, userSpeaking: false, muted: false });
    flow.onTurnComplete();
    assert.equal(clarifications.length, 1);
    assert.equal(clarifications[0].reason, "incomplete_trailing");
    assert.equal(clarifications[0].partialTranscript, "What is the weather in");

    // Simulate model delivering the spoken clarification
    flow.onModelAudioChunk();
    flow.onOutputTranscription("Which city would you like me to check?");
    flow.onTurnComplete();
    assert.equal(clarifications.length, 1, "Clarification response itself must not recurse");
    assert.ok(summaries.length >= 1);

    // Case C: Empty speech burst (audio activity seen, no transcript, zero output audio) -> unclear speech
    flow.onClientState({ playbackActive: false, userSpeaking: true, muted: false });
    flow.onClientState({ playbackActive: false, userSpeaking: false, muted: false });
    flow.onTurnComplete();
    assert.equal(clarifications.length, 2);
    assert.equal(clarifications[1].reason, "unclear_speech");

    // Simulate clarification answer completed
    flow.onModelAudioChunk();
    flow.onOutputTranscription("Sorry, I didn't quite catch that. Could you say it again?");
    flow.onTurnComplete();

    // Case D: Healthy turn with audio must NOT trigger clarification
    flow.onClientState({ playbackActive: false, userSpeaking: true, muted: false });
    flow.onInputTranscription("Check Mumbai weather");
    flow.onClientState({ playbackActive: false, userSpeaking: false, muted: false });
    flow.onModelAudioChunk();
    flow.onOutputTranscription("It's 31°C and humid in Mumbai.");
    flow.onTurnComplete();
    assert.equal(clarifications.length, 2);

    flow.dispose();
  }

  // =========================================================================
  // 3. VOICE-ONLY SPEED COMMANDS, SPEED QUESTIONS & PROSODIC MODES
  // =========================================================================
  {
    // Slow commands (all user-specified phrasings + natural equivalents)
    assert.equal(detectVoiceSpeedCommand("Speak slowly."), "slow");
    assert.equal(detectVoiceSpeedCommand("Can you explain this more slowly?"), "slow");
    assert.equal(detectVoiceSpeedCommand("Can you explain this slowly?"), "slow");
    assert.equal(detectVoiceSpeedCommand("Slow down a little."), "slow");
    assert.equal(detectVoiceSpeedCommand("Use slow speaking mode."), "slow");
    assert.equal(detectVoiceSpeedCommand("Can you speak a bit slower please?"), "slow");

    // Fast commands (all user-specified phrasings + natural equivalents)
    assert.equal(detectVoiceSpeedCommand("Speak faster."), "fast");
    assert.equal(detectVoiceSpeedCommand("Can you explain this quickly?"), "fast");
    assert.equal(detectVoiceSpeedCommand("Answer a little faster."), "fast");
    assert.equal(detectVoiceSpeedCommand("Use fast speaking mode."), "fast");
    assert.equal(detectVoiceSpeedCommand("Speak faster from now on."), "fast");
    assert.equal(detectVoiceSpeedCommand("Speed up your pace a little"), "fast");

    // Normal commands (all user-specified phrasings + natural equivalents)
    assert.equal(detectVoiceSpeedCommand("Speak normally."), "normal");
    assert.equal(detectVoiceSpeedCommand("Return to normal speed."), "normal");
    assert.equal(detectVoiceSpeedCommand("Use your normal speaking pace."), "normal");
    assert.equal(detectVoiceSpeedCommand("Stop speaking so fast."), "normal");
    assert.equal(detectVoiceSpeedCommand("Back to normal speed"), "normal");

    // Informational questions ABOUT speed must NOT trigger a mode switch!
    assert.equal(isQuestionAboutVoiceSpeed("What is your normal speaking speed?"), true);
    assert.equal(detectVoiceSpeedCommand("What is your normal speaking speed?"), null);
    assert.equal(detectVoiceSpeedCommand("What's your current speaking pace?"), null);
    assert.equal(detectVoiceSpeedCommand("Do you have a slow speaking mode?"), null);
    assert.equal(detectVoiceSpeedCommand("How fast do you speak?"), null);

    // Ordinary conversational adjectives must NOT switch mode
    assert.equal(detectVoiceSpeedCommand("My internet connection is really slow today"), null);
    assert.equal(detectVoiceSpeedCommand("That train is very fast"), null);
    assert.equal(detectVoiceSpeedCommand("Is that normal for this weather?"), null);

    // Speed-only commands (including "Can you explain this slowly?") preserve topic,
    // whereas combined topic + speed requests ("Speak slower and tell me about quantum physics") do not suppress new topic
    assert.equal(isVoiceModeOnlyUtterance("Please speak slower"), true);
    assert.equal(isVoiceModeOnlyUtterance("Can you explain this slowly?"), true);
    assert.equal(
      isVoiceModeOnlyUtterance("Speak slower and tell me about quantum physics in depth"),
      false
    );

    // Check prosodic profiles preserve Aoede and stay <= 1.20x fast cap
    const slowProfile = getVoiceSpeedProfile("slow");
    const normalProfile = getVoiceSpeedProfile("normal");
    const fastProfile = getVoiceSpeedProfile("fast");
    assert.equal(slowProfile.targetMultiplier, "~0.90x");
    assert.equal(normalProfile.targetMultiplier, "1.0x");
    assert.equal(fastProfile.targetMultiplier, "~1.15x");
    assert.ok(buildActiveVoiceSpeedBlock("slow").includes("Aoede"));
    assert.ok(buildActiveVoiceSpeedBlock("fast").includes("clarity"));
    assert.ok(buildActiveVoiceSpeedBlock("fast").includes("Aoede"));

    const unified = buildUnifiedLiveSystemInstruction({
      baseInstruction: "BASE",
      expression: createDefaultExpressionState(),
      voiceMode: "fast",
      contextSummaryBlock: "[STAGE 6 ACTIVE SESSION CONTEXT — APPLY SILENTLY]\n- Active Topic: Mumbai trip",
    });
    assert.ok(unified.startsWith("BASE"));
    assert.ok(unified.includes("STAGE 5.2 ACTIVE VOCAL DELIVERY POSTURE"));
    assert.ok(unified.includes("STAGE 6 ACTIVE VOICE SPEED MODE"));
    assert.ok(unified.includes("STAGE 6 ACTIVE SESSION CONTEXT"));
  }

  // =========================================================================
  // 4. VOICE-ONLY PERSISTENCE, SPEED QUESTIONS & RECONNECT RESTORE
  // =========================================================================
  {
    const syncedPayloads: Array<{ mode: VoiceSpeedMode; hasContext: boolean }> = [];
    const modeEvents: Array<{ mode: VoiceSpeedMode; source: string }> = [];

    const flow = new ConversationFlowController({
      initialVoiceMode: "normal",
      silenceDelayMs: 6000,
      greetingDelayMs: 6000,
      onSendGreeting: () => {},
      onSendSilenceReengagement: () => {},
      onVoiceModeChange: (mode, source) => {
        modeEvents.push({ mode, source });
      },
      onLiveContextSync: (payload) => {
        syncedPayloads.push({
          mode: payload.voiceMode,
          hasContext: payload.contextSummaryBlock.length > 0,
        });
      },
    });

    flow.onSessionReady();
    assert.equal(flow.getVoiceMode(), "normal", "Fresh session starts in Normal mode");

    // First turn on topic
    flow.onInputTranscription("Let's talk about electric vehicles.");
    flow.onModelAudioChunk();
    flow.onOutputTranscription("Sure! Electric vehicles are improving rapidly.");
    flow.onTurnComplete();
    const savedSummary = flow.getContextSummary();
    assert.ok(savedSummary.currentTopic?.toLowerCase().includes("electric vehicles"));

    // Voice command ("Can you explain this more slowly?") triggers early & preserves EV topic
    flow.onInputTranscription("Can you explain this more slowly?");
    assert.equal(flow.getVoiceMode(), "slow");
    flow.onModelAudioChunk();
    flow.onOutputTranscription("Of course—electric cars store energy in large battery packs.");
    flow.onTurnComplete();
    assert.equal(flow.getVoiceMode(), "slow");
    assert.equal(modeEvents[0].mode, "slow");
    assert.equal(modeEvents[0].source, "voice_command");
    assert.ok(
      flow.getContextSummary().currentTopic?.toLowerCase().includes("electric vehicles"),
      "Speed command should preserve the existing conversation topic"
    );

    // Next normal conversational turn keeps Slow mode active until user requests another mode
    flow.onInputTranscription("What about charging times?");
    flow.onModelAudioChunk();
    flow.onOutputTranscription("Fast chargers take around twenty to thirty minutes.");
    flow.onTurnComplete();
    assert.equal(flow.getVoiceMode(), "slow", "Slow mode stays active on subsequent turns");

    // Speed-related question MUST NOT switch out of active Slow mode
    flow.onInputTranscription("What is your normal speaking speed?");
    flow.onModelAudioChunk();
    flow.onOutputTranscription("My normal speaking pace is balanced and natural.");
    flow.onTurnComplete();
    assert.equal(flow.getVoiceMode(), "slow", "Question about speed must not change active mode");

    // Switch to fast mode and verify persistence across turn, then return to normal via "Stop speaking so fast."
    flow.onInputTranscription("Speak faster from now on.");
    assert.equal(flow.getVoiceMode(), "fast");
    flow.onModelAudioChunk();
    flow.onOutputTranscription("Got it, I'll pick up the pace.");
    flow.onTurnComplete();
    assert.equal(flow.getVoiceMode(), "fast");

    flow.onInputTranscription("Stop speaking so fast.");
    assert.equal(flow.getVoiceMode(), "normal");
    flow.onModelAudioChunk();
    flow.onOutputTranscription("Back to my normal pace.");
    flow.onTurnComplete();
    assert.equal(flow.getVoiceMode(), "normal");

    assert.ok(syncedPayloads.some((p) => p.mode === "slow" && p.hasContext));
    flow.dispose();

    // Auto-reconnect simulation: restored session retains active mode & summary
    const reconnectedSyncs: string[] = [];
    const reconnectedFlow = new ConversationFlowController({
      initialVoiceMode: "fast",
      onSendGreeting: () => {},
      onSendSilenceReengagement: () => {},
      onLiveContextSync: (payload) => {
        reconnectedSyncs.push(`${payload.voiceMode}:${payload.contextSummaryBlock}`);
      },
    });
    reconnectedFlow.onSessionReady();
    reconnectedFlow.restoreContextSummary(savedSummary);
    assert.ok(
      reconnectedSyncs.some(
        (entry) =>
          entry.startsWith("fast:") && entry.includes("electric vehicles")
      ),
      "Reconnect context restoration should resync both active speed mode and session summary"
    );
    reconnectedFlow.dispose();
  }

  // =========================================================================
  // 5. STATE MANAGER, ORIGINAL UI RESTORATION & LIVESESSION PROTOCOL
  // =========================================================================
  {
    const sm = new StateManager();
    assert.equal(sm.getSnapshot().voiceMode, "normal");
    sm.setVoiceMode("slow");
    assert.equal(sm.getSnapshot().voiceMode, "slow");

    // Disconnecting or starting a fresh session resets voiceMode back to normal
    sm.resetDisconnected();
    assert.equal(sm.getSnapshot().voiceMode, "normal");
    sm.setVoiceMode("fast");
    sm.setConnecting();
    assert.equal(sm.getSnapshot().voiceMode, "normal");

    // Original UI restored: zero Slow/Normal/Fast buttons or speed selector markup
    const voiceControlsSource = fs.readFileSync(
      path.resolve(process.cwd(), "src/components/VoiceControls.tsx"),
      "utf8"
    );
    const appSource = fs.readFileSync(
      path.resolve(process.cwd(), "src/App.tsx"),
      "utf8"
    );
    assert.ok(voiceControlsSource.includes("Connect"));
    assert.ok(voiceControlsSource.includes("Mute"));
    assert.equal(voiceControlsSource.includes("Voice speaking speed"), false);
    assert.equal(voiceControlsSource.includes("VOICE_SPEED_OPTIONS"), false);
    assert.equal(voiceControlsSource.includes("onVoiceModeChange"), false);
    assert.equal(appSource.includes("setVoiceMode"), false);
    assert.equal(appSource.includes("onVoiceModeChange"), false);

    // Mock browser globals for LiveSession protocol test
    const sentMessages: Array<Record<string, unknown>> = [];
    const createdUrls: string[] = [];

    class MockWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      url: string;
      readyState = 1;
      onmessage: ((ev: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: ((ev: { reason?: string }) => void) | null = null;

      constructor(url: string) {
        this.url = url;
        createdUrls.push(url);
        holder.socket = this;
      }

      send(raw: string) {
        sentMessages.push(JSON.parse(raw) as Record<string, unknown>);
      }

      close() {
        this.readyState = 3;
      }
    }

    const holder: { socket: MockWebSocket | null } = { socket: null };

    const origWindow = (globalThis as Record<string, unknown>).window;
    const origWs = (globalThis as Record<string, unknown>).WebSocket;

    Object.defineProperty(globalThis, "WebSocket", {
      value: MockWebSocket,
      configurable: true,
    });
    Object.defineProperty(globalThis, "window", {
      value: {
        location: { protocol: "https:", host: "localhost:3000" },
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
      },
      configurable: true,
    });

    try {
      const receivedModes: VoiceSpeedMode[] = [];
      const receivedSummaries: number[] = [];

      const session = new LiveSession({
        onReady: () => {},
        onAudio: () => {},
        onInterrupted: () => {},
        onTurnComplete: () => {},
        onVoiceMode: (mode) => receivedModes.push(mode),
        onContextSummary: (sum) => receivedSummaries.push(sum.turnCount),
        onError: () => {},
        onClose: () => {},
      });

      const connectPromise = session.connect({ voiceMode: "slow" });
      await sleep(10);
      assert.ok(createdUrls[0].includes("mode=slow"));
      assert.ok(holder.socket);

      holder.socket.onmessage?.({ data: JSON.stringify({ type: "ready" }) });
      await connectPromise;

      holder.socket.onmessage?.({
        data: JSON.stringify({ type: "voiceMode", mode: "fast" }),
      });
      holder.socket.onmessage?.({
        data: JSON.stringify({
          type: "contextSummary",
          summary: {
            currentTopic: "Mumbai plan",
            topicHistory: [],
            keyDetails: [],
            pendingItems: [],
            recentTurns: [],
            turnCount: 3,
            updatedAt: Date.now(),
          },
        }),
      });
      assert.deepEqual(receivedModes, ["fast"]);
      assert.deepEqual(receivedSummaries, [3]);

      session.sendRestoreSessionContext({
        currentTopic: "Mumbai plan",
        topicHistory: [],
        keyDetails: [],
        pendingItems: [],
        recentTurns: [],
        turnCount: 3,
        updatedAt: Date.now(),
      });

      assert.ok(
        sentMessages.some((m) => m.type === "restoreSessionContext")
      );

      session.close();
    } finally {
      Object.defineProperty(globalThis, "WebSocket", {
        value: origWs,
        configurable: true,
      });
      Object.defineProperty(globalThis, "window", {
        value: origWindow,
        configurable: true,
      });
    }
  }

  // =========================================================================
  // 6. ORCHESTRATION RULES: MULTI-QUESTION, MULTI-PART TASKS & QUALITY CHECK
  // =========================================================================
  {
    const instruction = buildYunerthOrchestrationInstruction("Asia/Kolkata");

    // Existing capabilities preserved
    assert.ok(instruction.includes("get_world_clock"));
    assert.ok(instruction.includes("get_weather"));
    assert.ok(instruction.includes("search_web"));
    assert.ok(instruction.includes("Stage 5.2 Emotional Voice Expression"));
    assert.ok(instruction.includes("Stage 5.3 Natural Emotional Transitions"));

    // Stage 6 capabilities present
    assert.ok(instruction.includes("Stage 6 Context Preservation"));
    assert.ok(instruction.includes("Never Respond With Silence When Confused"));
    assert.ok(instruction.includes("Stage 6 Complete Multi-Question & Multi-Part Task Handling"));
    assert.ok(instruction.includes("No Arbitrary Question Limit"));
    assert.ok(instruction.includes("Mixed Clear + Unclear Questions"));
    assert.ok(instruction.includes("Complex Multi-Part Tool & Task Coordination"));
    assert.ok(instruction.includes("precipitation probability/amount before advising on an umbrella"));
    assert.ok(instruction.includes("Silent Internal Quality Check (Never Speak This Checklist Aloud)"));
  }

  console.log("All Stage 6 reliability & intelligent task handling tests passed.");
}

runTests().catch((err) => {
  console.error("Stage 6 tests failed:", err);
  process.exit(1);
});
