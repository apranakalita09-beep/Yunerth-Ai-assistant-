import { EmotionUnderstandingEngine } from "./emotionUnderstanding.ts";
import {
  SessionContextTracker,
  classifySilentUserTurn,
  detectVoiceSpeedCommand,
  type SilentTurnReason,
} from "./sessionContext.ts";
import type {
  ExpressionState,
  SessionContextSummary,
  VoiceSpeedMode,
} from "./src/voice/types.ts";

export const DEFAULT_SILENCE_REENGAGE_MS = 7000;
export const DEFAULT_GREETING_DELAY_MS = 250;
export const DEFAULT_MODEL_TURN_WATCHDOG_MS = 15000;

const CLOSING_CUE_PATTERN =
  /\b(bye|goodbye|bye-bye|see you|see ya|talk later|talk to you later|catch you later|gotta go|got to go|have to go|i need to go|i have to go|that's all|that is all|that will be all|we're done|we are done|i'm done|i am done|end the call|end conversation|stop the conversation|good night|goodnight|have a good night)\b/i;

const ASSISTANT_CLOSING_PATTERN =
  /\b(goodbye|bye!?|talk (?:to you )?(?:later|soon))\b/i;

const QUIET_PAUSE_PATTERN =
  /\b((?:hold on|hang on|wait a (?:sec|second|minute|moment)|give me a (?:sec|second|minute|moment)|just a (?:sec|second|moment))\s+(?:while i |to |let me )?(?:think|check|figure|read)|let me think|need a moment to think|need a second to think|stay quiet|be quiet|quiet please|shh+|mute for a (?:sec|second|minute)|pause for a moment)\b/i;

export interface SilenceReengageContext {
  kind: "initial" | "followup";
  askedQuestionRecently: boolean;
  lastAssistantText: string;
  lastUserText: string;
  expression: ExpressionState;
}

export interface LiveContextSyncPayload {
  expression: ExpressionState;
  voiceMode: VoiceSpeedMode;
  contextSummaryBlock: string;
  retrievedMemoriesBlock: string;
}

export interface ConversationFlowCallbacks {
  onSendGreeting: () => void;
  onSendSilenceReengagement: (context: SilenceReengageContext) => void;
  onExpressionChange?: (expression: ExpressionState) => void;
  onVocalDeliveryUpdate?: (expression: ExpressionState) => void;
  onLiveContextSync?: (payload: LiveContextSyncPayload) => void;
  onVoiceModeChange?: (
    mode: VoiceSpeedMode,
    source: "voice_command" | "ui"
  ) => void;
  onContextSummaryChange?: (summary: SessionContextSummary) => void;
  onSilentUserTurnDetected?: (info: {
    reason: SilentTurnReason;
    partialTranscript: string;
  }) => boolean;
  onCompletedTurnForMemory?: (turn: {
    userText: string;
    assistantText: string;
    currentTopic: string | null;
    completedAtMs: number;
  }) => void;
  onIdleForMemoryPrompt?: () => void;
  initialVoiceMode?: VoiceSpeedMode;
  initialContextSummary?: SessionContextSummary | null;
  silenceDelayMs?: number;
  greetingDelayMs?: number;
  modelTurnWatchdogMs?: number;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function hasMeaningfulWords(text: string): boolean {
  const cleaned = text.replace(/[^a-zA-Z0-9\u00C0-\u024F\u0900-\u097F]+/g, "").trim();
  return cleaned.length >= 2;
}

export function isClosingUtterance(text: string): boolean {
  return CLOSING_CUE_PATTERN.test(normalizeText(text));
}

export function isQuietPauseRequest(text: string): boolean {
  return QUIET_PAUSE_PATTERN.test(normalizeText(text));
}

export function endedWithQuestion(text: string): boolean {
  const cleaned = normalizeText(text);
  if (!cleaned) return false;
  return cleaned.endsWith("?");
}

export class ConversationFlowController {
  private readonly callbacks: ConversationFlowCallbacks;
  private readonly silenceDelayMs: number;
  private readonly greetingDelayMs: number;
  private readonly modelTurnWatchdogMs: number;

  private isClosed = false;
  private isReady = false;
  private greetingSent = false;
  private awaitingGreetingTurn = false;
  private awaitingReengagementTurn = false;
  private awaitingClarificationTurn = false;

  private clientPlaybackActive = false;
  private clientUserSpeaking = false;
  private clientMuted = false;

  private modelGenerating = false;
  private modelEmittedAudioThisTurn = false;
  private pendingToolCount = 0;

  private reengagedThisPause = false;
  private closingDetected = false;
  private quietPauseRequested = false;

  private userTurnCount = 0;
  private currentInputTranscript = "";
  private currentOutputTranscript = "";
  private lastUserText = "";
  private lastAssistantText = "";
  private sawMeaningfulUserSpeechInTurn = false;
  private sawUserSpeechActivityInTurn = false;
  private clarificationFallbackTriggeredThisTurn = false;

  private greetingTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private modelTurnWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly emotionEngine = new EmotionUnderstandingEngine();
  private readonly contextTracker: SessionContextTracker;
  private voiceMode: VoiceSpeedMode;
  private lastVocalDeliveryKey = `${this.emotionEngine.getExpression().category}:${this.emotionEngine.getExpression().intensity}`;
  private pendingVocalDelivery: ExpressionState | null = null;
  private pendingLiveContextSync = false;
  private retrievedMemoriesBlock = "";

  constructor(callbacks: ConversationFlowCallbacks) {
    this.callbacks = callbacks;
    this.silenceDelayMs =
      callbacks.silenceDelayMs ?? DEFAULT_SILENCE_REENGAGE_MS;
    this.greetingDelayMs =
      callbacks.greetingDelayMs ?? DEFAULT_GREETING_DELAY_MS;
    this.modelTurnWatchdogMs =
      callbacks.modelTurnWatchdogMs ?? DEFAULT_MODEL_TURN_WATCHDOG_MS;
    this.voiceMode = callbacks.initialVoiceMode ?? "normal";
    this.contextTracker = new SessionContextTracker(
      callbacks.initialContextSummary ?? null
    );
    if (callbacks.initialContextSummary) {
      this.pendingLiveContextSync = true;
    }
  }

  getExpression(): ExpressionState {
    return this.emotionEngine.getExpression();
  }

  getVoiceMode(): VoiceSpeedMode {
    return this.voiceMode;
  }

  getContextSummary(): SessionContextSummary {
    return this.contextTracker.getSummary();
  }

  getContextSummaryBlock(): string {
    return this.contextTracker.buildContextSummaryBlock();
  }

  setRetrievedMemoriesBlock(block: string): void {
    if (this.isClosed) return;
    const trimmed = block.trim();
    if (this.retrievedMemoriesBlock === trimmed) return;
    this.retrievedMemoriesBlock = trimmed;
    this.pendingLiveContextSync = true;
    this.flushPendingVocalDelivery();
  }

  isIdleForBackgroundPrompt(): boolean {
    return (
      !this.isClosed &&
      this.isReady &&
      !this.clientPlaybackActive &&
      !this.modelGenerating &&
      !this.clientUserSpeaking &&
      this.pendingToolCount === 0 &&
      !this.closingDetected
    );
  }

  setVoiceMode(
    mode: VoiceSpeedMode,
    source: "voice_command" | "ui" = "ui"
  ): void {
    if (this.isClosed) return;
    if (this.voiceMode === mode) return;
    this.voiceMode = mode;
    this.pendingLiveContextSync = true;
    this.callbacks.onVoiceModeChange?.(mode, source);
    this.flushPendingVocalDelivery();
  }

  restoreContextSummary(summary: SessionContextSummary): void {
    if (this.isClosed) return;
    this.contextTracker.restore(summary);
    this.pendingLiveContextSync = true;
    this.callbacks.onContextSummaryChange?.(this.contextTracker.getSummary());
    this.flushPendingVocalDelivery();
  }

  onSessionReady(): void {
    if (this.isClosed || this.isReady) return;
    this.isReady = true;
    this.callbacks.onExpressionChange?.(this.emotionEngine.getExpression());
    if (this.voiceMode !== "normal" || this.pendingLiveContextSync) {
      this.pendingLiveContextSync = true;
      this.flushPendingVocalDelivery();
    }
    this.scheduleGreeting();
  }

  onClientState(state: {
    playbackActive?: boolean;
    userSpeaking?: boolean;
    muted?: boolean;
  }): void {
    if (this.isClosed) return;

    const prevPlayback = this.clientPlaybackActive;
    const prevUserSpeaking = this.clientUserSpeaking;

    if (typeof state.playbackActive === "boolean") {
      this.clientPlaybackActive = state.playbackActive;
    }
    if (typeof state.userSpeaking === "boolean") {
      this.clientUserSpeaking = state.userSpeaking;
    }
    if (typeof state.muted === "boolean") {
      this.clientMuted = state.muted;
    }

    if (this.clientUserSpeaking && !prevUserSpeaking) {
      this.sawUserSpeechActivityInTurn = true;
      this.clarificationFallbackTriggeredThisTurn = false;
      this.cancelGreetingTimer();
      this.cancelSilenceTimer();
      this.awaitingReengagementTurn = false;
    }

    if (this.clientMuted || this.clientPlaybackActive) {
      this.cancelSilenceTimer();
    }

    if (prevPlayback && !this.clientPlaybackActive) {
      // Playback just finished out loud; flush any deferred context / vocal delivery updates before silence listening
      this.flushPendingVocalDelivery();
      if (this.isIdleForBackgroundPrompt()) {
        this.callbacks.onIdleForMemoryPrompt?.();
      }
      this.evaluateSilenceTimer();
    } else if (!this.clientPlaybackActive && !this.clientUserSpeaking && !this.clientMuted) {
      if (
        this.isReady &&
        !this.greetingSent &&
        this.userTurnCount === 0 &&
        !this.modelGenerating &&
        !this.sawMeaningfulUserSpeechInTurn
      ) {
        this.scheduleGreeting();
      }
      this.flushPendingVocalDelivery();
      if (this.isIdleForBackgroundPrompt()) {
        this.callbacks.onIdleForMemoryPrompt?.();
      }
      this.evaluateSilenceTimer();
    }
  }

  onClientAudioFrameReceived(): void {
    // Raw mic audio frames are filtered client-side via SpeechGate;
    // actual speech state is governed by clientUserSpeaking + Live API turns.
  }

  onAudioStreamEnd(): void {
    if (this.isClosed) return;
    this.clientUserSpeaking = false;
  }

  onInputTranscription(textDelta: string): void {
    if (this.isClosed || !textDelta) return;
    this.sawUserSpeechActivityInTurn = true;
    const prevRecent = this.currentInputTranscript || this.lastUserText;
    this.currentInputTranscript = normalizeText(
      `${this.currentInputTranscript} ${textDelta}`
    );
    const combinedWindow = normalizeText(`${prevRecent} ${textDelta}`).slice(-140);

    if (hasMeaningfulWords(this.currentInputTranscript)) {
      this.sawMeaningfulUserSpeechInTurn = true;
      this.clarificationFallbackTriggeredThisTurn = false;
      this.lastUserText = this.currentInputTranscript;
      this.cancelGreetingTimer();
      this.cancelSilenceTimer();

      if (
        isClosingUtterance(this.currentInputTranscript) ||
        isClosingUtterance(combinedWindow)
      ) {
        this.closingDetected = true;
        this.quietPauseRequested = false;
      } else if (
        isQuietPauseRequest(this.currentInputTranscript) ||
        isQuietPauseRequest(combinedWindow)
      ) {
        this.quietPauseRequested = true;
      } else {
        // User actively started a new non-closing, non-pause conversational turn
        this.closingDetected = false;
        this.quietPauseRequested = false;
        this.reengagedThisPause = false;
      }

      if (!this.modelGenerating && !this.clientPlaybackActive) {
        const earlySpeedMode = detectVoiceSpeedCommand(this.currentInputTranscript);
        if (earlySpeedMode && earlySpeedMode !== this.voiceMode) {
          this.setVoiceMode(earlySpeedMode, "voice_command");
        }
      }
    }
  }

  onOutputTranscription(textDelta: string): void {
    if (this.isClosed || !textDelta) return;
    this.currentOutputTranscript = normalizeText(
      `${this.currentOutputTranscript} ${textDelta}`
    );
    if (hasMeaningfulWords(this.currentOutputTranscript)) {
      this.lastAssistantText = this.currentOutputTranscript;
    }
  }

  onToolCallStarted(count: number): void {
    if (this.isClosed || count <= 0) return;
    this.pendingToolCount += count;
    this.clearModelTurnWatchdog();
    this.cancelSilenceTimer();
  }

  onToolCallFinished(count: number): void {
    if (this.isClosed) return;
    this.pendingToolCount = Math.max(0, this.pendingToolCount - count);
    if (this.modelGenerating && this.pendingToolCount === 0) {
      this.armModelTurnWatchdog();
    }
    this.evaluateSilenceTimer();
  }

  onModelAudioChunk(): boolean {
    if (this.isClosed) return false;
    const isFirstChunkInTurn = !this.modelEmittedAudioThisTurn;
    this.modelGenerating = true;
    this.modelEmittedAudioThisTurn = true;
    this.cancelGreetingTimer();
    this.cancelSilenceTimer();
    this.armModelTurnWatchdog();

    // If this model turn was triggered by actual user speech (not greeting or silence nudge),
    // finalize any buffered input transcript as a completed user turn and allow future re-engagement.
    if (
      !this.awaitingGreetingTurn &&
      !this.awaitingReengagementTurn &&
      !this.awaitingClarificationTurn
    ) {
      if (this.sawMeaningfulUserSpeechInTurn || this.currentInputTranscript.length === 0) {
        this.userTurnCount += 1;
        this.reengagedThisPause = false;
      }
    }
    return isFirstChunkInTurn;
  }

  onInterrupted(): void {
    if (this.isClosed) return;
    this.clearModelTurnWatchdog();
    this.modelGenerating = false;
    this.modelEmittedAudioThisTurn = false;
    this.awaitingGreetingTurn = false;
    this.awaitingReengagementTurn = false;
    this.awaitingClarificationTurn = false;
    this.cancelSilenceTimer();

    // An interruption by user voice stops output and clears the floor; flush any deferred context/vocal shift cleanly
    this.reengagedThisPause = false;
    this.quietPauseRequested = false;
    this.flushPendingVocalDelivery(true);
  }

  onTurnComplete(): void {
    if (this.isClosed) return;

    const finishedInput = normalizeText(this.currentInputTranscript);
    const finishedOutput = normalizeText(this.currentOutputTranscript);
    const wasSystemTurn =
      this.awaitingGreetingTurn ||
      this.awaitingReengagementTurn ||
      this.awaitingClarificationTurn;
    const hadAudio = this.modelEmittedAudioThisTurn;
    const sawSpeechActivity =
      this.sawUserSpeechActivityInTurn || this.sawMeaningfulUserSpeechInTurn;

    if (finishedInput && hasMeaningfulWords(finishedInput)) {
      const prevExpression = this.emotionEngine.getExpression();
      const nextExpression = this.emotionEngine.processUserUtterance(finishedInput);
      if (
        prevExpression.category !== nextExpression.category ||
        prevExpression.intensity !== nextExpression.intensity ||
        prevExpression.reason !== nextExpression.reason ||
        prevExpression.sourceTurn !== nextExpression.sourceTurn
      ) {
        this.callbacks.onExpressionChange?.(nextExpression);
      }

      const nextVocalKey = `${nextExpression.category}:${nextExpression.intensity}`;
      if (nextVocalKey !== this.lastVocalDeliveryKey) {
        this.pendingVocalDelivery = nextExpression;
      }

      const requestedVoiceMode = detectVoiceSpeedCommand(finishedInput);
      if (requestedVoiceMode && requestedVoiceMode !== this.voiceMode) {
        this.voiceMode = requestedVoiceMode;
        this.pendingLiveContextSync = true;
        this.callbacks.onVoiceModeChange?.(requestedVoiceMode, "voice_command");
      }
    }

    if (finishedOutput) {
      this.lastAssistantText = finishedOutput;
      if (
        this.closingDetected ||
        isClosingUtterance(this.lastUserText) ||
        (this.userTurnCount > 0 && ASSISTANT_CLOSING_PATTERN.test(finishedOutput))
      ) {
        this.closingDetected = true;
      }
    }

    if (
      this.sawMeaningfulUserSpeechInTurn &&
      !this.awaitingGreetingTurn &&
      !this.awaitingReengagementTurn
    ) {
      this.userTurnCount = Math.max(1, this.userTurnCount);
    }

    // Feature 2: Never silently drop a user turn when Gemini Live finishes with zero audio
    if (
      !wasSystemTurn &&
      !hadAudio &&
      !finishedOutput &&
      this.pendingToolCount === 0 &&
      (sawSpeechActivity || finishedInput.length > 0) &&
      !this.clarificationFallbackTriggeredThisTurn
    ) {
      const reason = classifySilentUserTurn(finishedInput, sawSpeechActivity);
      if (reason && this.callbacks.onSilentUserTurnDetected) {
        this.clarificationFallbackTriggeredThisTurn = true;
        const dispatched = this.callbacks.onSilentUserTurnDetected({
          reason,
          partialTranscript: finishedInput,
        });
        if (dispatched) {
          this.currentInputTranscript = "";
          this.currentOutputTranscript = "";
          this.sawMeaningfulUserSpeechInTurn = false;
          this.sawUserSpeechActivityInTurn = false;
          this.modelEmittedAudioThisTurn = false;
          this.awaitingClarificationTurn = true;
          this.modelGenerating = true;
          this.armModelTurnWatchdog();
          return;
        }
      }
    }

    // Record compact active-session summary when genuine conversational turn finished
    if (
      !this.awaitingGreetingTurn &&
      !this.awaitingReengagementTurn &&
      (finishedInput || finishedOutput)
    ) {
      const summary = this.contextTracker.recordTurn({
        userText: finishedInput,
        assistantText: finishedOutput,
      });
      this.pendingLiveContextSync = true;
      this.callbacks.onContextSummaryChange?.(summary);
      if (!wasSystemTurn && finishedInput) {
        this.callbacks.onCompletedTurnForMemory?.({
          userText: finishedInput,
          assistantText: finishedOutput,
          currentTopic: summary.currentTopic,
          completedAtMs: Date.now(),
        });
      }
    }

    this.currentInputTranscript = "";
    this.currentOutputTranscript = "";
    this.sawMeaningfulUserSpeechInTurn = false;
    this.sawUserSpeechActivityInTurn = false;
    this.clearModelTurnWatchdog();
    this.modelGenerating = false;
    this.awaitingGreetingTurn = false;
    this.awaitingReengagementTurn = false;
    this.awaitingClarificationTurn = false;
    this.modelEmittedAudioThisTurn = false;

    // Wait for clientPlaybackActive -> false when audio was emitted (or flush immediately when playback idle)
    if (!hadAudio || !this.clientPlaybackActive) {
      this.flushPendingVocalDelivery();
      if (this.isIdleForBackgroundPrompt()) {
        this.callbacks.onIdleForMemoryPrompt?.();
      }
      this.evaluateSilenceTimer();
    }
  }

  recoverTurnState(): void {
    if (this.isClosed) return;
    this.clearModelTurnWatchdog();
    this.modelGenerating = false;
    this.modelEmittedAudioThisTurn = false;
    this.awaitingGreetingTurn = false;
    this.awaitingReengagementTurn = false;
    this.awaitingClarificationTurn = false;
    this.pendingToolCount = 0;
    this.flushPendingVocalDelivery();
    this.evaluateSilenceTimer();
  }

  dispose(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.cancelGreetingTimer();
    this.cancelSilenceTimer();
    this.clearModelTurnWatchdog();
    this.pendingVocalDelivery = null;
    this.pendingLiveContextSync = false;
    this.contextTracker.reset();
    this.emotionEngine.reset();
  }

  getDebugSnapshot() {
    return {
      isReady: this.isReady,
      greetingSent: this.greetingSent,
      clientPlaybackActive: this.clientPlaybackActive,
      clientUserSpeaking: this.clientUserSpeaking,
      clientMuted: this.clientMuted,
      modelGenerating: this.modelGenerating,
      pendingToolCount: this.pendingToolCount,
      reengagedThisPause: this.reengagedThisPause,
      closingDetected: this.closingDetected,
      quietPauseRequested: this.quietPauseRequested,
      userTurnCount: this.userTurnCount,
      hasSilenceTimer: this.silenceTimer !== null,
      hasPendingVocalDelivery: this.pendingVocalDelivery !== null,
      voiceMode: this.voiceMode,
      contextSummary: this.contextTracker.getSummary(),
      expression: this.emotionEngine.getExpression(),
    };
  }

  private flushPendingVocalDelivery(forceFromInterrupt = false): void {
    if (this.isClosed) return;
    if (!this.pendingVocalDelivery && !this.pendingLiveContextSync) return;
    if (!forceFromInterrupt && (this.clientPlaybackActive || this.modelGenerating)) {
      return;
    }

    let expressionChanged = false;
    if (this.pendingVocalDelivery) {
      const next = this.pendingVocalDelivery;
      this.pendingVocalDelivery = null;
      const key = `${next.category}:${next.intensity}`;
      if (key !== this.lastVocalDeliveryKey) {
        this.lastVocalDeliveryKey = key;
        expressionChanged = true;
        this.callbacks.onVocalDeliveryUpdate?.(next);
      }
    }

    if (expressionChanged || this.pendingLiveContextSync) {
      this.pendingLiveContextSync = false;
      this.callbacks.onLiveContextSync?.({
        expression: this.emotionEngine.getExpression(),
        voiceMode: this.voiceMode,
        contextSummaryBlock: this.contextTracker.buildContextSummaryBlock(),
        retrievedMemoriesBlock: this.retrievedMemoriesBlock,
      });
    }
  }

  private scheduleGreeting(): void {
    if (
      this.isClosed ||
      this.greetingSent ||
      this.greetingTimer !== null ||
      this.clientUserSpeaking ||
      this.clientMuted
    ) {
      return;
    }

    this.greetingTimer = setTimeout(() => {
      this.greetingTimer = null;
      if (
        this.isClosed ||
        this.greetingSent ||
        this.clientUserSpeaking ||
        this.clientMuted ||
        this.modelGenerating
      ) {
        return;
      }
      this.greetingSent = true;
      this.awaitingGreetingTurn = true;
      this.modelGenerating = true;
      this.armModelTurnWatchdog();
      this.callbacks.onSendGreeting();
    }, this.greetingDelayMs);
  }

  private cancelGreetingTimer(): void {
    if (this.greetingTimer !== null) {
      clearTimeout(this.greetingTimer);
      this.greetingTimer = null;
    }
  }

  private canArmSilenceTimer(): boolean {
    if (this.isClosed || !this.isReady) return false;
    if (!this.greetingSent && this.userTurnCount === 0) return false;
    if (this.modelGenerating || this.clientPlaybackActive) return false;
    if (this.clientUserSpeaking || this.clientMuted) return false;
    if (this.pendingToolCount > 0) return false;
    if (this.reengagedThisPause) return false;
    if (this.closingDetected || this.quietPauseRequested) return false;
    return true;
  }

  private evaluateSilenceTimer(): void {
    if (!this.canArmSilenceTimer()) {
      if (
        this.modelGenerating ||
        this.clientPlaybackActive ||
        this.clientUserSpeaking ||
        this.clientMuted ||
        this.pendingToolCount > 0 ||
        this.closingDetected ||
        this.quietPauseRequested
      ) {
        this.cancelSilenceTimer();
      }
      return;
    }

    if (this.silenceTimer !== null) {
      return;
    }

    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      if (!this.canArmSilenceTimer()) {
        return;
      }

      this.reengagedThisPause = true;
      this.awaitingReengagementTurn = true;
      this.modelGenerating = true;
      this.armModelTurnWatchdog();

      this.callbacks.onSendSilenceReengagement({
        kind: this.userTurnCount === 0 ? "initial" : "followup",
        askedQuestionRecently: endedWithQuestion(this.lastAssistantText),
        lastAssistantText: this.lastAssistantText,
        lastUserText: this.lastUserText,
        expression: this.emotionEngine.getExpression(),
      });
    }, this.silenceDelayMs);
  }

  private cancelSilenceTimer(): void {
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  private armModelTurnWatchdog(): void {
    this.clearModelTurnWatchdog();
    if (this.isClosed) return;
    this.modelTurnWatchdogTimer = setTimeout(() => {
      this.modelTurnWatchdogTimer = null;
      if (
        !this.isClosed &&
        this.modelGenerating &&
        this.pendingToolCount === 0 &&
        !this.clientPlaybackActive
      ) {
        this.recoverTurnState();
      }
    }, this.modelTurnWatchdogMs);
  }

  private clearModelTurnWatchdog(): void {
    if (this.modelTurnWatchdogTimer !== null) {
      clearTimeout(this.modelTurnWatchdogTimer);
      this.modelTurnWatchdogTimer = null;
    }
  }
}
