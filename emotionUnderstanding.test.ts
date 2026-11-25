import assert from "node:assert/strict";
import { EmotionUnderstandingEngine } from "./emotionUnderstanding.ts";
import { ConversationFlowController } from "./conversationFlow.ts";
import { StateManager } from "./src/voice/StateManager.ts";
import type { ExpressionState } from "./src/voice/types.ts";

function runStage51Tests(): void {
  // 1. Excitement after good news (small win vs major achievement)
  {
    const minorEngine = new EmotionUnderstandingEngine();
    const minor = minorEngine.processUserUtterance(
      "I finally finished my morning run today."
    );
    assert.equal(minor.category, "happy_excited");
    assert.ok(
      minor.intensity === "subtle" || minor.intensity === "moderate",
      `Expected subtle/moderate for minor win, got ${minor.intensity}`
    );

    const majorEngine = new EmotionUnderstandingEngine();
    const major = majorEngine.processUserUtterance(
      "I just got promoted and landed my dream role!!"
    );
    assert.equal(major.category, "happy_excited");
    assert.equal(major.intensity, "strong");
  }

  // 2. Curiosity during an interesting discussion
  {
    const engine = new EmotionUnderstandingEngine();
    const res = engine.processUserUtterance(
      "That's fascinating—I've always wondered how airplanes fly so high in thin air."
    );
    assert.equal(res.category, "curious_interested");
    assert.ok(res.intensity === "moderate" || res.intensity === "strong");
  }

  // 3. Empathy during a difficult situation
  {
    const mildEngine = new EmotionUnderstandingEngine();
    const mild = mildEngine.processUserUtterance(
      "I'm really stressed and exhausted after a rough week."
    );
    assert.equal(mild.category, "empathetic_supportive");
    assert.ok(mild.intensity === "moderate" || mild.intensity === "strong");

    const severeEngine = new EmotionUnderstandingEngine();
    const severe = severeEngine.processUserUtterance(
      "My dog passed away last night and I'm heartbroken."
    );
    assert.equal(severe.category, "empathetic_supportive");
    assert.equal(severe.intensity, "strong");
  }

  // 4. Playfulness during a joke
  {
    const engine = new EmotionUnderstandingEngine();
    const res = engine.processUserUtterance(
      "Haha just kidding, knock knock—ready for a silly pun?"
    );
    assert.equal(res.category, "playful_humorous");
    assert.ok(res.intensity === "moderate" || res.intensity === "strong");
  }

  // 5. Surprise after unexpected information
  {
    const engine = new EmotionUnderstandingEngine();
    const res = engine.processUserUtterance(
      "No way! Seriously?! I can't believe that actually happened!"
    );
    assert.equal(res.category, "surprised_amazed");
    assert.equal(res.intensity, "strong");
  }

  // 6. Calmness during a serious discussion
  {
    const engine = new EmotionUnderstandingEngine();
    const res = engine.processUserUtterance(
      "We need to talk seriously about an important financial decision and the medical results."
    );
    assert.equal(res.category, "calm_serious");
    assert.ok(res.intensity === "moderate" || res.intensity === "strong");
  }

  // 7. Neutral expression during an ordinary question
  {
    const engine = new EmotionUnderstandingEngine();
    const clockQ = engine.processUserUtterance("What time is it in London?");
    assert.equal(clockQ.category, "neutral");
    assert.equal(clockQ.intensity, "subtle");

    const plainQ = engine.processUserUtterance(
      "Can you list three continents in alphabetical order?"
    );
    assert.equal(plainQ.category, "neutral");
    assert.equal(plainQ.intensity, "subtle");
  }

  // 8. Sudden change from playful to serious
  {
    const engine = new EmotionUnderstandingEngine();
    const playful = engine.processUserUtterance(
      "Haha I'm teasing you, that story was hilarious!"
    );
    assert.equal(playful.category, "playful_humorous");

    const serious = engine.processUserUtterance(
      "Actually let's be serious for a moment—there is a family emergency and I need calm advice."
    );
    assert.ok(
      serious.category === "calm_serious" ||
        serious.category === "empathetic_supportive",
      `Expected calm_serious or empathetic_supportive on sudden shift, got ${serious.category}`
    );
    assert.equal(serious.sourceTurn, "transition");
  }

  // 9. Ambiguous or mixed-signal message where neutral is appropriate
  {
    const engine = new EmotionUnderstandingEngine();
    const vague = engine.processUserUtterance("I don't know, maybe we'll see.");
    assert.equal(vague.category, "neutral");

    const mixed = engine.processUserUtterance(
      "I have mixed feelings—part of me is glad and part of me is stressed."
    );
    assert.equal(mixed.category, "neutral");
  }

  // 10. Longer conversation where expression adapts naturally & fades smoothly back to Neutral
  {
    const engine = new EmotionUnderstandingEngine();

    const t1 = engine.processUserUtterance("What time is it in Tokyo?");
    assert.equal(t1.category, "neutral");

    const t2 = engine.processUserUtterance(
      "I'm really curious about how deep-sea submarines survive ocean pressure."
    );
    assert.equal(t2.category, "curious_interested");

    const t3 = engine.processUserUtterance("How do the hulls avoid cracking?");
    assert.equal(t3.category, "curious_interested");

    const t4 = engine.processUserUtterance(
      "Haha I'd probably pack floaties just in case, lol."
    );
    assert.equal(t4.category, "playful_humorous");

    const t5 = engine.processUserUtterance(
      "Wait—amazing news! I just graduated with honors and got the scholarship!"
    );
    assert.equal(t5.category, "happy_excited");
    assert.equal(t5.intensity, "strong");

    // Ordinary turns afterward smoothly step down strong -> moderate -> subtle -> neutral
    const t6 = engine.processUserUtterance("Anyway, back to my notes for tomorrow.");
    assert.equal(t6.category, "happy_excited");
    assert.equal(t6.intensity, "moderate");

    const t7 = engine.processUserUtterance("I have a few things on my calendar.");
    assert.equal(t7.category, "happy_excited");
    assert.equal(t7.intensity, "subtle");

    const t8 = engine.processUserUtterance("Let's check Wednesday first.");
    assert.equal(t8.category, "neutral");
  }

  // 11. Integration check: ConversationFlowController -> StateManager plumbing
  {
    const sm = new StateManager();
    assert.equal(sm.getSnapshot().expression.category, "neutral");

    const emitted: ExpressionState[] = [];
    const flow = new ConversationFlowController({
      greetingDelayMs: 5000,
      silenceDelayMs: 5000,
      onSendGreeting: () => {},
      onSendSilenceReengagement: () => {},
      onExpressionChange: (expr) => {
        emitted.push(expr);
        sm.setExpression(expr);
      },
    });

    flow.onSessionReady();
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].category, "neutral");

    flow.onInputTranscription("I just passed my final exam!!");
    flow.onModelAudioChunk();
    flow.onTurnComplete();

    assert.equal(sm.getSnapshot().expression.category, "happy_excited");
    assert.equal(sm.getSnapshot().expression.intensity, "strong");

    flow.dispose();
    sm.resetDisconnected();
    assert.equal(sm.getSnapshot().expression.category, "neutral");
  }

  console.log("STAGE_5_1_ALL_10_SCENARIOS: PASSED");
}

runStage51Tests();
