import assert from "node:assert/strict";
import { ConversationFlowController } from "./conversationFlow.ts";
import { EmotionUnderstandingEngine } from "./emotionUnderstanding.ts";
import { buildYunerthOrchestrationInstruction } from "./orchestration.ts";
import type { ExpressionState } from "./src/voice/types.ts";
import {
  buildActiveVocalDeliveryBlock,
  getVocalDeliveryKey,
} from "./voiceExpression.ts";

// 1. Playful to serious transition
{
  const engine = new EmotionUnderstandingEngine(1000);
  const playful = engine.processUserUtterance(
    "Haha just kidding, that joke totally cracked me up!",
    2000
  );
  assert.equal(playful.category, "playful_humorous");

  const serious = engine.processUserUtterance(
    "Wait, let's be serious for a moment—we have a critical safety concern.",
    3000
  );
  assert.equal(serious.category, "calm_serious");
  assert.equal(serious.transition?.previousCategory, "playful_humorous");
  assert.equal(serious.transition?.kind, "soften");
  assert.match(serious.transition?.bridgeCue ?? "", /soften|calm/i);
}

// 2. Serious to supportive transition
{
  const engine = new EmotionUnderstandingEngine(1000);
  const serious = engine.processUserUtterance(
    "We need an honest talk about an important career crossroads.",
    2000
  );
  assert.equal(serious.category, "calm_serious");

  const supportive = engine.processUserUtterance(
    "Honestly I'm overwhelmed and exhausted from dealing with all of this.",
    3000
  );
  assert.equal(supportive.category, "empathetic_supportive");
  assert.equal(supportive.transition?.previousCategory, "calm_serious");
  assert.equal(supportive.transition?.kind, "pivot");
  assert.match(supportive.transition?.bridgeCue ?? "", /support|warm|calm/i);
}

// 3. Calm to excited transition (gradual lift, never jumping straight to strong)
{
  const engine = new EmotionUnderstandingEngine(1000);
  const calm = engine.processUserUtterance(
    "Let's talk seriously about this important life decision.",
    2000
  );
  assert.equal(calm.category, "calm_serious");

  const lift1 = engine.processUserUtterance(
    "Actually great news, I got the job offer and passed my review!!",
    3000
  );
  assert.equal(lift1.category, "happy_excited");
  assert.ok(
    lift1.intensity === "subtle" || lift1.intensity === "moderate",
    `Calm -> excited should lift gradually via subtle/moderate first, got ${lift1.intensity}`
  );
  assert.equal(lift1.transition?.kind, "lift");

  // Sustained celebration then steps cleanly up to strong
  const lift2 = engine.processUserUtterance(
    "It really is the best news ever, I'm so excited to celebrate!!",
    4000
  );
  assert.equal(lift2.category, "happy_excited");
  assert.equal(lift2.intensity, "strong");
}

// 4. Excited to neutral transition (smooth step-down fade)
{
  const engine = new EmotionUnderstandingEngine(1000);
  const excited = engine.processUserUtterance(
    "Best news ever! I got promoted today!!",
    2000
  );
  assert.equal(excited.category, "happy_excited");
  assert.equal(excited.intensity, "strong");

  const s1 = engine.processUserUtterance("I organized my calendar for Monday.", 3000);
  assert.equal(s1.category, "happy_excited");
  assert.equal(s1.intensity, "moderate");
  assert.equal(s1.transition?.kind, "ease_to_neutral");

  const s2 = engine.processUserUtterance("I will grab coffee before the meeting.", 4000);
  assert.equal(s2.category, "happy_excited");
  assert.equal(s2.intensity, "subtle");

  const s3 = engine.processUserUtterance("Then I have two errands downtown.", 5000);
  assert.equal(s3.category, "neutral");
  assert.equal(s3.transition?.kind, "ease_to_neutral");
}

// 5. Curious to happy transition
{
  const engine = new EmotionUnderstandingEngine(1000);
  const curious = engine.processUserUtterance(
    "I'm really curious about how acoustic guitars resonate so richly.",
    2000
  );
  assert.equal(curious.category, "curious_interested");

  const happy = engine.processUserUtterance(
    "Awesome! I finally managed to play the whole chord progression cleanly!",
    3000
  );
  assert.equal(happy.category, "happy_excited");
  assert.equal(happy.transition?.previousCategory, "curious_interested");
  assert.equal(happy.transition?.kind, "lift");
}

// 6. Strong emotion gradually becoming subtle
{
  const engine = new EmotionUnderstandingEngine(1000);
  const deep = engine.processUserUtterance(
    "My close friend passed away and I'm heartbroken.",
    2000
  );
  assert.equal(deep.category, "empathetic_supportive");
  assert.equal(deep.intensity, "strong");

  const mod = engine.processUserUtterance("I made myself some tea tonight.", 3000);
  assert.equal(mod.category, "empathetic_supportive");
  assert.equal(mod.intensity, "moderate");

  const sub = engine.processUserUtterance("The house is quiet right now.", 4000);
  assert.equal(sub.category, "empathetic_supportive");
  assert.equal(sub.intensity, "subtle");
}

// 7. Maintaining the same emotion when context has not changed
{
  const engine = new EmotionUnderstandingEngine(1000);
  const c1 = engine.processUserUtterance(
    "That's fascinating—how does magnetic levitation keep trains stable?",
    2000
  );
  assert.equal(c1.category, "curious_interested");

  const c2 = engine.processUserUtterance("Why doesn't wind knock them off track?", 3000);
  assert.equal(c2.category, "curious_interested");
  assert.equal(c2.transition?.previousCategory, "curious_interested");
  assert.equal(c2.transition?.kind, "steady");
}

// 8. Avoiding unnecessary emotional switching on mild stray cues
{
  const engine = new EmotionUnderstandingEngine(1000);
  const serious = engine.processUserUtterance(
    "We need to talk seriously about an important financial issue.",
    2000
  );
  assert.equal(serious.category, "calm_serious");

  // Mild positive phrase ("nice" / "pretty good", weight 0.9 < 1.55 threshold) should NOT flip away from calm_serious
  const held = engine.processUserUtterance(
    "At least the weather outside looks nice today.",
    3000
  );
  assert.equal(held.category, "calm_serious");
  assert.equal(held.transition?.kind, "steady");
}

// 9. Natural voice delivery during transitions & playback-aware gating
{
  const vocalUpdates: ExpressionState[] = [];
  const expressionEvents: ExpressionState[] = [];

  const flow = new ConversationFlowController({
    silenceDelayMs: 5000,
    greetingDelayMs: 5000,
    onSendGreeting: () => {},
    onSendSilenceReengagement: () => {},
    onExpressionChange: (expr) => expressionEvents.push(expr),
    onVocalDeliveryUpdate: (expr) => vocalUpdates.push(expr),
  });

  flow.onSessionReady();

  // Model starts audio turn AND client playback is active while user's finalized happy turn completes
  flow.onClientState({ playbackActive: true, userSpeaking: false, muted: false });
  flow.onInputTranscription("I just got promoted and landed the job!!");
  flow.onModelAudioChunk();
  flow.onTurnComplete();

  // Client expression updates immediately, while Live vocal delivery update waits safely for playback end
  assert.equal(expressionEvents[expressionEvents.length - 1]?.category, "happy_excited");
  assert.equal(vocalUpdates.length, 0);
  assert.equal(flow.getDebugSnapshot().hasPendingVocalDelivery, true);

  // Playback finishes -> pending vocal update flushes cleanly with Aoede lock & Stage 5.3 transition bridge
  flow.onClientState({ playbackActive: false, userSpeaking: false, muted: false });
  assert.equal(vocalUpdates.length, 1);
  assert.equal(flow.getDebugSnapshot().hasPendingVocalDelivery, false);

  const deliveryBlock = buildActiveVocalDeliveryBlock(vocalUpdates[0]);
  assert.ok(deliveryBlock.includes('"Aoede"'));
  assert.ok(deliveryBlock.includes("Stage 5.3 Transition Bridge"));

  // Next shift happens during playback, then user interrupts mid-speech -> flushes immediately on interrupt!
  flow.onClientState({ playbackActive: true, userSpeaking: false, muted: false });
  flow.onInputTranscription("Wait, let's be serious—there is a medical emergency.");
  flow.onModelAudioChunk();
  flow.onTurnComplete();
  assert.equal(vocalUpdates.length, 1);

  flow.onInterrupted();
  assert.equal(vocalUpdates.length, 2);
  assert.equal(getVocalDeliveryKey(vocalUpdates[1]), "calm_serious:moderate");

  flow.dispose();
}

// 10. Returning to normal conversation cleanly without unnatural pauses
{
  const instruction = buildYunerthOrchestrationInstruction("Asia/Kolkata");
  assert.ok(instruction.includes("Stage 5.3 Natural Emotional Transitions"));
  assert.match(instruction, /without abrupt vocal jerks|without.*theatrical pauses/i);

  let silenceCalled = false;
  const flow = new ConversationFlowController({
    silenceDelayMs: 40,
    greetingDelayMs: 5,
    onSendGreeting: () => {
      flow.onModelAudioChunk();
      flow.onTurnComplete();
    },
    onSendSilenceReengagement: () => {
      silenceCalled = true;
    },
  });

  flow.onSessionReady();
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(silenceCalled, true);
  flow.dispose();
}

console.log("STAGE_5_3_TRANSITION_TESTS: PASSED");
