export type VoiceState =
  | "DISCONNECTED"
  | "CONNECTING"
  | "CONNECTED"
  | "LISTENING"
  | "USER SPEAKING"
  | "THINKING"
  | "SPEAKING"
  | "ERROR";

export type ExpressionCategory =
  | "happy_excited"
  | "curious_interested"
  | "empathetic_supportive"
  | "playful_humorous"
  | "surprised_amazed"
  | "calm_serious"
  | "neutral";

export type ExpressionIntensity = "subtle" | "moderate" | "strong";

export type ExpressionTransitionKind =
  | "steady"
  | "lift"
  | "soften"
  | "pivot"
  | "ease_to_neutral"
  | "reset";

export interface ExpressionTransition {
  previousCategory: ExpressionCategory;
  previousIntensity: ExpressionIntensity;
  kind: ExpressionTransitionKind;
  bridgeCue: string;
}

export interface ExpressionState {
  category: ExpressionCategory;
  intensity: ExpressionIntensity;
  reason: string;
  confidence: number;
  sourceTurn: "user_input" | "assistant_output" | "transition" | "default";
  updatedAt: number;
  transition?: ExpressionTransition;
}

export function createDefaultExpressionState(
  now: number = Date.now()
): ExpressionState {
  return {
    category: "neutral",
    intensity: "subtle",
    reason: "neutral_baseline",
    confidence: 1,
    sourceTurn: "default",
    updatedAt: now,
    transition: {
      previousCategory: "neutral",
      previousIntensity: "subtle",
      kind: "reset",
      bridgeCue: "Maintain a relaxed, clear everyday conversational baseline.",
    },
  };
}

export type VoiceSpeedMode = "slow" | "normal" | "fast";

export interface SessionContextSummary {
  currentTopic: string | null;
  topicHistory: string[];
  keyDetails: string[];
  pendingItems: string[];
  recentTurns: Array<{ user: string; assistant: string }>;
  turnCount: number;
  updatedAt: number;
}

export interface VoiceSnapshot {
  state: VoiceState;
  isMuted: boolean;
  isMicActive: boolean;
  isSessionOpen: boolean;
  isPlayingAudio: boolean;
  inputLevel: number;
  outputLevel: number;
  errorMessage: string | null;
  expression: ExpressionState;
  voiceMode: VoiceSpeedMode;
}
