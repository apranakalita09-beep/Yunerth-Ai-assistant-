export interface TurnLatencySample {
  speechEndAt: number;
  serverTurnAt: number | null;
  firstAudioRxAt: number | null;
  playbackStartAt: number | null;
  speechEndToTurnMs: number | null;
  turnToFirstAudioMs: number | null;
  firstAudioToPlaybackMs: number | null;
  totalResponseLatencyMs: number | null;
  viaMuteFlush: boolean;
}

export interface AudioReliabilityMetrics {
  suppressedNoiseFrames: number;
  transmittedSpeechFrames: number;
  muteFlushedTurns: number;
  interruptedTurns: number;
  missedTurnRecoveries: number;
  reconnectCount: number;
  lastTurnLatency: TurnLatencySample | null;
  averageTotalResponseLatencyMs: number | null;
}

export class AudioDiagnosticsTracker {
  private activeSpeechEndAt: number | null = null;
  private activeServerTurnAt: number | null = null;
  private activeFirstAudioRxAt: number | null = null;
  private activeViaMute = false;

  private readonly totalLatenciesMs: number[] = [];
  private lastTurnLatency: TurnLatencySample | null = null;

  private suppressedNoiseFrames = 0;
  private transmittedSpeechFrames = 0;
  private muteFlushedTurns = 0;
  private interruptedTurns = 0;
  private missedTurnRecoveries = 0;
  private reconnectCount = 0;

  reset(): void {
    this.activeSpeechEndAt = null;
    this.activeServerTurnAt = null;
    this.activeFirstAudioRxAt = null;
    this.activeViaMute = false;
    this.totalLatenciesMs.length = 0;
    this.lastTurnLatency = null;
    this.suppressedNoiseFrames = 0;
    this.transmittedSpeechFrames = 0;
    this.muteFlushedTurns = 0;
    this.interruptedTurns = 0;
    this.missedTurnRecoveries = 0;
    this.reconnectCount = 0;
  }

  recordSuppressedNoiseFrame(): void {
    this.suppressedNoiseFrames += 1;
  }

  recordTransmittedSpeechFrame(): void {
    this.transmittedSpeechFrames += 1;
  }

  markUserSpeechCompleted(viaMuteFlush = false, nowMs = Date.now()): void {
    this.activeSpeechEndAt = nowMs;
    this.activeServerTurnAt = null;
    this.activeFirstAudioRxAt = null;
    this.activeViaMute = viaMuteFlush;
    if (viaMuteFlush) {
      this.muteFlushedTurns += 1;
    }
  }

  markServerTurnCommitted(nowMs = Date.now()): void {
    if (this.activeSpeechEndAt !== null && this.activeServerTurnAt === null) {
      this.activeServerTurnAt = nowMs;
    }
  }

  markFirstResponseAudioReceived(nowMs = Date.now()): void {
    if (this.activeSpeechEndAt !== null && this.activeFirstAudioRxAt === null) {
      this.activeFirstAudioRxAt = nowMs;
      if (this.activeServerTurnAt === null) {
        this.activeServerTurnAt = nowMs;
      }
    }
  }

  markPlaybackStarted(nowMs = Date.now()): TurnLatencySample | null {
    if (this.activeSpeechEndAt === null) {
      return null;
    }

    const t0 = this.activeSpeechEndAt;
    const t1 = this.activeServerTurnAt ?? this.activeFirstAudioRxAt ?? nowMs;
    const t2 = this.activeFirstAudioRxAt ?? nowMs;
    const t3 = nowMs;

    const sample: TurnLatencySample = {
      speechEndAt: t0,
      serverTurnAt: t1,
      firstAudioRxAt: t2,
      playbackStartAt: t3,
      speechEndToTurnMs: Math.max(0, t1 - t0),
      turnToFirstAudioMs: Math.max(0, t2 - t1),
      firstAudioToPlaybackMs: Math.max(0, t3 - t2),
      totalResponseLatencyMs: Math.max(0, t3 - t0),
      viaMuteFlush: this.activeViaMute,
    };

    this.lastTurnLatency = sample;
    if (sample.totalResponseLatencyMs !== null) {
      this.totalLatenciesMs.push(sample.totalResponseLatencyMs);
      if (this.totalLatenciesMs.length > 20) {
        this.totalLatenciesMs.shift();
      }
    }

    this.activeSpeechEndAt = null;
    this.activeServerTurnAt = null;
    this.activeFirstAudioRxAt = null;
    this.activeViaMute = false;
    return sample;
  }

  recordInterruption(): void {
    this.interruptedTurns += 1;
    this.activeSpeechEndAt = null;
    this.activeServerTurnAt = null;
    this.activeFirstAudioRxAt = null;
    this.activeViaMute = false;
  }

  recordMissedTurnRecovery(): void {
    this.missedTurnRecoveries += 1;
    this.activeSpeechEndAt = null;
  }

  recordReconnect(): void {
    this.reconnectCount += 1;
  }

  getMetrics(): AudioReliabilityMetrics {
    const avg =
      this.totalLatenciesMs.length > 0
        ? Math.round(
            this.totalLatenciesMs.reduce((a, b) => a + b, 0) /
              this.totalLatenciesMs.length
          )
        : null;

    return {
      suppressedNoiseFrames: this.suppressedNoiseFrames,
      transmittedSpeechFrames: this.transmittedSpeechFrames,
      muteFlushedTurns: this.muteFlushedTurns,
      interruptedTurns: this.interruptedTurns,
      missedTurnRecoveries: this.missedTurnRecoveries,
      reconnectCount: this.reconnectCount,
      lastTurnLatency: this.lastTurnLatency,
      averageTotalResponseLatencyMs: avg,
    };
  }
}
