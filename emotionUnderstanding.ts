import {
  createDefaultExpressionState,
  type ExpressionCategory,
  type ExpressionIntensity,
  type ExpressionState,
  type ExpressionTransition,
  type ExpressionTransitionKind,
} from "./src/voice/types.ts";

export const EXPRESSION_CATEGORIES: readonly ExpressionCategory[] = [
  "happy_excited",
  "curious_interested",
  "empathetic_supportive",
  "playful_humorous",
  "surprised_amazed",
  "calm_serious",
  "neutral",
] as const;

export const EXPRESSION_INTENSITIES: readonly ExpressionIntensity[] = [
  "subtle",
  "moderate",
  "strong",
] as const;

interface CueRule {
  pattern: RegExp;
  weight: number;
  reason: string;
}

type ScoreMap = Record<Exclude<ExpressionCategory, "neutral">, number>;

const MAJOR_ACHIEVEMENT_BOOST =
  /\b(promoted|promotion|got the job|landed the job|job offer|passed my|graduated|scholarship|won first|won the|engaged|getting married|having a baby|dream come true|accepted into|admitted to|published|launched my|biggest win|best news ever|life changing)\b/i;

const EXTREME_DISTRESS_BOOST =
  /\b(passed away|died|death of|funeral|grieving|heartbroken|devastated|laid off|fired today|hospitalized|diagnosed|panic attack|breaking down|can't cope|cannot cope|hopeless|terrified)\b/i;

const AMBIGUOUS_UNCERTAIN_PATTERNS: RegExp[] = [
  /^(?:i don'?t know|idk|not sure|maybe|perhaps|hard to say|we'?ll see|either way|depends|it varies|kind of|sort of|i guess|whatever|who knows|not really sure|i have mixed feelings)[.!?,\s]*$/i,
  /\b(mixed feelings|both good and bad|part of me .* part of me|on one hand .* on the other|good news and bad news|happy and stressed|excited but terrified|not sure how i feel|don'?t know how to feel|could go either way)\b/i,
];

const CUE_RULES: Record<Exclude<ExpressionCategory, "neutral">, CueRule[]> = {
  happy_excited: [
    { pattern: MAJOR_ACHIEVEMENT_BOOST, weight: 3.6, reason: "major_achievement" },
    {
      pattern: /\b(awesome|amazing news|fantastic|thrilled|ecstatic|overjoyed|so happy|so excited|celebrate|celebrating|woohoo|yay|nailed it|crushed it)\b/i,
      weight: 2.3,
      reason: "strong_excitement",
    },
    {
      pattern: /\b(good news|great news|happy to share|proud of|accomplished|achieved|finished my|completed my|managed to|worked out well|glad that|really happy|feel great|feels great|love it)\b/i,
      weight: 1.5,
      reason: "positive_achievement",
    },
    {
      pattern: /\b(nice|pretty good|going well|enjoyed|looking forward|excited about|exciting)\b/i,
      weight: 0.9,
      reason: "mild_positivity",
    },
  ],
  curious_interested: [
    {
      pattern: /\b(fascinating|intriguing|curious about|always wondered|tell me more|how does that work|why do|why does|how come|what makes|deep dive|explore that|interested in learning|want to learn|would love to know)\b/i,
      weight: 2.0,
      reason: "active_curiosity",
    },
    {
      pattern: /\b(interesting|wonder what|wonder why|wonder how|makes me think|think about that|what if|how do people)\b/i,
      weight: 1.25,
      reason: "exploratory_interest",
    },
  ],
  empathetic_supportive: [
    { pattern: EXTREME_DISTRESS_BOOST, weight: 3.8, reason: "deep_distress_or_loss" },
    {
      pattern: /\b(struggling|overwhelmed|exhausted|burned out|burnt out|really stressed|so stressed|anxious|worried sick|lonely|depressed|miserable|hurting|failed|rejected|terrible day|awful day|rough week|hard time|tough time|going through a lot)\b/i,
      weight: 2.3,
      reason: "emotional_difficulty",
    },
    {
      pattern: /\b(stressed|tired|down today|sad|upset|frustrated|disappointed|nervous|worried|didn'?t go well|feeling off|tough day|hard day)\b/i,
      weight: 1.45,
      reason: "mild_strain",
    },
  ],
  playful_humorous: [
    {
      pattern: /\b(haha+|hehe+|lol|lmao|rofl|joke|joking|kidding|just kidding|pun|teasing|funny story|hilarious|crack me up|knock knock|plot twist haha)\b/i,
      weight: 2.3,
      reason: "humor_or_banter",
    },
    {
      pattern: /\b(silly|goofy|quirky|ironic|ridiculous|comic|laughing|made me laugh|bet you can'?t)\b/i,
      weight: 1.35,
      reason: "lighthearted_tone",
    },
  ],
  surprised_amazed: [
    {
      pattern: /\b(no way|are you kidding|you'?re kidding|seriously\?!|wait what|wait, what|cannot believe|can'?t believe|unbelievable|mind blown|blown away|jaw dropped|astonishing|shocked|shocking|never knew that|whoa|oh wow|wow!)\b/i,
      weight: 2.4,
      reason: "unexpected_surprise",
    },
    {
      pattern: /\b(unexpected|out of nowhere|didn'?t expect|surprisingly|wild fact|crazy fact|incredible|astonished)\b/i,
      weight: 1.45,
      reason: "amazement_cue",
    },
  ],
  calm_serious: [
    {
      pattern: /\b(serious talk|talk seriously|be serious|seriously worried|important decision|critical issue|life decision|medical results|health scare|financial trouble|debt|emergency|safety concern|legal issue|ethics|moral dilemma|grief|grave)\b/i,
      weight: 2.6,
      reason: "serious_discussion",
    },
    {
      pattern: /\b(honestly i'?m worried|let'?s slow down|need honest advice|tough decision|major risk|consequences|career crossroads|family issue|relationship problem)\b/i,
      weight: 1.7,
      reason: "thoughtful_serious_tone",
    },
  ],
};

const ORDINARY_UTILITY_QUERY =
  /^(?:what(?:'s| is) the time|what time is it|what day is it|what(?:'s| is) today'?s date|time difference between|search (?:the web )?for|look up|can you check|tell me the weather|define |spell |calculate |convert |\d+\s*[\+\-\*\/]\s*\d+)/i;

interface TurnMemoryEntry {
  text: string;
  category: ExpressionCategory;
  intensity: ExpressionIntensity;
}

function emptyScores(): ScoreMap {
  return {
    happy_excited: 0,
    curious_interested: 0,
    empathetic_supportive: 0,
    playful_humorous: 0,
    surprised_amazed: 0,
    calm_serious: 0,
  };
}

function stepDownIntensity(intensity: ExpressionIntensity): ExpressionIntensity | null {
  if (intensity === "strong") return "moderate";
  if (intensity === "moderate") return "subtle";
  return null;
}

const INTENSITY_RANK: Record<ExpressionIntensity, number> = {
  subtle: 0,
  moderate: 1,
  strong: 2,
};

const RANK_TO_INTENSITY: readonly ExpressionIntensity[] = [
  "subtle",
  "moderate",
  "strong",
];

function isSeriousOrSupportive(category: ExpressionCategory): boolean {
  return category === "calm_serious" || category === "empathetic_supportive";
}

function isUpbeatCategory(category: ExpressionCategory): boolean {
  return (
    category === "happy_excited" ||
    category === "playful_humorous" ||
    category === "surprised_amazed"
  );
}

function buildTransitionDescriptor(
  prev: ExpressionState,
  nextCategory: ExpressionCategory,
  nextIntensity: ExpressionIntensity
): ExpressionTransition {
  const prevCat = prev.category;
  const prevInt = prev.intensity;

  if (prevCat === nextCategory) {
    if (prevInt === nextIntensity) {
      return {
        previousCategory: prevCat,
        previousIntensity: prevInt,
        kind: "steady",
        bridgeCue:
          "Maintain your current emotional posture steadily without forcing unnecessary shifts.",
      };
    }
    if (INTENSITY_RANK[nextIntensity] > INTENSITY_RANK[prevInt]) {
      return {
        previousCategory: prevCat,
        previousIntensity: prevInt,
        kind: "lift",
        bridgeCue: `Build energy smoothly one step from ${prevInt} toward ${nextIntensity} without jarring spikes.`,
      };
    }
    return {
      previousCategory: prevCat,
      previousIntensity: prevInt,
      kind: "ease_to_neutral",
      bridgeCue: `Let ${nextCategory.replace("_", " ")} intensity soften smoothly from ${prevInt} to ${nextIntensity}.`,
    };
  }

  if (nextCategory === "neutral") {
    return {
      previousCategory: prevCat,
      previousIntensity: prevInt,
      kind: "ease_to_neutral",
      bridgeCue: `Settle smoothly out of ${prevCat.replace("_", " ")} back into a calm, relaxed neutral cadence.`,
    };
  }

  if (isSeriousOrSupportive(nextCategory)) {
    const kind: ExpressionTransitionKind =
      prevCat === "calm_serious" && nextCategory === "empathetic_supportive"
        ? "pivot"
        : "soften";
    return {
      previousCategory: prevCat,
      previousIntensity: prevInt,
      kind,
      bridgeCue:
        prevCat === "calm_serious" && nextCategory === "empathetic_supportive"
          ? "Warm steady seriousness gently into calm, reassuring support."
          : isUpbeatCategory(prevCat)
            ? "Soften smoothly out of upbeat banter into grounded, respectful calm without abrupt cutoff."
            : "Shift gently into a calm, supportive, measured delivery.",
    };
  }

  if (isSeriousOrSupportive(prevCat) && isUpbeatCategory(nextCategory)) {
    return {
      previousCategory: prevCat,
      previousIntensity: prevInt,
      kind: "lift",
      bridgeCue:
        "Ease gently upward from calm composure into warm positivity rather than snapping straight into high energy.",
    };
  }

  if (prevCat === "curious_interested" && isUpbeatCategory(nextCategory)) {
    return {
      previousCategory: prevCat,
      previousIntensity: prevInt,
      kind: "lift",
      bridgeCue:
        "Carry engaged curiosity naturally into bright, warm enthusiasm.",
    };
  }

  return {
    previousCategory: prevCat,
    previousIntensity: prevInt,
    kind: "pivot",
    bridgeCue: `Transition naturally from ${prevCat.replace("_", " ")} into ${nextCategory.replace("_", " ")} with balanced pacing.`,
  };
}

function scoreToIntensity(
  category: Exclude<ExpressionCategory, "neutral">,
  score: number,
  text: string
): ExpressionIntensity {
  const exclamations = (text.match(/!/g) ?? []).length;
  if (
    score >= 3.2 ||
    (category === "happy_excited" && MAJOR_ACHIEVEMENT_BOOST.test(text)) ||
    (category === "empathetic_supportive" && EXTREME_DISTRESS_BOOST.test(text)) ||
    (score >= 2.4 && exclamations >= 2)
  ) {
    return "strong";
  }
  if (score >= 1.55 || exclamations >= 1) {
    return "moderate";
  }
  return "subtle";
}

export class EmotionUnderstandingEngine {
  private current: ExpressionState;
  private readonly history: TurnMemoryEntry[] = [];
  private readonly maxHistory = 6;

  constructor(now: number = Date.now()) {
    this.current = createDefaultExpressionState(now);
  }

  getExpression(): ExpressionState {
    return this.current;
  }

  getHistory(): readonly TurnMemoryEntry[] {
    return this.history;
  }

  reset(now: number = Date.now()): ExpressionState {
    this.history.length = 0;
    this.current = createDefaultExpressionState(now);
    return this.current;
  }

  processUserUtterance(
    rawText: string,
    now: number = Date.now()
  ): ExpressionState {
    const text = rawText.replace(/\s+/g, " ").trim();
    if (!text) {
      return this.current;
    }

    // 1. Check explicit ambiguity / uncertainty first (conservative Neutral / smooth fade rule)
    if (AMBIGUOUS_UNCERTAIN_PATTERNS.some((p) => p.test(text))) {
      const transition = buildTransitionDescriptor(
        this.current,
        "neutral",
        "subtle"
      );
      const next: ExpressionState = {
        category: "neutral",
        intensity: "subtle",
        reason: "ambiguous_or_mixed_cues",
        confidence: 0.72,
        sourceTurn:
          this.current.category !== "neutral" ? "transition" : "user_input",
        updatedAt: now,
        transition,
      };
      this.recordTurn(text, next);
      this.current = next;
      return next;
    }

    // 2. Score current utterance across all non-neutral categories
    const scores = emptyScores();
    const reasons: Partial<Record<Exclude<ExpressionCategory, "neutral">, string>> = {};

    for (const category of Object.keys(CUE_RULES) as Array<
      Exclude<ExpressionCategory, "neutral">
    >) {
      for (const rule of CUE_RULES[category]) {
        if (rule.pattern.test(text)) {
          scores[category] += rule.weight;
          if (!reasons[category]) {
            reasons[category] = rule.reason;
          }
        }
      }
    }

    // Utility/plain factual questions with no clear emotion signal remain strictly neutral
    const isOrdinaryUtility = ORDINARY_UTILITY_QUERY.test(text);

    // Subtle multi-turn context continuity boost (only when utterance isn't opposite-valence or utility)
    const prev = this.history[this.history.length - 1];
    const hasSeriousOrEmpathyNow =
      scores.calm_serious >= 1.5 || scores.empathetic_supportive >= 1.4;
    if (
      prev &&
      prev.category !== "neutral" &&
      !isOrdinaryUtility &&
      !(prev.category === "playful_humorous" && hasSeriousOrEmpathyNow)
    ) {
      // Carry light contextual continuity so multi-turn follow-ups preserve thread awareness
      const prevCat = prev.category;
      if (scores[prevCat] > 0) {
        scores[prevCat] += 0.55;
      } else if (
        text.length <= 80 &&
        prevCat === "curious_interested" &&
        (/\?$/.test(text) || /\b(?:why|how)\s+(?:does|do|did|is|are|can|would|doesn'?t|don'?t|didn'?t|won'?t)\b/i.test(text))
      ) {
        scores.curious_interested += prev.intensity === "moderate" ? 1.55 : 1.0;
        reasons.curious_interested = reasons.curious_interested ?? "multi_turn_curiosity";
      } else if (
        prevCat === "happy_excited" &&
        /\b(they|it|offer|role|job|news|result)\b/i.test(text) &&
        !/\b(bad|no|not|failed|lost|worried|sad)\b/i.test(text)
      ) {
        scores.happy_excited += 0.75;
        reasons.happy_excited = reasons.happy_excited ?? "multi_turn_good_news";
      } else if (
        prevCat === "empathetic_supportive" &&
        /\b(still|worse|hard|tough|don'?t know what to do|been dealing with)\b/i.test(text)
      ) {
        scores.empathetic_supportive += 0.9;
        reasons.empathetic_supportive =
          reasons.empathetic_supportive ?? "multi_turn_support";
      }
    }

    // Rank top two categories
    const ranked = (
      Object.entries(scores) as Array<[Exclude<ExpressionCategory, "neutral">, number]>
    ).sort((a, b) => b[1] - a[1]);

    const [topCategory, topScore] = ranked[0];
    const [, secondScore] = ranked[1];

    // 3. Serious / Empathy sudden-transition override protection
    // Ensure serious/difficult turns override prior playful banter without hesitation
    const seriousOverride =
      (scores.calm_serious >= 1.65 && scores.calm_serious >= scores.playful_humorous) ||
      (scores.empathetic_supportive >= 1.4 &&
        scores.empathetic_supportive >= scores.playful_humorous);

    // 4. Conservative conflict check (mixed opposite emotions with tiny margin -> Neutral)
    const isConflicted =
      !seriousOverride &&
      topScore > 0 &&
      secondScore >= 1.2 &&
      topScore - secondScore < 0.65;

    const minActivationScore = isOrdinaryUtility ? 2.0 : 0.9;

    // 4b. Stage 5.3 Anti-Jitter Switching Inertia:
    // If already in a clear emotional state and a mild stray cue of a different mood appears
    // (without serious/empathy urgency or major boost), hold steady instead of flip-flopping.
    const switchThreshold = isSeriousOrSupportive(this.current.category)
      ? 1.55
      : 1.45;
    const isWeakStrayShift =
      !isConflicted &&
      !seriousOverride &&
      !isOrdinaryUtility &&
      this.current.category !== "neutral" &&
      topCategory !== this.current.category &&
      topScore >= minActivationScore &&
      topScore < switchThreshold;

    if (isWeakStrayShift) {
      const heldIntensity = this.current.intensity;
      const next: ExpressionState = {
        category: this.current.category,
        intensity: heldIntensity,
        reason: `holding_${this.current.category}_against_mild_cue`,
        confidence: Math.max(0.62, this.current.confidence - 0.04),
        sourceTurn: "transition",
        updatedAt: now,
        transition: buildTransitionDescriptor(
          this.current,
          this.current.category,
          heldIntensity
        ),
      };
      this.recordTurn(text, next);
      this.current = next;
      return next;
    }

    if (isConflicted || topScore < minActivationScore) {
      // Smoothly fade active non-neutral expression toward Neutral across ordinary turns
      if (
        !isConflicted &&
        !isOrdinaryUtility &&
        this.current.category !== "neutral"
      ) {
        const faded = stepDownIntensity(this.current.intensity);
        if (faded) {
          const next: ExpressionState = {
            category: this.current.category,
            intensity: faded,
            reason: `fading_${this.current.category}_toward_neutral`,
            confidence: 0.6,
            sourceTurn: "transition",
            updatedAt: now,
            transition: buildTransitionDescriptor(
              this.current,
              this.current.category,
              faded
            ),
          };
          this.recordTurn(text, next);
          this.current = next;
          return next;
        }
      }

      const next: ExpressionState = {
        category: "neutral",
        intensity: "subtle",
        reason: isConflicted
          ? "mixed_signals_conservative_neutral"
          : isOrdinaryUtility
            ? "ordinary_factual_query"
            : "insufficient_emotional_evidence",
        confidence: isConflicted ? 0.7 : 0.85,
        sourceTurn:
          this.current.category !== "neutral" ? "transition" : "user_input",
        updatedAt: now,
        transition: buildTransitionDescriptor(this.current, "neutral", "subtle"),
      };
      this.recordTurn(text, next);
      this.current = next;
      return next;
    }

    // 5. Stage 5.3 Natural Asymmetric Intensity Smoothing
    let intensity = scoreToIntensity(topCategory, topScore, text);
    const hasMajorOrExtremeTrigger =
      MAJOR_ACHIEVEMENT_BOOST.test(text) || EXTREME_DISTRESS_BOOST.test(text);

    if (
      isSeriousOrSupportive(this.current.category) &&
      isUpbeatCategory(topCategory)
    ) {
      // Confirmed decision: lift gradually out of calm/serious into upbeat states
      const maxLiftRank = topScore >= 2.2 || hasMajorOrExtremeTrigger ? 1 : 0; // cap at moderate or subtle
      const cappedRank = Math.min(INTENSITY_RANK[intensity], maxLiftRank);
      intensity = RANK_TO_INTENSITY[cappedRank];
    } else if (
      this.current.category === topCategory &&
      !hasMajorOrExtremeTrigger
    ) {
      // Gradual +1 intensity ramping within an ongoing mood, and hold steady against sudden dips while cues remain active
      const prevRank = INTENSITY_RANK[this.current.intensity];
      const nextRank = INTENSITY_RANK[intensity];
      if (nextRank - prevRank > 1) {
        intensity = RANK_TO_INTENSITY[prevRank + 1];
      } else if (prevRank === 1 && nextRank === 0 && topScore >= 1.0) {
        intensity = "moderate";
      }
    } else if (
      this.current.category === "neutral" &&
      !hasMajorOrExtremeTrigger &&
      topScore < 3.2 &&
      (text.match(/!/g) ?? []).length < 2 &&
      intensity === "strong"
    ) {
      intensity = "moderate";
    }

    const isShift =
      this.current.category !== "neutral" && this.current.category !== topCategory;

    const transition = buildTransitionDescriptor(
      this.current,
      topCategory,
      intensity
    );

    const next: ExpressionState = {
      category: topCategory,
      intensity,
      reason: reasons[topCategory] ?? topCategory,
      confidence: Math.min(0.98, Number((0.55 + topScore * 0.11).toFixed(2))),
      sourceTurn: isShift ? "transition" : "user_input",
      updatedAt: now,
      transition,
    };

    this.recordTurn(text, next);
    this.current = next;
    return next;
  }

  private recordTurn(text: string, state: ExpressionState): void {
    this.history.push({
      text,
      category: state.category,
      intensity: state.intensity,
    });
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
  }
}
