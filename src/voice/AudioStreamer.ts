import {
  CAPTURE_CHUNK_SAMPLES,
  CAPTURE_SAMPLE_RATE,
  SpeechGate,
  createSilenceChunk,
} from "./SpeechGate";

const SPEECH_HOLD_MS = 460;
// 14 * 40ms = 560ms clean silence tail after speech stops, exceeding Gemini Live's 480ms VAD silenceDurationMs
export const SILENCE_TAIL_CHUNKS = 14;
const UNMUTE_PRIMER_CHUNKS = 3; // 120ms comfort-silence primer after long mute / audioStreamEnd
const UNMUTE_FRAME_HEARTBEAT_MS = 750;
const UNMUTE_STALE_FRAME_MS = 700;

const WORKLET_SOURCE = `
class Pcm16ResamplerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = ${CAPTURE_SAMPLE_RATE};
    this.step = sampleRate / this.targetRate;
    this.pos = 0;
    this.prevSample = 0;
    this.prevRaw = 0;
    this.hpState = 0;
    // ~85 Hz 1-pole high-pass filter to strip AC hum, handling thuds, and sub-bass rumble
    this.hpAlpha = Math.exp((-2 * Math.PI * 85) / sampleRate);
    this.lpState = 0;
    this.lpAlpha = this.step > 1.2
      ? 1 - Math.exp((-2 * Math.PI * 7200) / sampleRate)
      : 1;
    this.outBuffer = new Int16Array(${CAPTURE_CHUNK_SAMPLES});
    this.outIndex = 0;
    this.sumSquares = 0;
    this.rmsCount = 0;

    this.port.onmessage = (event) => {
      if (event.data && event.data.type === "flush") {
        if (this.outIndex > 0) {
          const slice = new Int16Array(this.outIndex);
          slice.set(this.outBuffer.subarray(0, this.outIndex));
          const rms = Math.sqrt(this.sumSquares / Math.max(1, this.rmsCount));
          this.port.postMessage(
            { pcmBuffer: slice.buffer, rms, flushed: true },
            [slice.buffer]
          );
          this.outIndex = 0;
          this.sumSquares = 0;
          this.rmsCount = 0;
        }
        this.port.postMessage({ type: "flushed" });
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) {
      return true;
    }

    const channel = input[0];
    const len = channel.length;

    const filtered = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const raw = channel[i];
      // High-pass sub-bass filter first, then anti-alias low-pass
      this.hpState = this.hpAlpha * (this.hpState + raw - this.prevRaw);
      this.prevRaw = raw;
      this.lpState += this.lpAlpha * (this.hpState - this.lpState);
      const hpOut = this.lpState;
      filtered[i] = hpOut;
      this.sumSquares += hpOut * hpOut;
      this.rmsCount++;
    }

    while (this.pos + 1 < len) {
      const idx = Math.floor(this.pos);
      const frac = this.pos - idx;
      const s0 = idx < 0 ? this.prevSample : filtered[idx];
      const s1 = filtered[idx + 1];
      const sample = s0 + (s1 - s0) * frac;
      const clamped = Math.max(-1, Math.min(1, sample));
      this.outBuffer[this.outIndex++] =
        clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);

      if (this.outIndex >= this.outBuffer.length) {
        const rms = Math.sqrt(this.sumSquares / Math.max(1, this.rmsCount));
        const copy = this.outBuffer.slice(0);
        this.port.postMessage(
          { pcmBuffer: copy.buffer, rms, flushed: false },
          [copy.buffer]
        );
        this.outIndex = 0;
        this.sumSquares = 0;
        this.rmsCount = 0;
      }

      this.pos += this.step;
    }

    this.pos -= len;
    this.prevSample = filtered[len - 1];
    return true;
  }
}

registerProcessor("pcm16-resampler-processor", Pcm16ResamplerProcessor);
`;

function int16ToLittleEndianBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export interface AudioStreamerCallbacks {
  onAudioChunk: (base64Pcm16: string) => void;
  onLevel: (level: number) => void;
  onSpeechStateChange: (speaking: boolean) => void;
  onFrameMetric?: (kind: "transmitted" | "suppressed") => void;
  onError: (message: string) => void;
}

export class AudioStreamer {
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private scriptProcessor: ScriptProcessorNode | null = null;
  private silentGain: GainNode | null = null;

  private muted = false;
  private flushingForMute = false;
  private muteEpoch = 0;
  private active = false;
  private speaking = false;
  private silenceTimer: number | null = null;
  private unmuteVerifyTimer: number | null = null;
  private flushResolve: (() => void) | null = null;
  private wasTransmittingAudio = false;
  private silenceTailRemaining = 0;
  private lastAudioFrameAt = 0;
  private trackMutedBySystem = false;
  private recoveringPromise: Promise<boolean> | null = null;

  private readonly speechGate = new SpeechGate();

  // Fallback resampler state when AudioWorklet is unavailable
  private fallbackPos = 0;
  private fallbackPrev = 0;
  private fallbackPrevRaw = 0;
  private fallbackHp = 0;
  private fallbackLp = 0;
  private fallbackSamples: number[] = [];

  private readonly callbacks: AudioStreamerCallbacks;

  constructor(callbacks: AudioStreamerCallbacks) {
    this.callbacks = callbacks;
  }

  async start(): Promise<void> {
    if (this.active) return;

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        "Microphone capture is not supported in this browser or requires a secure HTTPS connection."
      );
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    } catch (err) {
      throw new Error(this.formatPermissionError(err));
    }

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;

    if (!AudioCtx) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error("Web Audio API is not supported in this browser.");
    }

    const ctx = new AudioCtx();
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        stream.getTracks().forEach((t) => t.stop());
        await ctx.close().catch(() => undefined);
        throw new Error(
          "Audio capture was blocked by the browser. Tap Connect again to allow microphone audio."
        );
      }
    }

    const track = stream.getAudioTracks()[0];
    if (!track || track.readyState !== "live") {
      stream.getTracks().forEach((t) => t.stop());
      await ctx.close().catch(() => undefined);
      throw new Error("No active microphone input track is available.");
    }

    this.trackMutedBySystem = track.muted === true;
    track.addEventListener("mute", () => {
      if (this.mediaStream === stream) {
        this.trackMutedBySystem = true;
      }
    });
    track.addEventListener("unmute", () => {
      if (this.mediaStream === stream) {
        this.trackMutedBySystem = false;
      }
    });
    track.addEventListener("ended", () => {
      if (this.active && this.mediaStream === stream) {
        this.stop();
        this.callbacks.onError(
          "Microphone access ended unexpectedly. Check your device microphone and reconnect."
        );
      }
    });

    this.mediaStream = stream;
    this.audioContext = ctx;
    this.sourceNode = ctx.createMediaStreamSource(stream);
    this.silentGain = ctx.createGain();
    this.silentGain.gain.value = 0;
    this.speechGate.reset();
    this.wasTransmittingAudio = false;
    this.silenceTailRemaining = 0;
    this.lastAudioFrameAt = Date.now();

    try {
      if (ctx.audioWorklet && typeof AudioWorkletNode !== "undefined") {
        await this.setupWorklet(ctx);
      } else {
        this.setupScriptProcessor(ctx);
      }
    } catch {
      this.setupScriptProcessor(ctx);
    }

    this.active = true;
  }

  /**
   * Synchronously disables live speech input after first flushing any buffered partial
   * syllables in the AudioWorklet/ScriptProcessor and appending clean comfort silence
   * so rapid mute-after-speaking never truncates the user's final words.
   */
  async flushAndMute(): Promise<{ hadRecentSpeech: boolean }> {
    const epoch = ++this.muteEpoch;
    const now = Date.now();
    const hadRecentSpeech =
      this.speaking || this.speechGate.hasRecentSpeech(now, 1400);

    if (!this.active || this.muted) {
      this.setMuted(true);
      return { hadRecentSpeech: false };
    }

    if (this.silenceTimer !== null) {
      window.clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    this.clearUnmuteVerifyTimer();

    this.flushingForMute = true;

    if (this.workletNode) {
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          if (this.flushResolve === finish) {
            this.flushResolve = null;
          }
          resolve();
        };
        this.flushResolve = finish;
        window.setTimeout(finish, 35);
        try {
          this.workletNode?.port.postMessage({ type: "flush" });
        } catch {
          finish();
        }
      });
    } else if (this.fallbackSamples.length > 0) {
      const slice = new Int16Array(this.fallbackSamples.splice(0));
      this.handleProcessedChunk(slice, 0.02, true);
    }

    // Abort muting cleanly if user tapped Unmute mid-flush
    if (epoch !== this.muteEpoch || !this.active) {
      this.flushingForMute = false;
      return { hadRecentSpeech: false };
    }

    if (hadRecentSpeech) {
      // Emit 2 brief 40ms comfort silence chunks so Gemini Live sees clean acoustic silence before audioStreamEnd
      const silenceB64 = int16ToLittleEndianBase64(createSilenceChunk());
      this.callbacks.onAudioChunk(silenceB64);
      this.callbacks.onAudioChunk(silenceB64);
    }

    this.flushingForMute = false;
    this.setMuted(true);
    return { hadRecentSpeech };
  }

  /**
   * Unmutes and verifies capture health, resuming suspended AudioContexts, resetting
   * post-mute SpeechGate statistics, emitting comfort-silence primers, and scheduling a
   * 750ms frame-heartbeat check that transparently recovers stalled audio tracks.
   */
  async ensureActiveAndUnmute(): Promise<boolean> {
    const epoch = ++this.muteEpoch;
    this.flushingForMute = false;
    this.muted = false;
    this.wasTransmittingAudio = false;
    this.silenceTailRemaining = 0;
    this.speechGate.resetForUnmute();
    this.clearUnmuteVerifyTimer();

    if (this.silenceTimer !== null) {
      window.clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }

    if (this.mediaStream) {
      for (const track of this.mediaStream.getAudioTracks()) {
        if (track.readyState === "live") {
          track.enabled = true;
        }
      }
    }

    if (this.audioContext && this.audioContext.state !== "running") {
      try {
        await this.audioContext.resume();
      } catch {
        // Will trigger capture recovery check below
      }
    }

    if (epoch !== this.muteEpoch || this.muted) {
      return false;
    }

    if (!this.isHealthy()) {
      const recovered = await this.recoverCapture();
      if (!recovered || epoch !== this.muteEpoch || this.muted) {
        return false;
      }
    }

    this.emitUnmutePrimer();
    this.scheduleUnmuteHeartbeatCheck(epoch);
    return true;
  }

  setMuted(muted: boolean): void {
    const epoch = ++this.muteEpoch;
    this.flushingForMute = false;
    this.muted = muted;
    if (this.silenceTimer !== null) {
      window.clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    this.clearUnmuteVerifyTimer();

    if (muted) {
      // Keep the underlying MediaStreamTrack enabled (software mute) so browser/OS/Bluetooth
      // audio pipelines don't suspend or drop the capture device during 10-30s muted pauses.
      // Audio emission, level meters, and speech detection remain strictly gated by this.muted.
      this.wasTransmittingAudio = false;
      this.silenceTailRemaining = 0;
      this.callbacks.onLevel(0);
      this.setSpeaking(false);
    } else {
      this.wasTransmittingAudio = false;
      this.silenceTailRemaining = 0;
      this.speechGate.resetForUnmute();
      if (this.mediaStream) {
        for (const track of this.mediaStream.getAudioTracks()) {
          if (track.readyState === "live") {
            track.enabled = true;
          }
        }
      }
      if (this.audioContext && this.audioContext.state !== "running") {
        void this.audioContext.resume().catch(() => undefined);
      }
      this.emitUnmutePrimer();
      this.scheduleUnmuteHeartbeatCheck(epoch);
    }
  }

  isMuted(): boolean {
    return this.muted;
  }

  isActive(): boolean {
    return this.active;
  }

  isHealthy(): boolean {
    if (!this.active || !this.mediaStream || !this.audioContext) {
      return false;
    }
    if (this.audioContext.state !== "running") {
      return false;
    }
    if (this.trackMutedBySystem) {
      return false;
    }
    const tracks = this.mediaStream.getAudioTracks();
    const liveTrack = tracks.find((t) => t.readyState === "live" && t.enabled);
    return Boolean(liveTrack);
  }

  getLastAudioFrameAt(): number {
    return this.lastAudioFrameAt;
  }

  stop(): void {
    this.active = false;
    this.flushingForMute = false;
    this.muteEpoch += 1;
    this.setSpeaking(false);
    this.flushResolve?.();
    this.flushResolve = null;
    this.clearUnmuteVerifyTimer();

    if (this.silenceTimer !== null) {
      window.clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }

    this.teardownGraphAndStream();

    this.fallbackPos = 0;
    this.fallbackPrev = 0;
    this.fallbackPrevRaw = 0;
    this.fallbackHp = 0;
    this.fallbackLp = 0;
    this.fallbackSamples = [];
    this.wasTransmittingAudio = false;
    this.silenceTailRemaining = 0;
    this.lastAudioFrameAt = 0;
    this.trackMutedBySystem = false;
    this.speechGate.reset();
    this.callbacks.onLevel(0);
  }

  private emitUnmutePrimer(): void {
    if (!this.active || this.muted) return;
    const silenceB64 = int16ToLittleEndianBase64(createSilenceChunk());
    for (let i = 0; i < UNMUTE_PRIMER_CHUNKS; i++) {
      this.callbacks.onAudioChunk(silenceB64);
    }
  }

  private scheduleUnmuteHeartbeatCheck(epoch: number): void {
    this.clearUnmuteVerifyTimer();
    if (typeof window === "undefined" || !this.active || this.muted) return;
    this.unmuteVerifyTimer = window.setTimeout(() => {
      this.unmuteVerifyTimer = null;
      if (epoch !== this.muteEpoch || !this.active || this.muted) {
        return;
      }
      const frameAgeMs =
        this.lastAudioFrameAt > 0
          ? Date.now() - this.lastAudioFrameAt
          : Number.POSITIVE_INFINITY;
      if (frameAgeMs > UNMUTE_STALE_FRAME_MS || !this.isHealthy()) {
        void this.recoverCapture();
      }
    }, UNMUTE_FRAME_HEARTBEAT_MS);
  }

  private clearUnmuteVerifyTimer(): void {
    if (this.unmuteVerifyTimer !== null && typeof window !== "undefined") {
      window.clearTimeout(this.unmuteVerifyTimer);
      this.unmuteVerifyTimer = null;
    }
  }

  private async recoverCapture(): Promise<boolean> {
    if (this.recoveringPromise) {
      return this.recoveringPromise;
    }
    const preserveMuted = this.muted;
    this.recoveringPromise = (async () => {
      try {
        this.active = false;
        this.teardownGraphAndStream();
        await this.start();
        this.muted = preserveMuted;
        if (!preserveMuted) {
          this.speechGate.resetForUnmute();
          this.emitUnmutePrimer();
        }
        return true;
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : "Microphone capture stopped responding. Please reconnect.";
        this.stop();
        this.callbacks.onError(message);
        return false;
      } finally {
        this.recoveringPromise = null;
      }
    })();
    return this.recoveringPromise;
  }

  private teardownGraphAndStream(): void {
    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      this.workletNode.disconnect();
      this.workletNode = null;
    }

    if (this.scriptProcessor) {
      this.scriptProcessor.onaudioprocess = null;
      this.scriptProcessor.disconnect();
      this.scriptProcessor = null;
    }

    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    if (this.silentGain) {
      this.silentGain.disconnect();
      this.silentGain = null;
    }

    if (this.mediaStream) {
      for (const track of this.mediaStream.getAudioTracks()) {
        track.stop();
      }
      this.mediaStream = null;
    }

    if (this.audioContext) {
      const ctx = this.audioContext;
      this.audioContext = null;
      ctx.close().catch(() => undefined);
    }
  }

  private async setupWorklet(ctx: AudioContext): Promise<void> {
    if (!this.sourceNode || !this.silentGain) return;

    const blob = new Blob([WORKLET_SOURCE], {
      type: "application/javascript",
    });
    const url = URL.createObjectURL(blob);

    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    const worklet = new AudioWorkletNode(ctx, "pcm16-resampler-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
    });

    worklet.port.onmessage = (
      event: MessageEvent<{
        type?: string;
        pcmBuffer?: ArrayBuffer;
        rms?: number;
        flushed?: boolean;
      }>
    ) => {
      if (event.data.type === "flushed") {
        this.flushResolve?.();
        return;
      }
      if (!this.active) return;
      this.lastAudioFrameAt = Date.now();
      if (this.muted && !this.flushingForMute) return;
      if (!event.data.pcmBuffer) return;
      const pcm = new Int16Array(event.data.pcmBuffer);
      this.handleProcessedChunk(pcm, event.data.rms ?? 0, Boolean(event.data.flushed));
    };

    this.sourceNode.connect(worklet);
    worklet.connect(this.silentGain);
    this.silentGain.connect(ctx.destination);
    this.workletNode = worklet;
  }

  private setupScriptProcessor(ctx: AudioContext): void {
    if (!this.sourceNode || !this.silentGain) return;

    const processor = ctx.createScriptProcessor(2048, 1, 1);
    const srcRate = ctx.sampleRate;
    const step = srcRate / CAPTURE_SAMPLE_RATE;
    const hpAlpha = Math.exp((-2 * Math.PI * 85) / srcRate);
    const lpAlpha =
      step > 1.2 ? 1 - Math.exp((-2 * Math.PI * 7200) / srcRate) : 1;

    this.fallbackPos = 0;
    this.fallbackPrev = 0;
    this.fallbackPrevRaw = 0;
    this.fallbackHp = 0;
    this.fallbackLp = 0;
    this.fallbackSamples = [];

    processor.onaudioprocess = (event: AudioProcessingEvent) => {
      if (!this.active) return;
      this.lastAudioFrameAt = Date.now();
      if (this.muted && !this.flushingForMute) return;
      const input = event.inputBuffer.getChannelData(0);
      const len = input.length;
      if (len === 0) return;

      const filtered = new Float32Array(len);
      let sumSquares = 0;
      for (let i = 0; i < len; i++) {
        const raw = input[i];
        this.fallbackHp = hpAlpha * (this.fallbackHp + raw - this.fallbackPrevRaw);
        this.fallbackPrevRaw = raw;
        this.fallbackLp += lpAlpha * (this.fallbackHp - this.fallbackLp);
        const s = this.fallbackLp;
        filtered[i] = s;
        sumSquares += s * s;
      }

      while (this.fallbackPos + 1 < len) {
        const idx = Math.floor(this.fallbackPos);
        const frac = this.fallbackPos - idx;
        const s0 = idx < 0 ? this.fallbackPrev : filtered[idx];
        const s1 = filtered[idx + 1];
        const sample = s0 + (s1 - s0) * frac;
        const clamped = Math.max(-1, Math.min(1, sample));
        this.fallbackSamples.push(
          clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767)
        );
        this.fallbackPos += step;
      }

      this.fallbackPos -= len;
      this.fallbackPrev = filtered[len - 1];

      const rms = Math.sqrt(sumSquares / len);
      while (this.fallbackSamples.length >= CAPTURE_CHUNK_SAMPLES) {
        const chunk = this.fallbackSamples.splice(0, CAPTURE_CHUNK_SAMPLES);
        this.handleProcessedChunk(new Int16Array(chunk), rms, false);
      }
    };

    this.sourceNode.connect(processor);
    processor.connect(this.silentGain);
    this.silentGain.connect(ctx.destination);
    this.scriptProcessor = processor;
  }

  private handleProcessedChunk(
    pcm: Int16Array,
    rawRms: number,
    isFlushedTail: boolean
  ): void {
    const now = Date.now();

    if (isFlushedTail && this.flushingForMute) {
      if (
        pcm.length > 0 &&
        (this.speaking || this.speechGate.hasRecentSpeech(now) || rawRms >= 0.006)
      ) {
        this.callbacks.onFrameMetric?.("transmitted");
        this.callbacks.onAudioChunk(int16ToLittleEndianBase64(pcm));
      }
      return;
    }

    const analysis = this.speechGate.processChunk(pcm, now);
    const normalizedLevel = Math.min(1, Math.max(rawRms, analysis.speechBandRms) * 6.5);
    this.callbacks.onLevel(analysis.isSpeechLikely ? normalizedLevel : normalizedLevel * 0.25);

    if (analysis.isSpeechLikely) {
      if (!this.speaking) {
        this.setSpeaking(true);
      }
      if (this.silenceTimer !== null) {
        window.clearTimeout(this.silenceTimer);
      }
      this.silenceTimer = window.setTimeout(() => {
        if (!this.speechGate.isGateOpen()) {
          this.setSpeaking(false);
        }
      }, SPEECH_HOLD_MS);
    } else if (this.speaking && !this.speechGate.isGateOpen()) {
      this.setSpeaking(false);
    }

    if (analysis.shouldTransmitAudio) {
      this.wasTransmittingAudio = true;
      this.silenceTailRemaining = SILENCE_TAIL_CHUNKS; // 560ms clean silence padding > 480ms server VAD threshold
      for (const preChunk of analysis.preRollChunks) {
        this.callbacks.onFrameMetric?.("transmitted");
        this.callbacks.onAudioChunk(int16ToLittleEndianBase64(preChunk));
      }
      this.callbacks.onFrameMetric?.("transmitted");
      this.callbacks.onAudioChunk(int16ToLittleEndianBase64(pcm));
    } else if (this.wasTransmittingAudio && this.silenceTailRemaining > 0) {
      // Emit clean silence chunks right after hangover so Gemini Live VAD triggers end-of-speech
      // promptly even if fan noise or music is present in the room.
      this.silenceTailRemaining -= 1;
      if (this.silenceTailRemaining === 0) {
        this.wasTransmittingAudio = false;
      }
      this.callbacks.onAudioChunk(int16ToLittleEndianBase64(createSilenceChunk()));
    } else {
      this.callbacks.onFrameMetric?.("suppressed");
    }
  }

  private setSpeaking(next: boolean): void {
    if (this.speaking === next) return;
    this.speaking = next;
    this.callbacks.onSpeechStateChange(next);
  }

  private formatPermissionError(err: unknown): string {
    if (err instanceof DOMException) {
      if (
        err.name === "NotAllowedError" ||
        err.name === "PermissionDeniedError"
      ) {
        return "Microphone permission was denied. Allow microphone access in your browser settings and try again.";
      }
      if (
        err.name === "NotFoundError" ||
        err.name === "DevicesNotFoundError"
      ) {
        return "No microphone was found on this device. Connect a microphone and try again.";
      }
      if (
        err.name === "NotReadableError" ||
        err.name === "TrackStartError"
      ) {
        return "Your microphone is currently in use by another application.";
      }
    }
    return err instanceof Error
      ? err.message
      : "Unable to access the device microphone.";
  }
}
