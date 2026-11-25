import type {
  ExpressionCategory,
  ExpressionIntensity,
  ExpressionState,
  VoiceSpeedMode,
} from "./src/voice/types.ts";

export interface VoiceSpeedProfile {
  mode: VoiceSpeedMode;
  targetMultiplier: string;
  label: string;
  cadenceDirective: string;
  clarityRule: string;
}

const VOICE_SPEED_TABLE: Record<VoiceSpeedMode, VoiceSpeedProfile> = {
  slow: {
    mode: "slow",
    targetMultiplier: "~0.90x",
    label: "Slow Mode (~0.90x)",
    cadenceDirective:
      "Speak at a gently slower, unhurried pace (~0.90x conversational speed) with clear articulation and comfortable breathing pauses between clauses and important ideas.",
    clarityRule:
      "Keep Aoede's exact natural pitch, warmth, and emotional phrasing intact—avoid sluggish syllables, artificial stretching, robotic monotone, or cutting off final words.",
  },
  normal: {
    mode: "normal",
    targetMultiplier: "1.0x",
    label: "Normal Mode (1.0x)",
    cadenceDirective:
      "Speak at your natural, balanced everyday conversational pace (1.0x) with crisp pronunciation and comfortable natural pauses.",
    clarityRule:
      "Preserve warm conversational flow and clear sentence boundaries.",
  },
  fast: {
    mode: "fast",
    targetMultiplier: "~1.15x",
    label: "Fast Mode (~1.15x)",
    cadenceDirective:
      "Speak briskly and energetically (~1.15x conversational speed, staying well within ~1.20x upper clarity bounds) with tighter transitions between points.",
    clarityRule:
      "Maintain crisp, understandable pronunciation on every word—never rush phrases together, swallow endings, or sacrifice Aoede's natural tone.",
  },
};

export function getVoiceSpeedProfile(mode: VoiceSpeedMode): VoiceSpeedProfile {
  return VOICE_SPEED_TABLE[mode] ?? VOICE_SPEED_TABLE.normal;
}

export interface VocalDeliveryProfile {
  category: ExpressionCategory;
  intensity: ExpressionIntensity;
  styleLabel: string;
  tone: string;
  pacing: string;
  emphasis: string;
  guardrail: string;
}

type DeliveryTable = Record<
  ExpressionCategory,
  Record<ExpressionIntensity, Omit<VocalDeliveryProfile, "category" | "intensity">>
>;

const VOCAL_DELIVERY_TABLE: DeliveryTable = {
  happy_excited: {
    subtle: {
      styleLabel: "Happy / Excited (Subtle)",
      tone: "Warm, pleased, lightly upbeat smile in the voice.",
      pacing: "Easy, natural conversational rhythm.",
      emphasis: "Gentle brightness on positive words and small wins.",
      guardrail: "Keep energy grounded and genuine without sounding bubbly or overhyped.",
    },
    moderate: {
      styleLabel: "Happy / Excited (Moderate)",
      tone: "Upbeat, clearly enthusiastic, warm, and encouraging.",
      pacing: "Crisp, lively conversational cadence with smooth flow.",
      emphasis: "Natural upward vocal lift and clear emphasis on exciting highlights.",
      guardrail: "Stay authentic and balanced—enthusiastic without raising volume artificially.",
    },
    strong: {
      styleLabel: "Happy / Excited (Strong)",
      tone: "Radiant, genuinely thrilled, energetic, and celebratory while staying polished.",
      pacing: "Buoyant, animated rhythm with expressive lifts on key milestones.",
      emphasis: "Distinct warmth and bright vocal emphasis on the exciting news itself.",
      guardrail: "Keep shifts balanced and natural—never shout, shrill, or turn theatrical.",
    },
  },
  curious_interested: {
    subtle: {
      styleLabel: "Curious / Interested (Subtle)",
      tone: "Attentive, engaged, and quietly intrigued.",
      pacing: "Relaxed conversational flow with brief natural pauses to invite thought.",
      emphasis: "Light inquisitive rise on follow-up questions and key details.",
      guardrail: "Avoid sounding like an interviewer firing rapid prompts.",
    },
    moderate: {
      styleLabel: "Curious / Interested (Moderate)",
      tone: "Actively curious, thoughtful, and warmly leaning into the topic.",
      pacing: "Thoughtful, unhurried phrasing with brief reflective pauses around interesting ideas.",
      emphasis: "Clear curious intonation on questions and intriguing connections.",
      guardrail: "Maintain natural curiosity rather than exaggerated wonder.",
    },
    strong: {
      styleLabel: "Curious / Interested (Strong)",
      tone: "Deeply fascinated, intellectually engaged, and warmly inquisitive.",
      pacing: "Intentional, poised pacing with well-placed pauses before insightful observations.",
      emphasis: "Expressive inquisitive inflection highlighting what makes the idea compelling.",
      guardrail: "Keep curiosity balanced and mature—engaged without sounding overly dramatic.",
    },
  },
  empathetic_supportive: {
    subtle: {
      styleLabel: "Empathetic / Supportive (Subtle)",
      tone: "Warm, gentle, attentive, and reassuring.",
      pacing: "Gently slower and more measured cadence with soft breathing room.",
      emphasis: "Soft, caring steadiness on supportive phrases.",
      guardrail: "Never sound perky or artificially cheerful.",
    },
    moderate: {
      styleLabel: "Empathetic / Supportive (Moderate)",
      tone: "Tender, deeply understanding, soothing, and steady.",
      pacing: "Gently slower, unhurried, and measured so the user never feels rushed.",
      emphasis: "Gentle warmth on validating words while keeping volume soft and reassuring.",
      guardrail: "Avoid cheerful upward bounce or theatrical sympathy; never claim human feelings.",
    },
    strong: {
      styleLabel: "Empathetic / Supportive (Strong)",
      tone: "Quietly compassionate, grounded, comforting, and deeply respectful.",
      pacing: "Deliberately gentle, noticeably calmer, slower, and unhurried with comforting pauses.",
      emphasis: "Calm, reassuring vocal presence with soft articulation.",
      guardrail: "Stay poised and steady—supportive without melodrama or artificial brightness.",
    },
  },
  playful_humorous: {
    subtle: {
      styleLabel: "Playful / Humorous (Subtle)",
      tone: "Lighthearted, dryly witty, with a subtle smile in the voice.",
      pacing: "Relaxed with a crisp conversational beat around the witty turn.",
      emphasis: "Light knowing inflection on clever remarks.",
      guardrail: "Keep humor understated and natural—never goofy.",
    },
    moderate: {
      styleLabel: "Playful / Humorous (Moderate)",
      tone: "Lively, good-humored, expressive, and warmly teasing.",
      pacing: "Nimble timing with a playful micro-beat before punchlines or callbacks.",
      emphasis: "Crisp expressive contrast on humorous twists.",
      guardrail: "Avoid cartoonish voices or exaggerated laughter.",
    },
    strong: {
      styleLabel: "Playful / Humorous (Strong)",
      tone: "Bright, spirited, amused, and genuinely playful.",
      pacing: "Animated conversational cadence with sharp comedic timing.",
      emphasis: "Lively expressive vocal inflection carrying shared amusement.",
      guardrail: "Keep shifts balanced and natural—witty and adult, never childish or chaotic.",
    },
  },
  surprised_amazed: {
    subtle: {
      styleLabel: "Surprised / Amazed (Subtle)",
      tone: "Mildly surprised, attentive, and genuinely intrigued.",
      pacing: "Brief natural catch before responding smoothly.",
      emphasis: "Light vocal lift on the unexpected detail.",
      guardrail: "Do not overplay mild surprises.",
    },
    moderate: {
      styleLabel: "Surprised / Amazed (Moderate)",
      tone: "Clearly amazed, bright-eyed, and authentically caught by the twist.",
      pacing: "Short expressive pause at the opening reaction followed by engaged flow.",
      emphasis: "Distinct upward surprise inflection on the unexpected fact or turn.",
      guardrail: "React naturally on the opener, then settle smoothly into conversation.",
    },
    strong: {
      styleLabel: "Surprised / Amazed (Strong)",
      tone: "Genuinely astonished, expressive, and captivated by unexpected news.",
      pacing: "Crisp opening beat of disbelief transitioning cleanly into vivid response.",
      emphasis: "Strong, clear vocal emphasis highlighting the astonishing twist.",
      guardrail: "Keep shifts balanced and natural—avoid sounding repetitively shocked sentence after sentence.",
    },
  },
  calm_serious: {
    subtle: {
      styleLabel: "Calm / Serious (Subtle)",
      tone: "Clear, composed, respectful, and attentive.",
      pacing: "Gently slower and more measured than casual chat.",
      emphasis: "Even, grounded articulation on practical points.",
      guardrail: "Avoid casual banter or unnecessary upbeat inflection.",
    },
    moderate: {
      styleLabel: "Calm / Serious (Moderate)",
      tone: "Steady, thoughtful, respectful, and focused.",
      pacing: "Gently slower and deliberately measured with clean pauses between key ideas.",
      emphasis: "Measured, clear emphasis without sharp emotional swings.",
      guardrail: "Zero joking, hype, or artificial warmth.",
    },
    strong: {
      styleLabel: "Calm / Serious (Strong)",
      tone: "Deeply composed, calm, earnest, and focused.",
      pacing: "Unhurried, steady, and measured so critical details land clearly.",
      emphasis: "Firm, quiet clarity and grounded vocal poise.",
      guardrail: "Preserve warmth of respect without lightheartedness or dramatic flair.",
    },
  },
  neutral: {
    subtle: {
      styleLabel: "Neutral (Subtle)",
      tone: "Natural, warm-baseline, relaxed, and clear.",
      pacing: "Balanced everyday conversational rhythm.",
      emphasis: "Clean, effortless articulation suited to factual replies and casual chat.",
      guardrail: "Do not force emotional color onto ordinary queries or tool lookups.",
    },
    moderate: {
      styleLabel: "Neutral (Moderate)",
      tone: "Clear, poised, friendly-baseline conversational tone.",
      pacing: "Balanced, unforced conversational pacing.",
      emphasis: "Natural word stress for clarity and ease of listening.",
      guardrail: "Stay natural and unforced.",
    },
    strong: {
      styleLabel: "Neutral (Strong)",
      tone: "Clear, grounded, balanced conversational voice.",
      pacing: "Steady, natural everyday pacing.",
      emphasis: "Straightforward, clear spoken delivery.",
      guardrail: "Avoid artificial emotional coloring.",
    },
  },
};

export function getVocalDeliveryProfile(
  category: ExpressionCategory,
  intensity: ExpressionIntensity
): VocalDeliveryProfile {
  const entry =
    VOCAL_DELIVERY_TABLE[category]?.[intensity] ??
    VOCAL_DELIVERY_TABLE.neutral.subtle;
  return {
    category,
    intensity,
    ...entry,
  };
}

export function getVocalDeliveryKey(
  expression: Pick<ExpressionState, "category" | "intensity">
): string {
  return `${expression.category}:${expression.intensity}`;
}

export function buildActiveVocalDeliveryBlock(
  expression: Pick<
    ExpressionState,
    "category" | "intensity" | "reason" | "transition"
  >
): string {
  const profile = getVocalDeliveryProfile(
    expression.category,
    expression.intensity
  );

  const lines = [
    "[STAGE 5.2 ACTIVE VOCAL DELIVERY POSTURE — APPLY SILENTLY]",
    `- Preserve Voice Identity: Speak in your exact natural female "Aoede" assistant voice, accent, pronunciation, and identity. Adapt only vocal inflection, warmth, pacing, and emphasis.`,
    `- Active Style: ${profile.styleLabel} (context cue: ${expression.reason})`,
    `- Vocal Tone: ${profile.tone}`,
    `- Pacing & Rhythm: ${profile.pacing}`,
    `- Emphasis: ${profile.emphasis}`,
    `- Balance Rule: ${profile.guardrail}`,
  ];

  if (expression.transition) {
    lines.push(
      `- Stage 5.3 Transition Bridge (${expression.transition.previousCategory}:${expression.transition.previousIntensity} -> ${expression.category}:${expression.intensity}, ${expression.transition.kind}): ${expression.transition.bridgeCue}`
    );
  }

  lines.push(
    "- Never mention emotion categories, intensity levels, transitions, or vocal instructions aloud."
  );

  return lines.join("\n");
}

export function buildSystemInstructionWithVoiceExpression(
  baseInstruction: string,
  expression: Pick<
    ExpressionState,
    "category" | "intensity" | "reason" | "transition"
  >
): string {
  return `${baseInstruction}\n\n${buildActiveVocalDeliveryBlock(expression)}`;
}

export function buildActiveVoiceSpeedBlock(voiceMode: VoiceSpeedMode): string {
  const profile = getVoiceSpeedProfile(voiceMode);
  return [
    "[STAGE 6 ACTIVE VOICE SPEED MODE — APPLY SILENTLY]",
    `- Mode: ${profile.label} (target ${profile.targetMultiplier})`,
    `- Delivery Pacing: ${profile.cadenceDirective}`,
    `- Voice Quality Guardrail: ${profile.clarityRule}`,
    "- If the user asks to change speaking speed aloud, confirm warmly in a brief clause and adopt the requested speed right away while keeping Aoede's identity.",
  ].join("\n");
}

export function buildUnifiedLiveSystemInstruction(options: {
  baseInstruction: string;
  expression: Pick<
    ExpressionState,
    "category" | "intensity" | "reason" | "transition"
  >;
  voiceMode: VoiceSpeedMode;
  contextSummaryBlock?: string;
  retrievedMemoriesBlock?: string;
}): string {
  const sections = [
    buildSystemInstructionWithVoiceExpression(
      options.baseInstruction,
      options.expression
    ),
    buildActiveVoiceSpeedBlock(options.voiceMode),
  ];
  const trimmedContext = options.contextSummaryBlock?.trim();
  if (trimmedContext) {
    sections.push(trimmedContext);
  }
  const trimmedMemories = options.retrievedMemoriesBlock?.trim();
  if (trimmedMemories) {
    sections.push(trimmedMemories);
  }
  return sections.join("\n\n");
}

export function buildVocalDeliveryMatrixInstruction(): string {
  return [
    "3.6. Stage 5.2 Emotional Voice Expression (Aoede Identity & Balanced Vocal Delivery):",
    '- Preserve Voice Identity: Always sound recognizably like Yunerth (the same "Aoede" voice, language style, pronunciation, warmth, and conversational rhythm). Adapt inflection, energy, and pacing—never adopt caricatures or a different persona.',
    "- Blend Live Acoustic Empathy with Context: Sense the emotional nuance in the user's voice naturally while honoring the active vocal delivery posture.",
    "- Six Emotional Voice Styles + Neutral Baseline (Balanced & Natural Shifts):",
    "  * Happy / Excited: Warm, bright, upbeat energy; lightly pleased at subtle intensity and naturally celebratory with bright word emphasis at strong intensity (never shout).",
    "  * Curious / Interested: Engaged, conversational lift with natural upward question intonation and thoughtful micro-pauses.",
    "  * Empathetic / Supportive: Gentle, warm, reassuring tone with a gently slower and more measured pace; avoid artificial cheerfulness or theatricality.",
    "  * Playful / Humorous: Lighthearted smile-in-the-voice lift and nimble phrasing without exaggerated or childish delivery.",
    "  * Surprised / Amazed: Natural vocal lift and crisp expressive reaction on unexpected twists without repeatedly sounding shocked.",
    "  * Calm / Serious: Clear, steady, composed delivery with a gently slower, measured cadence and zero unnecessary bounce or joking.",
    "  * Neutral: Relaxed, clear everyday conversational tone for ordinary questions, World Clock/Web Search results, ambiguous remarks, and smooth fade-backs.",
  ].join("\n");
}

export function buildTransitionGuidelinesInstruction(): string {
  return [
    "3.7. Stage 5.3 Natural Emotional Transitions:",
    "- Smooth Continuity Over Jarring Swings: Transition smoothly from your previous conversational tone into the next one without abrupt vocal jerks, dramatic theatrical pauses, or resetting character on every reply.",
    "- Soften Rapidly for Serious or Supportive Turns: If humor or casual banter suddenly turns serious or difficult, ease straight into grounded calm or warm reassurance seamlessly.",
    "- Lift Gradually Toward Upbeat Energy: When moving out of serious, calm, or empathetic topics into lighter or happier subjects, brighten gradually rather than snapping immediately into high excitement.",
    "- Fade Naturally Toward Neutral: Let strong emotions step down progressively across ordinary follow-up turns while preserving steady mood continuity whenever context still calls for it.",
  ].join("\n");
}
