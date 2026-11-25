export const CAPTURE_SAMPLE_RATE = 16000;
export const CAPTURE_CHUNK_SAMPLES = 640; // 40ms at 16 kHz (down from 100ms)
export const PRE_ROLL_CHUNKS = 4; // 160ms pre-roll protecting soft speech onsets
export const SPEECH_HANGOVER_MS = 420;
export const STREAM_TAIL_MS = 280;

const MIN_SPEECH_RMS_THRESHOLD = 0.012;
const MAX_ADAPTIVE_THRESHOLD = 0.085;
const NOISE_FLOOR_MULTIPLIER = 2.4;

export interface SpeechGateAnalysis {
  rms: number;
  speechBandRms: number;
  speechRatio: number;
  envelopeCrest: number;
  isSpeechLikely: boolean;
  isMusicLikeStationary: boolean;
  shouldTransmitAudio: boolean;
  preRollChunks: Int16Array[];
}

export function computeSpeechBandMetrics(pcm: Int16Array): {
  rms: number;
  speechBandRms: number;
  speechRatio: number;
  zeroCrossingRate: number;
} {
  const n = pcm.length;
  if (n === 0) {
    return { rms: 0, speechBandRms: 0, speechRatio: 0, zeroCrossingRate: 0 };
  }

  // Lightweight 1-pole cascade approximating 300 Hz HPF + 3400 Hz LPF at 16 kHz
  const hpAlpha = 0.894; // ~300 Hz at 16 kHz
  const lpAlpha = 0.572; // ~3400 Hz at 16 kHz

  let sumSq = 0;
  let bandSq = 0;
  let hpState = 0;
  let prevRaw = 0;
  let lpState = 0;
  let zeroCrossings = 0;
  let prevSign = 0;

  for (let i = 0; i < n; i++) {
    const x = pcm[i] / 32768;
    sumSq += x * x;

    hpState = hpAlpha * (hpState + x - prevRaw);
    prevRaw = x;
    lpState = lpState + lpAlpha * (hpState - lpState);
    bandSq += lpState * lpState;

    const sign = lpState >= 0 ? 1 : -1;
    if (i > 0 && sign !== prevSign && Math.abs(lpState) > 0.004) {
      zeroCrossings += 1;
    }
    prevSign = sign;
  }

  const rms = Math.sqrt(sumSq / n);
  const speechBandRms = Math.sqrt(bandSq / n);
  const speechRatio = rms > 1e-5 ? speechBandRms / rms : 0;
  const zeroCrossingRate = zeroCrossings / n;

  return { rms, speechBandRms, speechRatio, zeroCrossingRate };
}

export class SpeechGate {
  private noiseFloorRms = 0.0045;
  private gateOpen = false;
  private lastSpeechAt = 0;
  private consecutiveSpeechChunks = 0;
  private recentRmsWindow: number[] = [];
  private preRoll: Int16Array[] = [];

  reset(): void {
    this.noiseFloorRms = 0.0045;
    this.gateOpen = false;
    this.lastSpeechAt = 0;
    this.consecutiveSpeechChunks = 0;
    this.recentRmsWindow = [];
    this.preRoll = [];
  }

  /**
   * Clears stale pre-mute energy windows and caps any elevated noise floor
   * so normal speech immediately after unmuting is never suppressed.
   */
  resetForUnmute(): void {
    this.noiseFloorRms = Math.min(this.noiseFloorRms, 0.0075);
    this.gateOpen = false;
    this.lastSpeechAt = 0;
    this.consecutiveSpeechChunks = 0;
    this.recentRmsWindow = [];
    this.preRoll = [];
  }

  isGateOpen(): boolean {
    return this.gateOpen;
  }

  getNoiseFloorRms(): number {
    return this.noiseFloorRms;
  }

  hasRecentSpeech(nowMs: number, windowMs = 1200): boolean {
    return (
      this.gateOpen ||
      (this.lastSpeechAt > 0 && nowMs - this.lastSpeechAt <= windowMs)
    );
  }

  processChunk(pcm: Int16Array, nowMs: number): SpeechGateAnalysis {
    const { rms, speechBandRms, speechRatio, zeroCrossingRate } =
      computeSpeechBandMetrics(pcm);

    // Track rolling RMS window (~640ms across 16 chunks of 40ms) to distinguish
    // stationary background noise / steady music plateaus from modulated human speech.
    this.recentRmsWindow.push(rms);
    if (this.recentRmsWindow.length > 16) {
      this.recentRmsWindow.shift();
    }

    let minRecent = rms;
    let maxRecent = rms;
    let sumRecent = 0;
    for (const val of this.recentRmsWindow) {
      if (val < minRecent) minRecent = val;
      if (val > maxRecent) maxRecent = val;
      sumRecent += val;
    }
    const avgRecent = sumRecent / Math.max(1, this.recentRmsWindow.length);
    const envelopeCrest = avgRecent > 1e-5 ? maxRecent / avgRecent : 1;
    const minToMaxRatio = maxRecent > 1e-5 ? minRecent / maxRecent : 1;

    // Steady ambient noise or continuous music fills the 640ms window with low valleys (>0.45 min/max)
    const isMusicLikeStationary =
      this.recentRmsWindow.length >= 10 &&
      minRecent > 0.014 &&
      minToMaxRatio > 0.45 &&
      envelopeCrest < 1.55;

    const dynamicThreshold = Math.min(
      MAX_ADAPTIVE_THRESHOLD,
      Math.max(MIN_SPEECH_RMS_THRESHOLD, this.noiseFloorRms * NOISE_FLOOR_MULTIPLIER)
    );

    const effectiveRms = Math.max(rms * 0.55, speechBandRms);
    const passesEnergy = effectiveRms >= dynamicThreshold || speechBandRms >= dynamicThreshold * 0.9;
    const passesVoiceSpectrum = speechRatio >= 0.34 && zeroCrossingRate <= 0.38;
    const passesModulation =
      !isMusicLikeStationary ||
      speechBandRms > Math.max(avgRecent * 1.25, this.noiseFloorRms * 2.2);

    const chunkLooksLikeSpeech =
      passesEnergy && passesVoiceSpectrum && passesModulation;

    let preRollChunks: Int16Array[] = [];

    if (chunkLooksLikeSpeech) {
      this.consecutiveSpeechChunks += 1;
      const strongBurst = effectiveRms >= dynamicThreshold * 1.45;
      if (this.gateOpen || this.consecutiveSpeechChunks >= 2 || strongBurst) {
        this.lastSpeechAt = nowMs;
        if (!this.gateOpen) {
          this.gateOpen = true;
          preRollChunks = this.preRoll;
          this.preRoll = [];
        }
      } else {
        this.pushPreRoll(pcm);
      }
    } else {
      this.consecutiveSpeechChunks = 0;
      const hangoverMs = isMusicLikeStationary ? 80 : SPEECH_HANGOVER_MS;
      if (this.gateOpen && nowMs - this.lastSpeechAt > hangoverMs) {
        this.gateOpen = false;
      }

      if (isMusicLikeStationary) {
        const targetSample = Math.min(avgRecent, MAX_ADAPTIVE_THRESHOLD * 0.55);
        this.noiseFloorRms = this.noiseFloorRms * 0.78 + targetSample * 0.22;
      }

      if (!this.gateOpen) {
        this.pushPreRoll(pcm);
        if (!isMusicLikeStationary) {
          const targetSample = Math.min(rms, MAX_ADAPTIVE_THRESHOLD * 0.55);
          this.noiseFloorRms = this.noiseFloorRms * 0.92 + targetSample * 0.08;
        }
      }
    }

    const inComfortTail =
      !this.gateOpen &&
      this.lastSpeechAt > 0 &&
      nowMs - this.lastSpeechAt <= SPEECH_HANGOVER_MS + STREAM_TAIL_MS;

    return {
      rms,
      speechBandRms,
      speechRatio,
      envelopeCrest,
      isSpeechLikely: this.gateOpen,
      isMusicLikeStationary,
      shouldTransmitAudio: this.gateOpen || inComfortTail,
      preRollChunks,
    };
  }

  private pushPreRoll(pcm: Int16Array): void {
    this.preRoll.push(pcm);
    if (this.preRoll.length > PRE_ROLL_CHUNKS) {
      this.preRoll.shift();
    }
  }
}

export function createSilenceChunk(samples = CAPTURE_CHUNK_SAMPLES): Int16Array {
  return new Int16Array(samples);
}
