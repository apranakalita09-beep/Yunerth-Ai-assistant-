import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { GoogleGenAI } from "@google/genai";
import { ConversationFlowController } from "./conversationFlow.ts";
import {
  analyzeCompletedTurnForMemory,
  BackgroundMemoryAnalyzerQueue,
  shouldSkipAsyncTurnAnalysis,
} from "./memoryAnalyzer.ts";
import {
  assessDuplicateOrConflict,
  buildRetrievedMemoriesBlock,
  classifyFirestoreFailure,
  coerceMemoryCategory,
  containsSensitiveSecret,
  normalizeMemoryDescription,
  retrieveRelevantMemories,
  sanitizeMemoryRecords,
  searchMemoriesLocally,
} from "./memoryCore.ts";
import {
  buildYunerthOrchestrationInstruction,
  MEMORY_FUNCTION_DECLARATIONS,
} from "./orchestration.ts";
import {
  MEMORY_CATEGORIES,
  MEMORY_FILTER_TABS,
  type MemoryRecord,
} from "./src/memory/types.ts";
import { createDefaultExpressionState } from "./src/voice/types.ts";
import { buildUnifiedLiveSystemInstruction } from "./voiceExpression.ts";

let passed = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`PASS: ${name}`);
    });
}

function makeMemory(
  id: string,
  description: string,
  category: MemoryRecord["category"],
  overrides: Partial<MemoryRecord> = {}
): MemoryRecord {
  const now = Date.now();
  return {
    id,
    ownerId: "user_1",
    description,
    category,
    source: "Manual",
    importance: "standard",
    confirmationStatus: "manual",
    keywords: [],
    createdAt: now - 10000,
    updatedAt: now,
    ...overrides,
  };
}

async function run() {
  await test("Exactly 7 memory categories exist with zero Image category", () => {
    assert.deepEqual([...MEMORY_CATEGORIES], [
      "Identity",
      "Preferences",
      "Life",
      "Active",
      "Relationships",
      "Milestones",
      "Behaviors",
    ]);
    assert.equal(MEMORY_FILTER_TABS.length, 8);
    assert.equal(
      MEMORY_CATEGORIES.some((c) => c.toLowerCase().includes("image")),
      false
    );
  });

  await test("UI components contain zero Image Memory controls or uploaders", () => {
    const drawerSrc = fs.readFileSync(
      path.resolve("src/components/MemoryCoreDrawer.tsx"),
      "utf8"
    );
    const overlaySrc = fs.readFileSync(
      path.resolve("src/components/MemoryStatusOverlay.tsx"),
      "utf8"
    );
    const rulesSrc = fs.readFileSync(path.resolve("firestore.rules"), "utf8");
    assert.equal(/Add Image|type=["']file["']|imageMemory/i.test(drawerSrc), false);
    assert.equal(/Add Image|type=["']file["']|imageMemory/i.test(overlaySrc), false);
    assert.equal(rulesSrc.includes("'Image'"), false);
  });

  await test("Sensitive secrets and credentials are strictly blocked", () => {
    assert.equal(
      containsSensitiveSecret("My email password is SuperSecret99!").blocked,
      true
    );
    assert.equal(
      containsSensitiveSecret("Save my API key AIzaSyD4K8example9876543210").blocked,
      true
    );
    assert.equal(
      containsSensitiveSecret("My bearer token is eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc").blocked,
      true
    );
    assert.equal(
      containsSensitiveSecret("Card number 4532 1234 5678 9012").blocked,
      true
    );
    assert.equal(
      containsSensitiveSecret("Prefer explanations in simple English").blocked,
      false
    );
    assert.equal(
      containsSensitiveSecret("Favorite game is GTA 6").blocked,
      false
    );

    const sanitized = sanitizeMemoryRecords([
      makeMemory("mem_safe", "Favorite game is GTA 6", "Preferences"),
      makeMemory("mem_secret", "My API key is sk-liveSecretKey1234567890", "Life"),
    ]);
    assert.equal(sanitized.length, 1);
    assert.equal(sanitized[0].id, "mem_safe");
  });

  await test("Duplicate detection distinguishes exact duplicates vs update conflicts and corrections", () => {
    const existing: MemoryRecord[] = [
      makeMemory("mem_1", "Favorite game is GTA 5", "Preferences", {
        keywords: ["favorite", "game", "gta"],
      }),
      makeMemory("mem_2", "Ongoing project is building Yunerth", "Active", {
        keywords: ["ongoing", "project", "building", "yunerth"],
      }),
      makeMemory("mem_3", "Favorite color is blue", "Preferences", {
        keywords: ["favorite", "color", "blue"],
      }),
    ];

    const exact = assessDuplicateOrConflict(
      "Favorite game is GTA 5",
      "Preferences",
      existing
    );
    assert.equal(exact.kind, "exact_duplicate");

    const conflict = assessDuplicateOrConflict(
      "Favorite game is GTA 6",
      "Preferences",
      existing
    );
    assert.equal(conflict.kind, "update_or_conflict");
    assert.equal(conflict.matchedMemory?.id, "mem_1");

    const colorCorrection = assessDuplicateOrConflict(
      "Favorite color is green",
      "Preferences",
      existing
    );
    assert.equal(colorCorrection.kind, "update_or_conflict");
    assert.equal(colorCorrection.matchedMemory?.id, "mem_3");

    const distinct = assessDuplicateOrConflict(
      "Likes morning strength workouts",
      "Behaviors",
      existing
    );
    assert.equal(distinct.kind, "none");
  });

  await test("Targeted retrieval surfaces core boot facts (like favorite color) and avoids irrelevant bulk dumping", () => {
    const pool: MemoryRecord[] = [
      makeMemory("m_pref_eng", "Prefer explanations in simple English", "Preferences"),
      makeMemory("m_pref_color", "Favorite color is blue", "Preferences"),
      makeMemory("m_active_proj", "Working on Yunerth voice assistant project", "Active"),
      makeMemory("m_rel_sister", "Sister lives in Pune", "Relationships"),
      makeMemory("m_mile_grad", "Graduated in Computer Science", "Milestones"),
      makeMemory("m_life_pet", "Has a golden retriever named Max", "Life"),
      makeMemory("m_behav_run", "Runs every morning at 6 AM", "Behaviors"),
      makeMemory("m_id_city", "Based in Bengaluru", "Identity"),
      makeMemory("m_pref_tea", "Prefers masala chai over coffee", "Preferences"),
      makeMemory("m_life_travel", "Plans to visit Japan next autumn", "Life"),
      makeMemory("m_rel_mentor", "Mentor advises on systems architecture", "Relationships"),
    ];

    const relevant = retrieveRelevantMemories(
      pool,
      "Please explain Yunerth architecture in simple English",
      5
    );
    assert.ok(relevant.length <= 5);
    assert.equal(
      relevant.some((m) => m.id === "m_pref_eng"),
      true
    );
    assert.equal(
      relevant.some((m) => m.id === "m_active_proj"),
      true
    );
    assert.equal(
      relevant.some((m) => m.id === "m_life_travel"),
      false
    );

    const sessionBoot = retrieveRelevantMemories(pool, "", 8);
    assert.ok(sessionBoot.length >= 4 && sessionBoot.length <= 10);
    assert.equal(
      sessionBoot.some((m) => m.id === "m_pref_color"),
      true
    );

    const block = buildRetrievedMemoriesBlock(relevant);
    assert.ok(block.includes("STAGE 7 LONG-TERM USER MEMORY"));
    assert.ok(block.includes("simple English"));
    assert.ok(block.includes("follow-up remark or relevant question"));
  });

  await test("Local search and category filtering match Memory Core drawer requirements", () => {
    const list: MemoryRecord[] = [
      makeMemory("m1", "Favorite game is GTA 6", "Preferences", {
        source: "Voice",
      }),
      makeMemory("m2", "Learning GitHub workflows and CI", "Active", {
        source: "Automatic",
      }),
      makeMemory("m3", "Prefers short direct summaries", "Preferences", {
        source: "Manual",
      }),
    ];

    assert.equal(searchMemoriesLocally(list, "", "Preferences").length, 2);
    const matches = searchMemoriesLocally(list, "GTA", "All Memories");
    assert.equal(matches.length, 1);
    assert.equal(matches[0].id, "m1");
  });

  await test("Async turn analyzer skips small talk, recall questions, speed commands, explicit commands, and secrets while keeping short preferences", () => {
    assert.equal(shouldSkipAsyncTurnAnalysis("hi"), "too_short");
    assert.equal(shouldSkipAsyncTurnAnalysis("Thank you so much!"), "small_talk");
    assert.equal(
      shouldSkipAsyncTurnAnalysis("What is my favourite colour?"),
      "memory_recall_question"
    );
    assert.equal(
      shouldSkipAsyncTurnAnalysis("Do you remember my favorite game?"),
      "memory_recall_question"
    );
    assert.equal(
      shouldSkipAsyncTurnAnalysis("Can you speak faster please?"),
      "voice_speed_command"
    );
    assert.equal(
      shouldSkipAsyncTurnAnalysis("Yunerth, remember that my favorite game is GTA 6"),
      "explicit_voice_command_handled_by_tool"
    );
    assert.equal(
      shouldSkipAsyncTurnAnalysis("What is the weather in Tokyo right now?"),
      "ephemeral_utility_query"
    );
    assert.equal(
      shouldSkipAsyncTurnAnalysis("My API key is sk-test1234567890abcdef"),
      "sensitive_secret_blocked"
    );
    assert.equal(shouldSkipAsyncTurnAnalysis("I'm vegan"), null);
    assert.equal(
      shouldSkipAsyncTurnAnalysis("By the way, I prefer explanations in simple English"),
      null
    );
  });

  await test("Async turn analyzer uses Gemini 4 ThinkingLevel.LOW + responseSchema without temperature, separates Level 1 & Level 2, and tracks telemetry", async () => {
    let capturedParams: Record<string, unknown> | null = null;
    const fakeAi = {
      models: {
        generateContent: async (params: Record<string, unknown>) => {
          capturedParams = params;
          return {
            text: JSON.stringify({
              memories: [
                {
                  level: "level1_auto",
                  category: "Preferences",
                  description: "Prefers explanations in simple English",
                  reason: "Consistent communication preference",
                },
                {
                  level: "level2_important",
                  category: "Milestones",
                  description: "Major goal to launch robotics startup next year",
                  reason: "Significant long-term life commitment",
                },
                {
                  level: "level1_auto",
                  category: "Life",
                  description: "Password is MyBadPassword123",
                  reason: "Should be stripped by secret guard",
                },
              ],
            }),
          };
        },
      },
    } as unknown as GoogleGenAI;

    const firstPass = await analyzeCompletedTurnForMemory({
      ai: fakeAi,
      userText: "I prefer explanations in simple English and my huge goal is to launch my robotics startup next year",
      assistantText: "Got it, I will keep explanations simple and support that launch goal!",
      existingMemories: [],
      recentlyDeclinedDescriptions: [],
      turnCompletedAtMs: Date.now() - 12,
    });

    assert.ok(capturedParams);
    const config = (capturedParams as { config?: Record<string, unknown> }).config;
    assert.ok(config);
    assert.equal("temperature" in config, false);
    assert.ok(config.responseSchema);
    assert.deepEqual(config.thinkingConfig, { thinkingLevel: "LOW" });
    assert.equal(firstPass.candidates.length, 2);
    assert.equal(firstPass.candidates[0].level, "level1_auto");
    assert.equal(firstPass.candidates[1].level, "level2_important");
    assert.ok(firstPass.metrics.detectionMs >= 0);
    assert.ok(firstPass.metrics.classificationMs >= 0);

    const afterDecline = await analyzeCompletedTurnForMemory({
      ai: fakeAi,
      userText: "I prefer explanations in simple English and my huge goal is to launch my robotics startup next year",
      assistantText: "Sure thing.",
      existingMemories: [
        makeMemory("m_saved", "Prefers explanations in simple English", "Preferences"),
      ],
      recentlyDeclinedDescriptions: [
        "Major goal to launch robotics startup next year",
      ],
    });
    assert.equal(afterDecline.candidates.length, 0);
  });

  await test("BackgroundMemoryAnalyzerQueue deduplicates repeated user turns and keeps backlog bounded asynchronously", async () => {
    let calls = 0;
    const processed: string[] = [];
    const fakeAi = {
      models: {
        generateContent: async () => {
          calls += 1;
          await new Promise((r) => setTimeout(r, 10));
          return {
            text: JSON.stringify({
              memories: [
                {
                  level: "level1_auto",
                  category: "Preferences",
                  description: `Preference item ${calls}`,
                  reason: "Preference",
                },
              ],
            }),
          };
        },
      },
    } as unknown as GoogleGenAI;

    const queue = new BackgroundMemoryAnalyzerQueue({
      getAi: () => fakeAi,
      getExistingMemories: () => [],
      getDeclinedDescriptions: () => [],
      onCandidates: (result) => {
        if (result.candidates[0]) {
          processed.push(result.candidates[0].description);
        }
      },
    });

    assert.equal(
      queue.enqueue({
        userText: "I love masala chai in the morning.",
        assistantText: "Nice!",
        turnCompletedAtMs: Date.now(),
      }),
      true
    );
    // Duplicate normalized signature must be skipped immediately
    assert.equal(
      queue.enqueue({
        userText: "I love masala chai in the morning",
        assistantText: "Great!",
        turnCompletedAtMs: Date.now(),
      }),
      false
    );
    // Recall question must be skipped without enqueuing
    assert.equal(
      queue.enqueue({
        userText: "What is my favourite colour?",
        assistantText: "Blue!",
        turnCompletedAtMs: Date.now(),
      }),
      false
    );

    await new Promise((r) => setTimeout(r, 60));
    assert.equal(calls, 1);
    assert.deepEqual(processed, ["Preference item 1"]);
    queue.dispose();
  });

  await test("ConversationFlowController idle-gates memoryContext updates and Level 2 spoken prompts so audio playback is never interrupted mid-turn", () => {
    const captured: Array<{ userText: string; assistantText: string }> = [];
    let contextSyncCalls = 0;
    let idlePromptCallbacks = 0;

    const flow = new ConversationFlowController({
      onSendGreeting: () => {},
      onSendSilenceReengagement: () => {},
      onLiveContextSync: () => {
        contextSyncCalls += 1;
      },
      onIdleForMemoryPrompt: () => {
        idlePromptCallbacks += 1;
      },
      onCompletedTurnForMemory: (turn) => {
        captured.push({
          userText: turn.userText,
          assistantText: turn.assistantText,
        });
      },
    });

    flow.onSessionReady();
    // Initial sync count after ready
    const initialSyncCount = contextSyncCalls;

    // Simulate active playback/generation: context update & idle prompt MUST defer
    flow.onClientState({ playbackActive: true, userSpeaking: false });
    assert.equal(flow.isIdleForBackgroundPrompt(), false);

    flow.setRetrievedMemoriesBlock("STAGE 7 TEST BLOCK");
    assert.equal(contextSyncCalls, initialSyncCount);

    // Simulate normal turn completion while client audio playback is still draining
    flow.onInputTranscription("I prefer concise explanations in simple English.");
    flow.onModelAudioChunk();
    flow.onOutputTranscription("Got it, I will keep my explanations simple and concise.");
    flow.onTurnComplete();

    assert.equal(captured.length, 1);
    assert.ok(captured[0].userText.includes("simple English"));
    assert.equal(contextSyncCalls, initialSyncCount);

    // Once client finishes playing audio, deferred context sync & idle prompt fire cleanly
    flow.onClientState({ playbackActive: false, userSpeaking: false });
    assert.equal(flow.isIdleForBackgroundPrompt(), true);
    assert.equal(contextSyncCalls, initialSyncCount + 1);
    assert.ok(idlePromptCallbacks >= 1);
    flow.dispose();
  });

  await test("Firestore failure classifier handles offline, auth expiration, permission denial, and quota errors accurately", () => {
    const offline = classifyFirestoreFailure(
      new Error("Failed to get document because the client is offline."),
      false
    );
    assert.equal(offline.kind, "transient_offline");
    assert.equal(offline.retryable, true);

    const expired = classifyFirestoreFailure(
      Object.assign(new Error("User token expired"), {
        code: "auth/user-token-expired",
      }),
      true
    );
    assert.equal(expired.kind, "auth_expired");
    assert.equal(expired.retryable, false);

    const denied = classifyFirestoreFailure(
      Object.assign(new Error("Missing or insufficient permissions."), {
        code: "permission-denied",
      }),
      true
    );
    assert.equal(denied.kind, "permission_denied");
    assert.equal(denied.retryable, false);

    const quota = classifyFirestoreFailure(
      Object.assign(new Error("Quota exceeded"), {
        code: "resource-exhausted",
      }),
      true
    );
    assert.equal(quota.kind, "quota_exceeded");
    assert.equal(quota.retryable, false);
  });

  await test("Live declarations, orchestration follow-up guidance, and unified system instruction preserve existing features and add Memory Core", () => {
    const names = MEMORY_FUNCTION_DECLARATIONS.map((d) => d.name);
    assert.deepEqual(names, [
      "save_memory",
      "update_memory",
      "search_memories",
      "resolve_pending_memory_approval",
    ]);

    const base = buildYunerthOrchestrationInstruction("Asia/Kolkata");
    assert.ok(base.includes("Stage 7 Yunerth Memory Core"));
    assert.ok(base.includes("Wait for Storage Confirmation"));
    assert.ok(base.includes("Natural Recall, Follow-Up Continuity"));
    assert.ok(base.includes("brief, relevant follow-up thought or question"));

    const unified = buildUnifiedLiveSystemInstruction({
      baseInstruction: base,
      expression: createDefaultExpressionState(),
      voiceMode: "slow",
      retrievedMemoriesBlock: buildRetrievedMemoriesBlock([
        makeMemory("m1", "Favorite game is GTA 6", "Preferences"),
      ]),
    });

    assert.ok(unified.includes("Slow Mode (~0.90x)"));
    assert.ok(unified.includes("STAGE 5.2 ACTIVE VOCAL DELIVERY POSTURE"));
    assert.ok(unified.includes("Favorite game is GTA 6"));
    assert.equal(
      coerceMemoryCategory("UnknownCategory", "Favorite game is GTA 6"),
      "Preferences"
    );
    assert.equal(
      normalizeMemoryDescription("  hello   world  "),
      "hello world"
    );
  });

  console.log(`\nAll ${passed} Stage 7 / Phase 7.1 Memory Core tests passed.`);
}

run().catch((err) => {
  console.error("Test failure:", err);
  process.exit(1);
});
