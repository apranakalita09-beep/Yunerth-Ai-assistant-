import assert from "node:assert/strict";
import { ConversationFlowController } from "./conversationFlow.ts";
import {
  EXPRESSION_CATEGORIES,
  EXPRESSION_INTENSITIES,
  EmotionUnderstandingEngine,
} from "./emotionUnderstanding.ts";
import {
  buildSilenceContinuationPrompt,
  buildYunerthOrchestrationInstruction,
} from "./orchestration.ts";
import {
  buildActiveVocalDeliveryBlock,
  buildSystemInstructionWithVoiceExpression,
  getVocalDeliveryKey,
  getVocalDeliveryProfile,
} from "./voiceExpression.ts";

// 1. All 6 emotional categories + Neutral across all 3 intensities
for (const category of EXPRESSION_CATEGORIES) {
  for (const intensity of EXPRESSION_INTENSITIES) {
    const profile = getVocalDeliveryProfile(category, intensity);
    assert.equal(profile.category, category);
    assert.equal(profile.intensity, intensity);
    assert.ok(profile.styleLabel.length > 0);
    assert.ok(profile.tone.length > 10);
    assert.ok(profile.pacing.length > 10);
    assert.ok(profile.emphasis.length > 10);
    assert.ok(profile.guardrail.length > 10);

    const block = buildActiveVocalDeliveryBlock({
      category,
      intensity,
      reason: "test_matrix",
    });
    assert.ok(
      block.includes('"Aoede"'),
      `Voice identity "Aoede" must be locked for ${category}:${intensity}`
    );
    assert.ok(
      block.includes(profile.styleLabel),
      `Delivery block must name ${profile.styleLabel}`
    );
  }
}

// 2. Confirm user preferences: slower/measured serious & empathetic pacing, balanced strong shifts
for (const intensity of EXPRESSION_INTENSITIES) {
  const emp = getVocalDeliveryProfile("empathetic_supportive", intensity);
  const calm = getVocalDeliveryProfile("calm_serious", intensity);
  assert.match(emp.pacing, /slower|unhurried|measured/i);
  assert.match(calm.pacing, /slower|unhurried|measured/i);
}
const strongHappy = getVocalDeliveryProfile("happy_excited", "strong");
const subtleHappy = getVocalDeliveryProfile("happy_excited", "subtle");
assert.notEqual(strongHappy.tone, subtleHappy.tone);
assert.match(strongHappy.guardrail, /balanced|never shout/i);

const strongSurprised = getVocalDeliveryProfile("surprised_amazed", "strong");
assert.match(strongSurprised.guardrail, /balanced|avoid sounding repetitively shocked/i);

// 3. Base systemInstruction includes Aoede & Stage 5.2 delivery matrix
const baseInstruction = buildYunerthOrchestrationInstruction("Asia/Kolkata");
assert.ok(baseInstruction.includes("Stage 5.2 Emotional Voice Expression"));
assert.ok(baseInstruction.includes('"Aoede"'));

const updatedInstruction = buildSystemInstructionWithVoiceExpression(
  baseInstruction,
  {
    category: "calm_serious",
    intensity: "moderate",
    reason: "serious_discussion",
  }
);
assert.ok(updatedInstruction.startsWith(baseInstruction));
assert.ok(updatedInstruction.includes("Calm / Serious (Moderate)"));

// 4. Scenario tests via EmotionUnderstandingEngine -> Vocal Delivery mapping
// Scenario A: Excitement -> Seriousness
{
  const engine = new EmotionUnderstandingEngine(1000);
  const s1 = engine.processUserUtterance("I just got promoted to lead engineer today!", 2000);
  assert.equal(s1.category, "happy_excited");
  assert.equal(s1.intensity, "strong");
  assert.equal(getVocalDeliveryKey(s1), "happy_excited:strong");

  const s2 = engine.processUserUtterance(
    "Wait, let's be serious for a second—I got a concerning medical result too.",
    3000
  );
  assert.ok(s2.category === "calm_serious" || s2.category === "empathetic_supportive");
  const profile2 = getVocalDeliveryProfile(s2.category, s2.intensity);
  assert.match(profile2.pacing, /slower|unhurried|measured/i);
}

// Scenario B: Empathy -> Ordinary conversation fading smoothly toward Neutral
{
  const engine = new EmotionUnderstandingEngine(1000);
  const e1 = engine.processUserUtterance("I am feeling really overwhelmed and exhausted.", 2000);
  assert.equal(e1.category, "empathetic_supportive");
  const e2 = engine.processUserUtterance("Anyway, I finished sorting my desk.", 3000);
  assert.notEqual(getVocalDeliveryProfile(e2.category, e2.intensity).intensity, "strong");
  const e3 = engine.processUserUtterance("What time is it in Tokyo?", 4000);
  assert.equal(e3.category, "neutral");
  assert.equal(getVocalDeliveryKey(e3), "neutral:subtle");
}

// Scenario C: Subtle vs. Strong intensity vocal differentiation
{
  const engine1 = new EmotionUnderstandingEngine(1000);
  const smallWin = engine1.processUserUtterance("Things are going well and I enjoyed my walk.", 2000);
  const engine2 = new EmotionUnderstandingEngine(1000);
  const bigWin = engine2.processUserUtterance("Best news ever! I got the job offer!!", 2000);
  assert.equal(smallWin.category, "happy_excited");
  assert.equal(bigWin.category, "happy_excited");
  assert.notEqual(smallWin.intensity, bigWin.intensity);
  assert.notEqual(getVocalDeliveryKey(smallWin), getVocalDeliveryKey(bigWin));
}

// Scenario D: Long conversation delta-only update efficiency + mute/unmute/interruption stability
{
  const deliveredKeys: string[] = [];
  let silenceExpressionCategory = "";

  const flow = new ConversationFlowController({
    silenceDelayMs: 60,
    greetingDelayMs: 5,
    onSendGreeting: () => {
      flow.onModelAudioChunk();
      flow.onTurnComplete();
    },
    onSendSilenceReengagement: (ctx) => {
      silenceExpressionCategory = ctx.expression.category;
      const prompt = buildSilenceContinuationPrompt(ctx);
      assert.ok(prompt.includes(getVocalDeliveryProfile(ctx.expression.category, ctx.expression.intensity).styleLabel));
    },
    onExpressionChange: (expr) => {
      const nextKey = getVocalDeliveryKey(expr);
      if (deliveredKeys[deliveredKeys.length - 1] !== nextKey) {
        deliveredKeys.push(nextKey);
      }
    },
  });

  flow.onSessionReady();

  // Turn 1: Curious
  flow.onClientState({ playbackActive: false, userSpeaking: true, muted: false });
  flow.onInputTranscription("I'm curious about how quantum sensors work.");
  flow.onClientState({ playbackActive: false, userSpeaking: false, muted: false });
  flow.onModelAudioChunk();
  flow.onTurnComplete();

  // Turn 2: Playful joke, interrupted mid-speech by user
  flow.onClientState({ playbackActive: true, userSpeaking: false, muted: false });
  flow.onModelAudioChunk();
  flow.onInterrupted();
  flow.onClientState({ playbackActive: false, userSpeaking: true, muted: false });
  flow.onInputTranscription("Haha just kidding, my cat just stepped on the router!");
  flow.onClientState({ playbackActive: false, userSpeaking: false, muted: false });
  flow.onModelAudioChunk();
  flow.onTurnComplete();

  // Mute and unmute cycle keeps active expression state intact
  flow.onClientState({ muted: true });
  assert.equal(flow.getExpression().category, "playful_humorous");
  flow.onClientState({ muted: false });
  assert.equal(flow.getExpression().category, "playful_humorous");

  // Turn 3: Switch sharply to serious -> triggers calm_serious/empathetic and silence prompt carries it
  flow.onInputTranscription("Hold on, let's talk seriously about an urgent safety concern.");
  flow.onModelAudioChunk();
  flow.onTurnComplete();

  assert.equal(deliveredKeys[0], "neutral:subtle");
  assert.ok(deliveredKeys.includes("curious_interested:moderate") || deliveredKeys.some((k) => k.startsWith("curious_interested:")));
  assert.ok(deliveredKeys.some((k) => k.startsWith("playful_humorous:")));
  assert.ok(deliveredKeys.some((k) => k.startsWith("calm_serious:")));

  await new Promise((r) => setTimeout(r, 120));
  assert.equal(silenceExpressionCategory, "calm_serious");
  flow.dispose();
}

console.log("STAGE_5_2_VOICE_EXPRESSION_TESTS: PASSED");
