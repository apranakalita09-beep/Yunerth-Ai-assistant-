import assert from "node:assert/strict";
import { AudioDiagnosticsTracker } from "./src/voice/AudioDiagnostics.ts";
import { AudioPlayer } from "./src/voice/AudioPlayer.ts";
import { AudioStreamer, SILENCE_TAIL_CHUNKS } from "./src/voice/AudioStreamer.ts";
import { LiveSession } from "./src/voice/LiveSession.ts";
import {
  CAPTURE_CHUNK_SAMPLES,
  CAPTURE_SAMPLE_RATE,
  SpeechGate,
  createSilenceChunk,
} from "./src/voice/SpeechGate.ts";
import { StateManager } from "./src/voice/StateManager.ts";
import { ConversationFlowController } from "./conversationFlow.ts";

function makeSineChordChunk(
  freqs: number[],
  amplitude: number,
  phaseOffset = 0
): Int16Array {
  const out = new Int16Array(CAPTURE_CHUNK_SAMPLES);
  for (let i = 0; i < out.length; i++) {
    const t = (i + phaseOffset) / CAPTURE_SAMPLE_RATE;
    let sum = 0;
    for (const f of freqs) {
      sum += Math.sin(2 * Math.PI * f * t);
    }
    const val = (sum / freqs.length) * amplitude;
    out[i] = Math.max(-32767, Math.min(32767, Math.round(val * 32767)));
  }
  return out;
}

function makePseudoNoiseChunk(amplitude: number, seedStart = 1): Int16Array {
  const out = new Int16Array(CAPTURE_CHUNK_SAMPLES);
  let x = seedStart;
  for (let i = 0; i < out.length; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    const white = (x / 0xffffffff) * 2 - 1;
    out[i] = Math.round(white * amplitude * 32767);
  }
  return out;
}

function makeFloat32SineSpeech(sampleCount: number, sampleRate: number): Float32Array {
  const out = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const t = i / sampleRate;
    out[i] =
      0.11 * Math.sin(2 * Math.PI * 520 * t) +
      0.08 * Math.sin(2 * Math.PI * 1040 * t) +
      0.05 * Math.sin(2 * Math.PI * 1620 * t);
  }
  return out;
}

function pcm16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return Buffer.from(bin, "binary").toString("base64");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =========================================================================
// EXISTING BASELINE CHECKS: SPEED, STATE MACHINE & NOISE GATE
// =========================================================================
assert.equal(CAPTURE_CHUNK_SAMPLES, 640);
assert.ok(
  SILENCE_TAIL_CHUNKS * 40 > 480,
  "Silence tail duration must exceed Gemini Live's 480ms VAD silence threshold"
);

{
  const diag = new AudioDiagnosticsTracker();
  diag.markUserSpeechCompleted(true, 1000);
  diag.markServerTurnCommitted(1220);
  diag.markFirstResponseAudioReceived(1460);
  const sample = diag.markPlaybackStarted(1475);

  assert.ok(sample);
  assert.equal(sample.speechEndToTurnMs, 220);
  assert.equal(sample.turnToFirstAudioMs, 240);
  assert.equal(sample.firstAudioToPlaybackMs, 15);
  assert.equal(sample.totalResponseLatencyMs, 475);
  assert.equal(sample.viaMuteFlush, true);
}

{
  // SpeechGate ambient discrimination checks
  const g1 = new SpeechGate();
  let t = 1000;
  for (let i = 0; i < 20; i++) {
    const res = g1.processChunk(createSilenceChunk(), (t += 40));
    assert.equal(res.isSpeechLikely, false);
    assert.equal(res.shouldTransmitAudio, false);
  }

  const g2 = new SpeechGate();
  t = 1000;
  for (let i = 0; i < 25; i++) {
    const rumble = makeSineChordChunk([60, 90], 0.02, i * CAPTURE_CHUNK_SAMPLES);
    const res = g2.processChunk(rumble, (t += 40));
    assert.equal(res.isSpeechLikely, false);
  }

  const g3 = new SpeechGate();
  t = 1000;
  let fanTriggers = 0;
  for (let i = 0; i < 30; i++) {
    const fan = makePseudoNoiseChunk(0.045, i + 1);
    const res = g3.processChunk(fan, (t += 40));
    if (i >= 12 && res.isSpeechLikely) fanTriggers += 1;
  }
  assert.equal(fanTriggers, 0);

  const g4 = new SpeechGate();
  t = 1000;
  let musicFalseTriggers = 0;
  for (let i = 0; i < 35; i++) {
    const music = makeSineChordChunk(
      [261.6, 329.6, 392.0, 523.2],
      0.04,
      i * CAPTURE_CHUNK_SAMPLES
    );
    const res = g4.processChunk(music, (t += 40));
    if (i >= 14 && res.isSpeechLikely) musicFalseTriggers += 1;
  }
  assert.equal(musicFalseTriggers, 0);
}

// =========================================================================
// BROWSER AUDIO & WEBSOCKET HARNESS FOR END-TO-END RELIABILITY SCENARIOS
// =========================================================================
interface FakeTrack {
  readyState: "live" | "ended";
  enabled: boolean;
  muted: boolean;
  listeners: Record<string, Array<() => void>>;
  addEventListener: (ev: string, fn: () => void) => void;
  stop: () => void;
  emit: (ev: string) => void;
}

class FakeAudioContext {
  sampleRate = 16000;
  currentTime = 0;
  state: "running" | "suspended" | "closed" = "running";
  destination = {};
  audioWorklet = undefined;
  lastProcessor: {
    onaudioprocess: ((ev: unknown) => void) | null;
    connect: () => void;
    disconnect: () => void;
  } | null = null;
  lastSources: Array<{
    onended: (() => void) | null;
    started: boolean;
    stopped: boolean;
    dropOnEnded?: boolean;
  }> = [];
  failResume = false;

  createMediaStreamSource() {
    return { connect: () => {}, disconnect: () => {} };
  }
  createAnalyser() {
    return {
      fftSize: 256,
      smoothingTimeConstant: 0.72,
      frequencyBinCount: 128,
      connect: () => {},
      disconnect: () => {},
      getByteTimeDomainData: (arr: Uint8Array) => {
        arr.fill(128);
      },
    };
  }
  createGain() {
    return {
      gain: { value: 1 },
      connect: () => {},
      disconnect: () => {},
    };
  }
  createScriptProcessor() {
    const proc = {
      onaudioprocess: null as ((ev: unknown) => void) | null,
      connect: () => {},
      disconnect: () => {},
    };
    this.lastProcessor = proc;
    return proc;
  }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    const channelData = new Float32Array(length);
    return {
      duration: length / sampleRate,
      getChannelData: () => channelData,
    };
  }
  createBufferSource() {
    const src = {
      buffer: null as { duration: number } | null,
      onended: null as (() => void) | null,
      started: false,
      stopped: false,
      dropOnEnded: false,
      connect: () => {},
      disconnect: () => {},
      start: () => {
        src.started = true;
      },
      stop: () => {
        if (src.stopped) return;
        src.stopped = true;
        if (!src.dropOnEnded) {
          queueMicrotask(() => src.onended?.());
        }
      },
    };
    this.lastSources.push(src);
    return src;
  }
  async resume() {
    if (this.failResume) {
      throw new Error("Autoplay locked");
    }
    this.state = "running";
  }
  async close() {
    this.state = "closed";
  }
  emitMicFrame(samples: Float32Array) {
    this.lastProcessor?.onaudioprocess?.({
      inputBuffer: {
        getChannelData: () => samples,
      },
    });
  }
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { reason: string; code: number }) => void) | null = null;
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(raw: string) {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error("Socket not open");
    }
    this.sent.push(JSON.parse(raw));
  }

  close(code = 1000, reason = "") {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    queueMicrotask(() => this.onclose?.({ code, reason }));
  }

  simulateOpenAndReady() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
    this.onmessage?.({ data: JSON.stringify({ type: "ready" }) });
  }

  simulateServerEvent(payload: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

async function runAllTests() {
  const createdTracks: FakeTrack[] = [];
  const createdContexts: FakeAudioContext[] = [];
  let getUserMediaBehavior: "ok" | "not_allowed" = "ok";

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { protocol: "http:", host: "127.0.0.1:3000" },
      AudioContext: class extends FakeAudioContext {
        constructor() {
          super();
          createdContexts.push(this);
        }
      },
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
      requestAnimationFrame: (fn: FrameRequestCallback) =>
        globalThis.setTimeout(() => fn(Date.now()), 16) as unknown as number,
      cancelAnimationFrame: (id: number) => globalThis.clearTimeout(id),
    },
  });

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => {
          if (getUserMediaBehavior === "not_allowed") {
            const err = new Error("Permission denied");
            err.name = "NotAllowedError";
            Object.setPrototypeOf(err, DOMException.prototype);
            throw err;
          }
          const track: FakeTrack = {
            readyState: "live",
            enabled: true,
            muted: false,
            listeners: {},
            addEventListener: (ev, fn) => {
              track.listeners[ev] ||= [];
              track.listeners[ev].push(fn);
            },
            stop: () => {
              track.readyState = "ended";
            },
            emit: (ev) => {
              for (const fn of track.listeners[ev] ?? []) fn();
            },
          };
          createdTracks.push(track);
          return {
            getTracks: () => [track],
            getAudioTracks: () => [track],
          };
        },
      },
    },
  });

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeWebSocket,
  });

  // =========================================================================
  // SCENARIO 1: Startup + Simple Question (Player Unlock, LiveSession Ready, Audio Output)
  // =========================================================================
  {
    const sm = new StateManager();
    const sentChunks: string[] = [];
    const playbackEvents: string[] = [];
    const player = new AudioPlayer({
      onPlaybackStart: () => {
        playbackEvents.push("start");
        sm.setPlayingAudio(true);
      },
      onPlaybackEnd: () => {
        playbackEvents.push("end");
        sm.setPlayingAudio(false);
      },
      onLevel: () => {},
    });

    await player.unlock();
    const streamer = new AudioStreamer({
      onAudioChunk: (b64) => sentChunks.push(b64),
      onLevel: () => {},
      onSpeechStateChange: (s) => sm.setUserSpeaking(s),
      onError: (msg) => sm.setError(msg),
    });
    const session = new LiveSession({
      onReady: () => {
        sm.setSessionOpen(true);
        sm.setMicActive(streamer.isActive());
      },
      onAudio: (b64) => void player.enqueuePcm16Base64(b64),
      onInterrupted: () => {
        player.clear();
        sm.onInterrupted();
      },
      onTurnComplete: () => sm.onTurnComplete(),
      onError: (msg) => sm.setError(msg),
      onClose: () => {},
    });

    sm.setConnecting();
    await streamer.start();
    const connectPromise = session.connect();
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.simulateOpenAndReady();
    await connectPromise;
    assert.equal(sm.getSnapshot().state, "LISTENING");

    // Speak first question
    const captureCtx = createdContexts.at(-1)!;
    const speechFrame = makeFloat32SineSpeech(640, 16000);
    for (let i = 0; i < 6; i++) {
      captureCtx.emitMicFrame(speechFrame);
    }
    assert.equal(sm.getSnapshot().state, "USER SPEAKING");
    for (const chunk of sentChunks) session.sendAudio(chunk);
    assert.ok(
      ws.sent.some((m) => m.type === "audio"),
      "First question audio must reach LiveSession"
    );

    // Server returns audio -> AudioPlayer plays -> turn completes -> LISTENING
    ws.simulateServerEvent({
      type: "audio",
      data: pcm16ToBase64(makeSineChordChunk([440], 0.15)),
    });
    await sleep(25);
    assert.equal(sm.getSnapshot().state, "SPEAKING");
    assert.deepEqual(playbackEvents, ["start"]);
    createdContexts[0].lastSources.at(-1)?.onended?.();
    ws.simulateServerEvent({ type: "turnComplete" });
    assert.equal(sm.getSnapshot().state, "LISTENING");

    streamer.stop();
    session.close();
    await player.dispose();
  }

  // =========================================================================
  // SCENARIO 2: 5 Consecutive Turns With 560ms Silence Tails (> 480ms VAD)
  // =========================================================================
  {
    let chunks: string[] = [];
    const streamer = new AudioStreamer({
      onAudioChunk: (b64) => chunks.push(b64),
      onLevel: () => {},
      onSpeechStateChange: () => {},
      onError: (msg) => assert.fail(`Unexpected error: ${msg}`),
    });
    await streamer.start();
    const ctx = createdContexts.at(-1)!;
    const speech = makeFloat32SineSpeech(640, 16000);
    const silence = new Float32Array(640);

    for (let turn = 0; turn < 5; turn++) {
      chunks = [];
      for (let i = 0; i < 5; i++) ctx.emitMicFrame(speech);
      const speechCount = chunks.length;
      assert.ok(speechCount >= 1, `Turn ${turn + 1} should emit speech chunks`);

      // Feed 25 silence frames (~1000ms) after speech stops
      for (let i = 0; i < 25; i++) ctx.emitMicFrame(silence);
      const tailAndHangoverChunks = chunks.length - speechCount;
      assert.ok(
        tailAndHangoverChunks >= SILENCE_TAIL_CHUNKS,
        `Turn ${turn + 1} must emit >= ${SILENCE_TAIL_CHUNKS} (560ms) silence tail chunks`
      );
      await sleep(30);
    }
    streamer.stop();
  }

  // =========================================================================
  // SCENARIO 3: Mute + Wait (~10s Equivalent Idle) + Unmute + SpeechGate Reset
  // =========================================================================
  {
    const chunks: string[] = [];
    const streamer = new AudioStreamer({
      onAudioChunk: (b64) => chunks.push(b64),
      onLevel: () => {},
      onSpeechStateChange: () => {},
      onError: (msg) => assert.fail(`Unexpected error: ${msg}`),
    });
    await streamer.start();
    const ctx = createdContexts.at(-1)!;
    const track = createdTracks.at(-1)!;

    // Warm up ambient noise before mute
    for (let i = 0; i < 12; i++) {
      ctx.emitMicFrame(makeFloat32SineSpeech(640, 16000).map((v) => v * 0.4));
    }

    await streamer.flushAndMute();
    assert.equal(streamer.isMuted(), true);
    assert.equal(
      track.enabled,
      true,
      "Software mute must keep hardware MediaStreamTrack enabled to prevent driver sleep"
    );

    const beforeMutedCount = chunks.length;
    // Simulate 250 frames (~10s) arriving during mute — zero chunks may leak out
    for (let i = 0; i < 250; i++) {
      ctx.emitMicFrame(makeFloat32SineSpeech(640, 16000));
    }
    assert.equal(
      chunks.length,
      beforeMutedCount,
      "No audio chunks may transmit while muted"
    );

    // Unmute -> resets SpeechGate, resumes context, emits 3 comfort-silence primers
    const ok = await streamer.ensureActiveAndUnmute();
    assert.equal(ok, true);
    assert.equal(streamer.isMuted(), false);
    assert.ok(
      chunks.length >= beforeMutedCount + 3,
      "Unmute should emit brief 120ms silence primer chunks"
    );

    // Immediate moderate speech after unmute must trigger capture immediately
    const postUnmuteBefore = chunks.length;
    for (let i = 0; i < 4; i++) {
      ctx.emitMicFrame(makeFloat32SineSpeech(640, 16000));
    }
    assert.ok(
      chunks.length > postUnmuteBefore,
      "Speech immediately after unmute must transmit reliably"
    );
    streamer.stop();
  }

  // =========================================================================
  // SCENARIO 4: Mute + 30s Simulated Stalled AudioContext/Track -> Auto Capture Recovery
  // =========================================================================
  {
    const errors: string[] = [];
    const chunks: string[] = [];
    const streamer = new AudioStreamer({
      onAudioChunk: (b64) => chunks.push(b64),
      onLevel: () => {},
      onSpeechStateChange: () => {},
      onError: (msg) => errors.push(msg),
    });
    await streamer.start();
    const initialCtx = createdContexts.at(-1)!;
    const initialTrack = createdTracks.at(-1)!;

    await streamer.flushAndMute();
    // Simulate 30s sleep breaking the old track & suspending old AudioContext
    initialCtx.state = "suspended";
    initialTrack.readyState = "ended";

    const recovered = await streamer.ensureActiveAndUnmute();
    assert.equal(recovered, true, "Unmute must auto-recover a stalled/ended track");
    assert.equal(errors.length, 0, "Transparent recovery must not fail the session");
    assert.equal(streamer.isHealthy(), true);

    const newCtx = createdContexts.at(-1)!;
    assert.notEqual(newCtx, initialCtx, "Recovery should allocate a fresh active AudioContext");
    const preChunks = chunks.length;
    for (let i = 0; i < 4; i++) {
      newCtx.emitMicFrame(makeFloat32SineSpeech(640, 16000));
    }
    assert.ok(chunks.length > preChunks, "Recovered capture must emit speech chunks");
    streamer.stop();
  }

  // =========================================================================
  // SCENARIO 5: 10x Mute/Unmute Cycles + Rapid flushAndMute() vs Unmute Race Check
  // =========================================================================
  {
    const chunks: string[] = [];
    const sm = new StateManager();
    const streamer = new AudioStreamer({
      onAudioChunk: (b64) => chunks.push(b64),
      onLevel: () => {},
      onSpeechStateChange: (s) => sm.setUserSpeaking(s),
      onError: (msg) => assert.fail(`Unexpected error: ${msg}`),
    });
    await streamer.start();
    sm.setSessionOpen(true);
    sm.setMicActive(true);
    const ctx = createdContexts.at(-1)!;

    for (let cycle = 0; cycle < 10; cycle++) {
      // Rapid race: initiate flushAndMute(), immediately cancel with ensureActiveAndUnmute()
      const flushPromise = streamer.flushAndMute();
      const unmuteOk = await streamer.ensureActiveAndUnmute();
      await flushPromise;
      assert.equal(unmuteOk, true);
      assert.equal(
        streamer.isMuted(),
        false,
        `Cycle ${cycle + 1}: rapid unmute during flushAndMute must stay unmuted`
      );

      // Spaced mute then unmute
      await streamer.flushAndMute();
      sm.setMuted(true, false);
      assert.equal(sm.getSnapshot().state, "CONNECTED");
      await sleep(10);
      await streamer.ensureActiveAndUnmute();
      sm.setMuted(false);
      assert.equal(sm.getSnapshot().state, "LISTENING");
    }

    const countBefore = chunks.length;
    for (let i = 0; i < 4; i++) ctx.emitMicFrame(makeFloat32SineSpeech(640, 16000));
    assert.ok(chunks.length > countBefore, "Capture must remain healthy after 10 cycles");
    streamer.stop();
  }

  // =========================================================================
  // SCENARIO 6: Startup Mic-Pop Race Does Not Prevent Initial Greeting
  // =========================================================================
  {
    let greetings = 0;
    const flow = new ConversationFlowController({
      greetingDelayMs: 25,
      silenceDelayMs: 5000,
      onSendGreeting: () => {
        greetings += 1;
      },
      onSendSilenceReengagement: () => {},
    });
    flow.onSessionReady();
    // Simulate transient mic pop before greeting fires, with no real words transcribed
    flow.onClientState({ playbackActive: false, userSpeaking: true, muted: false });
    await sleep(35);
    assert.equal(greetings, 0);
    // Mic returns to idle -> greeting must re-arm and fire cleanly!
    flow.onClientState({ playbackActive: false, userSpeaking: false, muted: false });
    await sleep(45);
    assert.equal(
      greetings,
      1,
      "Greeting must recover if transient mic activity clears without user words"
    );
    flow.dispose();
  }

  // =========================================================================
  // SCENARIO 7: Mid-Speech Interruption Stops AudioPlayer & Resumes Listening
  // =========================================================================
  {
    const sm = new StateManager();
    let ends = 0;
    const player = new AudioPlayer({
      onPlaybackStart: () => sm.setPlayingAudio(true),
      onPlaybackEnd: () => {
        ends += 1;
        sm.setPlayingAudio(false);
      },
      onLevel: () => {},
    });
    sm.setSessionOpen(true);
    sm.setMicActive(true);
    await player.unlock();
    await player.enqueuePcm16Base64(pcm16ToBase64(makeSineChordChunk([330], 0.2)));
    await sleep(25);
    assert.equal(sm.getSnapshot().state, "SPEAKING");

    // Barge-in interrupts playback
    player.clear();
    sm.onInterrupted();
    await sleep(15);
    assert.equal(ends, 1);
    assert.equal(sm.getSnapshot().state, "LISTENING");

    // Follow-up response plays cleanly after interruption
    await player.enqueuePcm16Base64(pcm16ToBase64(makeSineChordChunk([440], 0.2)));
    await sleep(25);
    assert.equal(sm.getSnapshot().state, "SPEAKING");
    await player.dispose();
  }

  // =========================================================================
  // SCENARIO 8: Network Drop Isolation + AudioPlayer Stuck Source & Blocked Output Checks
  // =========================================================================
  {
    // 8a: Torn-down LiveSession never invokes stale onClose; mid-session error triggers close
    let unexpectedCloses = 0;
    const s1 = new LiveSession({
      onReady: () => {},
      onAudio: () => {},
      onInterrupted: () => {},
      onTurnComplete: () => {},
      onError: () => {},
      onClose: () => {
        unexpectedCloses += 1;
      },
    });
    const p1 = s1.connect();
    const ws1 = FakeWebSocket.instances.at(-1)!;
    ws1.simulateOpenAndReady();
    await p1;
    s1.close();
    await sleep(15);
    assert.equal(unexpectedCloses, 0, "Intentional close must detach stale onclose");

    let reconnectTriggered = false;
    const s2 = new LiveSession({
      onReady: () => {},
      onAudio: () => {},
      onInterrupted: () => {},
      onTurnComplete: () => {},
      onError: () => {},
      onClose: (intentional) => {
        if (!intentional) reconnectTriggered = true;
      },
    });
    const p2 = s2.connect();
    const ws2 = FakeWebSocket.instances.at(-1)!;
    ws2.simulateOpenAndReady();
    await p2;
    ws2.onerror?.(new Error("Dropped socket"));
    await sleep(15);
    assert.equal(reconnectTriggered, true, "Transport error must transition to non-intentional onClose");

    // 8b: Blocked AudioContext fires onPlaybackBlocked instead of scheduling silent audio
    let blockedMsg = "";
    const blockedPlayer = new AudioPlayer({
      onPlaybackStart: () => {},
      onPlaybackEnd: () => {},
      onLevel: () => {},
      onPlaybackBlocked: (m) => {
        blockedMsg = m;
      },
    });
    await blockedPlayer.unlock();
    const bCtx = createdContexts.at(-1)!;
    bCtx.state = "suspended";
    bCtx.failResume = true;
    await blockedPlayer.enqueuePcm16Base64(pcm16ToBase64(makeSineChordChunk([440], 0.1)));
    assert.ok(blockedMsg.length > 0, "Suspended locked AudioContext must surface onPlaybackBlocked");
    await blockedPlayer.dispose();
  }

  // =========================================================================
  // SCENARIO 9: Mic Permission Denied Fails Explicitly, Retry Recovers Cleanly
  // =========================================================================
  {
    getUserMediaBehavior = "not_allowed";
    const streamer = new AudioStreamer({
      onAudioChunk: () => {},
      onLevel: () => {},
      onSpeechStateChange: () => {},
      onError: () => {},
    });
    await assert.rejects(() => streamer.start(), /permission was denied/i);
    assert.equal(streamer.isActive(), false);

    getUserMediaBehavior = "ok";
    await streamer.start();
    assert.equal(streamer.isActive(), true);
    streamer.stop();
  }

  // =========================================================================
  // SCENARIO 10: Long Session Endurance + Model-Turn Watchdog Recovery
  // =========================================================================
  {
    let reengagements = 0;
    const flow = new ConversationFlowController({
      greetingDelayMs: 15,
      silenceDelayMs: 60,
      modelTurnWatchdogMs: 80,
      onSendGreeting: () => {},
      onSendSilenceReengagement: () => {
        reengagements += 1;
      },
    });

    flow.onSessionReady();
    // Complete initial greeting turn normally
    flow.onModelAudioChunk();
    flow.onTurnComplete();

    // User turn 1 -> Model emits audio chunk then connection drops response BEFORE turnComplete
    flow.onClientState({ playbackActive: false, userSpeaking: true, muted: false });
    flow.onInputTranscription("Hey Yunerth, tell me a quick fact.");
    flow.onClientState({ playbackActive: false, userSpeaking: false, muted: false });
    flow.onModelAudioChunk();
    assert.equal(flow.getDebugSnapshot().modelGenerating, true);

    // Without turnComplete, watchdog recovers modelGenerating after 80ms and re-arms silence!
    await sleep(110);
    assert.equal(flow.getDebugSnapshot().modelGenerating, false);
    await sleep(80);
    assert.equal(
      reengagements,
      1,
      "Silence listening must resume cleanly after dropped-turn watchdog recovery"
    );
    flow.dispose();
  }

  console.log("VOICE_RELIABILITY_ALL_10_SCENARIOS: PASSED");
}

runAllTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
