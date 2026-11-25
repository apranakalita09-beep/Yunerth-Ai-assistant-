import {
  createDefaultExpressionState,
  type ExpressionState,
  type VoiceSnapshot,
  type VoiceSpeedMode,
  type VoiceState,
} from "./types";

const THINKING_RECOVERY_TIMEOUT_MS = 6500;

type StateListener = (snapshot: VoiceSnapshot) => void;

export class StateManager {
  private snapshot: VoiceSnapshot = {
    state: "DISCONNECTED",
    isMuted: false,
    isMicActive: false,
    isSessionOpen: false,
    isPlayingAudio: false,
    inputLevel: 0,
    outputLevel: 0,
    errorMessage: null,
    expression: createDefaultExpressionState(),
    voiceMode: "normal",
  };

  private userIsSpeaking = false;
  private awaitingResponse = false;
  private thinkingWatchdogTimer: number | null = null;
  private listeners = new Set<StateListener>();
  private readonly onWatchdogTimeout?: () => void;

  constructor(options?: { onWatchdogTimeout?: () => void }) {
    this.onWatchdogTimeout = options?.onWatchdogTimeout;
  }

  getSnapshot(): VoiceSnapshot {
    return this.snapshot;
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setConnecting(): void {
    this.clearThinkingWatchdog();
    this.userIsSpeaking = false;
    this.awaitingResponse = false;
    this.update({
      state: "CONNECTING",
      isMuted: false,
      isMicActive: false,
      isSessionOpen: false,
      isPlayingAudio: false,
      inputLevel: 0,
      outputLevel: 0,
      errorMessage: null,
      expression: createDefaultExpressionState(),
      voiceMode: "normal",
    });
  }

  setSessionOpen(open: boolean): void {
    this.update({ isSessionOpen: open });
    this.recomputeState();
  }

  setMicActive(active: boolean): void {
    if (!active) {
      this.userIsSpeaking = false;
    }
    this.update({
      isMicActive: active,
      inputLevel: active ? this.snapshot.inputLevel : 0,
    });
    this.recomputeState();
  }

  setMuted(muted: boolean, hadRecentSpeech = false): void {
    if (muted) {
      if ((this.userIsSpeaking || hadRecentSpeech) && !this.snapshot.isPlayingAudio) {
        this.awaitingResponse = true;
        this.armThinkingWatchdog();
      }
      this.userIsSpeaking = false;
    }
    this.update({
      isMuted: muted,
      inputLevel: muted ? 0 : this.snapshot.inputLevel,
    });
    this.recomputeState();
  }

  setUserSpeaking(speaking: boolean): void {
    if (this.snapshot.state === "ERROR" || !this.snapshot.isSessionOpen) return;
    if (!this.snapshot.isMicActive || this.snapshot.isMuted) {
      this.userIsSpeaking = false;
      return;
    }

    if (speaking) {
      this.clearThinkingWatchdog();
      this.userIsSpeaking = true;
      this.awaitingResponse = false;
    } else if (this.userIsSpeaking) {
      this.userIsSpeaking = false;
      // Only enter THINKING after a genuine user speech burst when not already playing audio
      if (!this.snapshot.isPlayingAudio) {
        this.awaitingResponse = true;
        this.armThinkingWatchdog();
      }
    }
    this.recomputeState();
  }

  setPlayingAudio(playing: boolean): void {
    if (playing) {
      this.clearThinkingWatchdog();
      this.awaitingResponse = false;
      this.userIsSpeaking = false;
    }
    this.update({
      isPlayingAudio: playing,
      outputLevel: playing ? this.snapshot.outputLevel : 0,
    });
    this.recomputeState();
  }

  onTurnComplete(): void {
    this.clearThinkingWatchdog();
    this.awaitingResponse = false;
    this.recomputeState();
  }

  onInterrupted(): void {
    this.clearThinkingWatchdog();
    this.awaitingResponse = false;
    this.update({
      isPlayingAudio: false,
      outputLevel: 0,
    });
    this.recomputeState();
  }

  setLevels(inputLevel: number, outputLevel: number): void {
    const clampedIn = Math.max(0, Math.min(1, inputLevel));
    const clampedOut = Math.max(0, Math.min(1, outputLevel));
    if (
      Math.abs(clampedIn - this.snapshot.inputLevel) < 0.01 &&
      Math.abs(clampedOut - this.snapshot.outputLevel) < 0.01
    ) {
      return;
    }
    this.update({
      inputLevel: clampedIn,
      outputLevel: clampedOut,
    });
  }

  setExpression(expression: ExpressionState): void {
    this.update({ expression });
  }

  setVoiceMode(voiceMode: VoiceSpeedMode): void {
    if (this.snapshot.voiceMode === voiceMode) return;
    this.update({ voiceMode });
  }

  setError(message: string): void {
    this.clearThinkingWatchdog();
    this.userIsSpeaking = false;
    this.awaitingResponse = false;
    this.update({
      state: "ERROR",
      isMicActive: false,
      isSessionOpen: false,
      isPlayingAudio: false,
      inputLevel: 0,
      outputLevel: 0,
      errorMessage: message,
      expression: createDefaultExpressionState(),
    });
  }

  resetDisconnected(): void {
    this.clearThinkingWatchdog();
    this.userIsSpeaking = false;
    this.awaitingResponse = false;
    this.update({
      state: "DISCONNECTED",
      isMuted: false,
      isMicActive: false,
      isSessionOpen: false,
      isPlayingAudio: false,
      inputLevel: 0,
      outputLevel: 0,
      errorMessage: null,
      expression: createDefaultExpressionState(),
      voiceMode: "normal",
    });
  }

  private armThinkingWatchdog(): void {
    this.clearThinkingWatchdog();
    if (typeof window === "undefined") return;
    this.thinkingWatchdogTimer = window.setTimeout(() => {
      this.thinkingWatchdogTimer = null;
      if (this.awaitingResponse && !this.snapshot.isPlayingAudio && !this.userIsSpeaking) {
        this.awaitingResponse = false;
        this.onWatchdogTimeout?.();
        this.recomputeState();
      }
    }, THINKING_RECOVERY_TIMEOUT_MS);
  }

  private clearThinkingWatchdog(): void {
    if (this.thinkingWatchdogTimer !== null && typeof window !== "undefined") {
      window.clearTimeout(this.thinkingWatchdogTimer);
      this.thinkingWatchdogTimer = null;
    }
  }

  private recomputeState(): void {
    if (this.snapshot.state === "ERROR") return;

    let nextState: VoiceState;
    if (!this.snapshot.isSessionOpen) {
      nextState =
        this.snapshot.state === "CONNECTING" ? "CONNECTING" : "DISCONNECTED";
    } else if (this.snapshot.isPlayingAudio) {
      // SPEAKING is strictly shown only when AudioPlayer confirms output audio is playing
      nextState = "SPEAKING";
    } else if (this.userIsSpeaking && this.snapshot.isMicActive && !this.snapshot.isMuted) {
      nextState = "USER SPEAKING";
    } else if (this.awaitingResponse) {
      nextState = "THINKING";
    } else if (this.snapshot.isMicActive && !this.snapshot.isMuted) {
      // LISTENING is strictly shown only when microphone capture is actually running and unmuted
      nextState = "LISTENING";
    } else {
      nextState = "CONNECTED";
    }

    if (nextState !== this.snapshot.state) {
      this.update({ state: nextState });
    }
  }

  private update(partial: Partial<VoiceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial };
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  }
}
