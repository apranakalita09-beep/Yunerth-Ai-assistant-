const OUTPUT_SAMPLE_RATE = 24000;
const STALLED_PLAYBACK_GRACE_MS = 1800;

function base64ToPcm16Float32(base64: string): Float32Array {
  if (!base64) return new Float32Array(0);
  let binary: string;
  try {
    binary = atob(base64);
  } catch (err) {
    console.warn("AudioPlayer received invalid base64 chunk:", err);
    return new Float32Array(0);
  }
  const usableBytes = binary.length - (binary.length % 2);
  if (usableBytes <= 0) return new Float32Array(0);

  const bytes = new Uint8Array(usableBytes);
  for (let i = 0; i < usableBytes; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  const sampleCount = usableBytes / 2;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const float32 = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const int16 = view.getInt16(i * 2, true);
    float32[i] = int16 / 32768;
  }
  return float32;
}

export interface AudioPlayerCallbacks {
  onPlaybackStart: () => void;
  onPlaybackEnd: () => void;
  onLevel: (level: number) => void;
  onPlaybackBlocked?: (message: string) => void;
}

export class AudioPlayer {
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserData: Uint8Array<ArrayBuffer> | null = null;
  private activeSources = new Set<AudioBufferSourceNode>();
  private nextStartTime = 0;
  private isPlaying = false;
  private startTimer: number | null = null;
  private stallWatchdogTimer: number | null = null;
  private levelRafId: number | null = null;
  private playbackGeneration = 0;
  private blockedNotifiedForGeneration = -1;
  private readonly callbacks: AudioPlayerCallbacks;

  constructor(callbacks: AudioPlayerCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Must be called synchronously at the start of a user interaction gesture (tap/click)
   * on mobile and desktop browsers so the AudioContext is unlocked before async waits.
   */
  async unlock(): Promise<void> {
    const ctx = this.ensureContext();
    if (ctx.state === "suspended" || (ctx.state as string) === "interrupted") {
      await ctx.resume();
    }
    // Schedule a 1-sample silent buffer inside the gesture to fully unlock iOS/Safari audio output
    try {
      const silent = ctx.createBuffer(1, 1, OUTPUT_SAMPLE_RATE);
      const src = ctx.createBufferSource();
      src.buffer = silent;
      src.connect(ctx.destination);
      src.start(0);
    } catch {
      // Ignore if already unlocked or unavailable in test environments
    }
  }

  async enqueuePcm16Base64(base64: string): Promise<void> {
    const float32 = base64ToPcm16Float32(base64);
    if (float32.length === 0) return;

    const generation = this.playbackGeneration;
    const ctx = this.ensureContext();

    if (ctx.state === "suspended" || (ctx.state as string) === "interrupted") {
      try {
        await Promise.race([
          ctx.resume(),
          new Promise<void>((resolve) => window.setTimeout(resolve, 600)),
        ]);
      } catch {
        // Handled cleanly below via state check
      }
    }

    if (generation !== this.playbackGeneration) {
      return;
    }

    if (ctx.state !== "running") {
      if (this.blockedNotifiedForGeneration !== generation) {
        this.blockedNotifiedForGeneration = generation;
        console.error(
          `AudioPlayer output context remained "${ctx.state}"; audio playback blocked by browser autoplay policy.`
        );
        this.callbacks.onPlaybackBlocked?.(
          "Audio playback was blocked by the browser. Tap Disconnect and Connect again to enable sound."
        );
      }
      this.markPlaybackStopped();
      return;
    }

    const buffer = ctx.createBuffer(1, float32.length, OUTPUT_SAMPLE_RATE);
    buffer.getChannelData(0).set(float32);

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    if (this.analyser) {
      source.connect(this.analyser);
    } else {
      source.connect(ctx.destination);
    }

    const now = ctx.currentTime;
    const startTime = Math.max(now + 0.008, this.nextStartTime);
    this.nextStartTime = startTime + buffer.duration;

    this.activeSources.add(source);

    source.onended = () => {
      this.activeSources.delete(source);
      if (this.activeSources.size === 0) {
        this.nextStartTime = 0;
        this.clearStallWatchdog();
        this.markPlaybackStopped();
      }
    };

    source.start(startTime);
    this.armStallWatchdog(ctx);

    if (!this.isPlaying && this.startTimer === null) {
      const delayMs = Math.max(0, (startTime - ctx.currentTime) * 1000);
      if (delayMs <= 16) {
        this.markPlaybackStarted();
      } else {
        this.startTimer = window.setTimeout(() => {
          this.startTimer = null;
          if (this.activeSources.size > 0 && !this.isPlaying) {
            this.markPlaybackStarted();
          }
        }, delayMs);
      }
    }
  }

  clear(): void {
    this.playbackGeneration += 1;
    this.blockedNotifiedForGeneration = -1;
    if (this.startTimer !== null) {
      window.clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    this.clearStallWatchdog();

    for (const source of this.activeSources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Source may already be stopped
      }
      source.disconnect();
    }
    this.activeSources.clear();
    this.nextStartTime = 0;
    this.markPlaybackStopped();
  }

  async dispose(): Promise<void> {
    this.clear();
    this.stopLevelLoop();
    if (this.analyser) {
      this.analyser.disconnect();
      this.analyser = null;
      this.analyserData = null;
    }
    if (this.audioContext) {
      const ctx = this.audioContext;
      this.audioContext = null;
      await ctx.close().catch(() => undefined);
    }
  }

  private armStallWatchdog(ctx: AudioContext): void {
    this.clearStallWatchdog();
    const expectedRemainingMs = Math.max(
      0,
      (this.nextStartTime - ctx.currentTime) * 1000
    );
    this.stallWatchdogTimer = window.setTimeout(() => {
      this.stallWatchdogTimer = null;
      if (this.activeSources.size > 0) {
        console.warn(
          `[AudioPlayer] Clearing ${this.activeSources.size} stalled audio source(s) (ctxState=${this.audioContext?.state ?? "none"}).`
        );
        this.clear();
      }
    }, Math.round(expectedRemainingMs + STALLED_PLAYBACK_GRACE_MS));
  }

  private clearStallWatchdog(): void {
    if (this.stallWatchdogTimer !== null) {
      window.clearTimeout(this.stallWatchdogTimer);
      this.stallWatchdogTimer = null;
    }
  }

  private ensureContext(): AudioContext {
    if (this.audioContext && this.audioContext.state !== "closed") {
      return this.audioContext;
    }

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;

    let ctx: AudioContext;
    try {
      ctx = new AudioCtx({ sampleRate: OUTPUT_SAMPLE_RATE });
    } catch {
      ctx = new AudioCtx();
    }

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.72;
    analyser.connect(ctx.destination);

    this.audioContext = ctx;
    this.analyser = analyser;
    this.analyserData = new Uint8Array(
      new ArrayBuffer(analyser.frequencyBinCount)
    );
    return ctx;
  }

  private markPlaybackStarted(): void {
    if (this.isPlaying) return;
    this.isPlaying = true;
    this.callbacks.onPlaybackStart();
    this.startLevelLoop();
  }

  private markPlaybackStopped(): void {
    this.stopLevelLoop();
    this.callbacks.onLevel(0);
    if (!this.isPlaying) return;
    this.isPlaying = false;
    this.callbacks.onPlaybackEnd();
  }

  private startLevelLoop(): void {
    if (this.levelRafId !== null) return;

    const tick = () => {
      if (!this.isPlaying || !this.analyser || !this.analyserData) {
        this.levelRafId = null;
        return;
      }
      this.analyser.getByteTimeDomainData(this.analyserData);
      let sumSquares = 0;
      for (let i = 0; i < this.analyserData.length; i++) {
        const normalized = (this.analyserData[i] - 128) / 128;
        sumSquares += normalized * normalized;
      }
      const rms = Math.sqrt(sumSquares / this.analyserData.length);
      this.callbacks.onLevel(Math.min(1, rms * 4.5));
      this.levelRafId = window.requestAnimationFrame(tick);
    };

    this.levelRafId = window.requestAnimationFrame(tick);
  }

  private stopLevelLoop(): void {
    if (this.levelRafId !== null) {
      window.cancelAnimationFrame(this.levelRafId);
      this.levelRafId = null;
    }
  }
}
