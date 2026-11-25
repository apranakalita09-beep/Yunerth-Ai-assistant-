import "dotenv/config";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import {
  ActivityHandling,
  EndSensitivity,
  GoogleGenAI,
  Modality,
  StartSensitivity,
  type LiveCallbacks,
  type LiveServerMessage,
} from "@google/genai";
import {
  buildClarificationFallbackPrompt,
  buildGreetingTriggerPrompt,
  buildSilenceContinuationPrompt,
  buildYunerthOrchestrationInstruction,
  MEMORY_FUNCTION_DECLARATIONS,
} from "./orchestration.ts";
import { ConversationFlowController } from "./conversationFlow.ts";
import {
  containsSensitiveSecret,
  sanitizeMemoryRecords,
} from "./memoryCore.ts";
import {
  BackgroundMemoryAnalyzerQueue,
} from "./memoryAnalyzer.ts";
import type { MemoryRecord, MemoryToolAction } from "./src/memory/types.ts";
import {
  executeWorldClockTool,
  isValidIanaTimeZone,
  WORLD_CLOCK_FUNCTION_DECLARATIONS,
} from "./worldClock.ts";
import {
  createSearchGenAIClient,
  executeWebSearch,
  getDefaultWebSearchCoordinator,
  WEB_SEARCH_FUNCTION_DECLARATION,
} from "./webSearch.ts";
import {
  executeWeatherToolWithMetrics,
  roundCoordinate,
  warmWeatherConnections,
  WEATHER_FUNCTION_DECLARATION,
  WeatherToolTurnMonitor,
  type LocalLocationResolution,
  type WeatherExecutionMetrics,
  type WeatherToolResult,
} from "./weatherService.ts";
import { buildUnifiedLiveSystemInstruction } from "./voiceExpression.ts";
import { sanitizeSessionContextSummary } from "./sessionContext.ts";
import {
  createDefaultExpressionState,
  type VoiceSpeedMode,
} from "./src/voice/types.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const LIVE_MODEL = "gemini-3.8-live";

function createGenAIClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || apiKey === "MY_GEMINI_API_KEY") {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      apiVersion: "v1beta",
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

function sendJson(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    const hasKey = Boolean(
      process.env.GEMINI_API_KEY?.trim() &&
        process.env.GEMINI_API_KEY.trim() !== "MY_GEMINI_API_KEY"
    );
    res.json({ ok: true, configured: hasKey });
  });

  app.get("/api/search-diagnostics", async (req, res) => {
    const coordinator = getDefaultWebSearchCoordinator();
    const defaultSearchAi = createSearchGenAIClient();
    const configured = Boolean(defaultSearchAi);

    const remoteAddr = req.socket.remoteAddress || "";
    const isLoopback =
      remoteAddr === "127.0.0.1" ||
      remoteAddr === "::1" ||
      remoteAddr === "::ffff:127.0.0.1";

    if (req.query.probe === "1" && isLoopback) {
      const probeResult = await coordinator.runDiagnosticProbes(defaultSearchAi);
      res.json(probeResult);
      return;
    }

    res.json(coordinator.getDiagnosticsSnapshot(configured));
  });

  if (process.env.NODE_ENV === "production") {
    const distDir = path.resolve(__dirname, "dist");
    app.use(express.static(distDir));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distDir, "index.html"));
    });
  } else {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/live" });

  wss.on("connection", async (clientWs, req) => {
    const ai = createGenAIClient();
    if (!ai) {
      sendJson(clientWs, {
        type: "error",
        code: "MISSING_API_KEY",
        message:
          "Server Gemini API key is not configured. Set GEMINI_API_KEY in Settings > Secrets and try connecting again.",
      });
      clientWs.close(1011, "Missing GEMINI_API_KEY");
      return;
    }

    let userLocalTimeZone: string | undefined;
    let initialVoiceMode: VoiceSpeedMode = "normal";
    try {
      const parsedUrl = new URL(req.url || "/live", "http://localhost");
      const rawTz = parsedUrl.searchParams.get("tz")?.trim();
      if (rawTz && isValidIanaTimeZone(rawTz)) {
        userLocalTimeZone = rawTz;
      }
      const rawMode = parsedUrl.searchParams.get("mode")?.trim();
      if (rawMode === "slow" || rawMode === "normal" || rawMode === "fast") {
        initialVoiceMode = rawMode;
      }
    } catch {
      // Ignore malformed query string
    }

    let liveSession: Awaited<ReturnType<typeof ai.live.connect>> | null = null;
    let isClosed = false;
    const cancelledToolCallIds = new Set<string>();
    const baseSystemInstruction =
      buildYunerthOrchestrationInstruction(userLocalTimeZone);
    let sessionMemoriesSnapshot: MemoryRecord[] = [];
    const recentlyDeclinedDescriptions: string[] = [];
    let pendingLevel2SpokenPrompt: {
      description: string;
      queuedAtMs: number;
    } | null = null;
    const analyzerAi = createSearchGenAIClient() ?? ai;
    let lastAppliedSystemInstruction = buildUnifiedLiveSystemInstruction({
      baseInstruction: baseSystemInstruction,
      expression: createDefaultExpressionState(),
      voiceMode: initialVoiceMode,
      retrievedMemoriesBlock: "",
    });
    let lastUserSpeechEndedAt: number | null = null;
    let wasClientUserSpeaking = false;
    const weatherMonitor = new WeatherToolTurnMonitor();

    let memoryRelaySeq = 0;
    const pendingMemoryRelays = new Map<
      string,
      {
        toolCallId?: string;
        resolve: (result: Record<string, unknown>) => void;
        timer: NodeJS.Timeout;
      }
    >();

    const requestClientMemoryAction = (
      action: MemoryToolAction,
      args: Record<string, unknown>,
      toolCallId?: string
    ): Promise<Record<string, unknown>> => {
      if (isClosed || clientWs.readyState !== WebSocket.OPEN) {
        return Promise.resolve({
          status: "error",
          saved: false,
          message: "Voice client connection is closed.",
        });
      }
      const requestId = `mem-${++memoryRelaySeq}`;
      return new Promise<Record<string, unknown>>((resolve) => {
        const timer = setTimeout(() => {
          pendingMemoryRelays.delete(requestId);
          resolve({
            status: "error",
            saved: false,
            message: "Memory storage request timed out before confirmation.",
          });
        }, 8000);

        pendingMemoryRelays.set(requestId, {
          toolCallId,
          resolve: (result) => {
            clearTimeout(timer);
            pendingMemoryRelays.delete(requestId);
            resolve(result);
          },
          timer,
        });

        sendJson(clientWs, {
          type: "memoryToolRequest",
          requestId,
          action,
          args,
        });
      });
    };

    let sessionLocalCoords: { latitude: number; longitude: number } | null =
      null;
    let sessionGeolocationDenied = false;
    let sessionGeolocationUnavailable = false;
    let geolocationSeq = 0;
    let inflightGeolocationPromise: Promise<LocalLocationResolution> | null =
      null;
    const pendingGeolocationRequests = new Map<
      string,
      {
        toolCallId?: string;
        resolve: (result: LocalLocationResolution) => void;
        timer: NodeJS.Timeout;
      }
    >();

    const requestClientGeolocation = (
      toolCallId?: string
    ): Promise<LocalLocationResolution> => {
      if (sessionLocalCoords) {
        return Promise.resolve({
          status: "granted",
          latitude: sessionLocalCoords.latitude,
          longitude: sessionLocalCoords.longitude,
        });
      }
      if (sessionGeolocationDenied) {
        return Promise.resolve({ status: "denied" });
      }
      if (sessionGeolocationUnavailable) {
        return Promise.resolve({ status: "unavailable" });
      }
      if (isClosed || clientWs.readyState !== WebSocket.OPEN) {
        return Promise.resolve({ status: "unavailable" });
      }
      if (inflightGeolocationPromise) {
        return inflightGeolocationPromise;
      }

      const requestId = `geo-${++geolocationSeq}`;
      const promise = new Promise<LocalLocationResolution>((resolve) => {
        const timer = setTimeout(() => {
          pendingGeolocationRequests.delete(requestId);
          inflightGeolocationPromise = null;
          resolve({ status: "unavailable" });
        }, 12000);

        pendingGeolocationRequests.set(requestId, {
          toolCallId,
          resolve: (result) => {
            clearTimeout(timer);
            pendingGeolocationRequests.delete(requestId);
            inflightGeolocationPromise = null;
            resolve(result);
          },
          timer,
        });

        sendJson(clientWs, {
          type: "requestGeolocation",
          requestId,
        });
      });

      inflightGeolocationPromise = promise;
      return promise;
    };

    const flow = new ConversationFlowController({
      initialVoiceMode,
      onSendGreeting: () => {
        if (isClosed || !liveSession) return;
        try {
          liveSession.sendClientContent({
            turns: [
              {
                role: "user",
                parts: [{ text: buildGreetingTriggerPrompt() }],
              },
            ],
            turnComplete: true,
          });
        } catch (err) {
          console.error("Failed to trigger session greeting:", err);
          flow.recoverTurnState();
        }
      },
      onSendSilenceReengagement: (context) => {
        if (isClosed || !liveSession) return;
        try {
          liveSession.sendClientContent({
            turns: [
              {
                role: "user",
                parts: [{ text: buildSilenceContinuationPrompt(context) }],
              },
            ],
            turnComplete: true,
          });
        } catch (err) {
          console.error("Failed to trigger silence re-engagement:", err);
          flow.recoverTurnState();
        }
      },
      onExpressionChange: (expression) => {
        sendJson(clientWs, { type: "expression", expression });
      },
      onVoiceModeChange: (mode) => {
        sendJson(clientWs, { type: "voiceMode", mode });
      },
      onContextSummaryChange: (summary) => {
        sendJson(clientWs, { type: "contextSummary", summary });
      },
      onSilentUserTurnDetected: ({ reason, partialTranscript }) => {
        if (isClosed || !liveSession) return false;
        try {
          liveSession.sendClientContent({
            turns: [
              {
                role: "user",
                parts: [
                  {
                    text: buildClarificationFallbackPrompt({
                      reason,
                      partialTranscript,
                    }),
                  },
                ],
              },
            ],
            turnComplete: true,
          });
          return true;
        } catch (err) {
          console.error("Failed to trigger silent-turn clarification:", err);
          return false;
        }
      },
      onLiveContextSync: ({
        expression,
        voiceMode,
        contextSummaryBlock,
        retrievedMemoriesBlock,
      }) => {
        if (isClosed || !liveSession) return;
        const nextInstruction = buildUnifiedLiveSystemInstruction({
          baseInstruction: baseSystemInstruction,
          expression,
          voiceMode,
          contextSummaryBlock,
          retrievedMemoriesBlock,
        });
        if (nextInstruction === lastAppliedSystemInstruction) {
          return;
        }
        lastAppliedSystemInstruction = nextInstruction;
        try {
          liveSession.sendContextUpdate({
            systemInstruction: nextInstruction,
          });
        } catch (err) {
          console.warn(
            "Live unified context update skipped:",
            err instanceof Error ? err.message : err
          );
        }
      },
      onIdleForMemoryPrompt: () => {
        maybeDeliverLevel2SpokenPrompt();
      },
      onCompletedTurnForMemory: ({
        userText,
        assistantText,
        currentTopic,
        completedAtMs,
      }) => {
        if (isClosed) return;
        memoryAnalyzerQueue.enqueue({
          userText,
          assistantText,
          currentTopic,
          turnCompletedAtMs: completedAtMs,
        });
      },
    });

    const maybeDeliverLevel2SpokenPrompt = () => {
      if (!pendingLevel2SpokenPrompt) return;
      if (isClosed || !liveSession || !flow.isIdleForBackgroundPrompt()) {
        return;
      }
      const promptJob = pendingLevel2SpokenPrompt;
      pendingLevel2SpokenPrompt = null;
      const permissionDispatchMs = Math.max(
        0,
        Date.now() - promptJob.queuedAtMs
      );
      try {
        liveSession.sendClientContent({
          turns: [
            {
              role: "user",
              parts: [
                {
                  text: `[SYSTEM EVENT: IMPORTANT_MEMORY_PERMISSION] Briefly and naturally ask the user once if they'd like you to save this important memory: "${promptJob.description}". Keep it warm and concise (1 short sentence), then pause quietly so they can say yes or no or tap Approve/Decline. Do not mention system events.`,
                },
              ],
            },
          ],
          turnComplete: true,
        });
        console.log(
          `[MemoryTelemetry] stage=permission_prompt permissionDispatchMs=${permissionDispatchMs}`
        );
      } catch (err) {
        console.warn(
          "[MemoryAnalyzer] Unable to deliver Level 2 spoken prompt:",
          err instanceof Error ? err.message : err
        );
      }
    };

    const memoryAnalyzerQueue = new BackgroundMemoryAnalyzerQueue({
      getAi: () => analyzerAi,
      getExistingMemories: () => sessionMemoriesSnapshot,
      getDeclinedDescriptions: () => recentlyDeclinedDescriptions,
      onCandidates: (analysis) => {
        if (isClosed || clientWs.readyState !== WebSocket.OPEN) return;
        console.log(
          `[MemoryTelemetry] stage=analyze detectionMs=${analysis.metrics.detectionMs} classificationMs=${analysis.metrics.classificationMs} candidates=${analysis.candidates.length} skipped=${analysis.skippedReason ?? "none"}`
        );

        for (const candidate of analysis.candidates) {
          if (candidate.level === "level1_auto") {
            sendJson(clientWs, {
              type: "memoryAutoSave",
              candidate,
            });
          } else if (candidate.level === "level2_important") {
            const dispatchedAt = Date.now();
            sendJson(clientWs, {
              type: "memoryApprovalRequested",
              candidate,
            });
            pendingLevel2SpokenPrompt = {
              description: candidate.description,
              queuedAtMs: dispatchedAt,
            };
            maybeDeliverLevel2SpokenPrompt();
            break;
          }
        }
      },
    });

    let wsAlive = true;
    const wsHeartbeatTimer = setInterval(() => {
      if (isClosed || clientWs.readyState !== WebSocket.OPEN) {
        clearInterval(wsHeartbeatTimer);
        return;
      }
      if (!wsAlive) {
        console.warn("[Yunerth Live] Client WebSocket missed heartbeat; closing stale session.");
        cleanupSession();
        clientWs.terminate();
        return;
      }
      wsAlive = false;
      try {
        clientWs.ping();
      } catch {
        cleanupSession();
      }
    }, 25000);

    clientWs.on("pong", () => {
      wsAlive = true;
    });

    const cleanupSession = () => {
      if (isClosed) return;
      isClosed = true;
      clearInterval(wsHeartbeatTimer);
      memoryAnalyzerQueue.dispose();
      pendingLevel2SpokenPrompt = null;
      flow.dispose();
      cancelledToolCallIds.clear();
      sessionLocalCoords = null;
      for (const pending of pendingGeolocationRequests.values()) {
        clearTimeout(pending.timer);
        pending.resolve({ status: "unavailable" });
      }
      pendingGeolocationRequests.clear();
      for (const pendingMem of pendingMemoryRelays.values()) {
        clearTimeout(pendingMem.timer);
        pendingMem.resolve({
          status: "error",
          saved: false,
          message: "Voice session closed.",
        });
      }
      pendingMemoryRelays.clear();
      inflightGeolocationPromise = null;
      if (liveSession) {
        try {
          liveSession.close();
        } catch {
          // Ignore errors while closing an already closed session
        }
        liveSession = null;
      }
    };

    const failSessionOnUpstreamSend = (label: string, err: unknown) => {
      console.error(`Failed upstream Live ${label}:`, err);
      if (!isClosed) {
        sendJson(clientWs, {
          type: "error",
          code: "UPSTREAM_SEND_FAILED",
          message: "The voice stream was interrupted. Reconnect to continue.",
        });
        cleanupSession();
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.close(1011, "Upstream Live send failed");
        }
      }
    };

    clientWs.on("close", () => {
      cleanupSession();
    });

    clientWs.on("error", () => {
      cleanupSession();
    });

    clientWs.on("message", (raw) => {
      wsAlive = true;
      if (isClosed) return;
      try {
        const parsed = JSON.parse(raw.toString()) as {
          type?: string;
          data?: string;
          audio?: string;
          ts?: number;
          playbackActive?: boolean;
          userSpeaking?: boolean;
          muted?: boolean;
          mode?: unknown;
          summary?: unknown;
          requestId?: string;
          status?: string;
          latitude?: unknown;
          longitude?: unknown;
          memories?: unknown;
          retrievedBlock?: unknown;
          result?: unknown;
          decision?: unknown;
          description?: unknown;
        };
        if (parsed.type === "ping") {
          sendJson(clientWs, { type: "pong", ts: parsed.ts ?? Date.now() });
          return;
        }
        if (parsed.type === "restoreSessionContext") {
          const cleanSummary = sanitizeSessionContextSummary(parsed.summary);
          if (cleanSummary) {
            flow.restoreContextSummary(cleanSummary);
          }
          return;
        }
        if (parsed.type === "memoryContext") {
          if (Array.isArray(parsed.memories)) {
            sessionMemoriesSnapshot = sanitizeMemoryRecords(parsed.memories);
          }
          if (typeof parsed.retrievedBlock === "string") {
            flow.setRetrievedMemoriesBlock(parsed.retrievedBlock);
          }
          return;
        }
        if (parsed.type === "memoryApprovalResolution") {
          pendingLevel2SpokenPrompt = null;
          if (
            parsed.decision === "decline" &&
            typeof parsed.description === "string" &&
            parsed.description.trim()
          ) {
            const desc = parsed.description.trim();
            if (!recentlyDeclinedDescriptions.includes(desc)) {
              recentlyDeclinedDescriptions.push(desc);
              if (recentlyDeclinedDescriptions.length > 20) {
                recentlyDeclinedDescriptions.shift();
              }
            }
          }
          return;
        }
        if (parsed.type === "memoryToolResult" && parsed.requestId) {
          const pending = pendingMemoryRelays.get(parsed.requestId);
          if (pending) {
            const resultObj =
              parsed.result && typeof parsed.result === "object"
                ? (parsed.result as Record<string, unknown>)
                : { status: "error", saved: false };
            pending.resolve(resultObj);
          }
          return;
        }
        if (!liveSession) return;
        if (parsed.type === "geolocationResult" && parsed.requestId) {
          const pending = pendingGeolocationRequests.get(parsed.requestId);
          if (pending) {
            if (
              parsed.status === "granted" &&
              typeof parsed.latitude === "number" &&
              Number.isFinite(parsed.latitude) &&
              parsed.latitude >= -90 &&
              parsed.latitude <= 90 &&
              typeof parsed.longitude === "number" &&
              Number.isFinite(parsed.longitude) &&
              parsed.longitude >= -180 &&
              parsed.longitude <= 180
            ) {
              const rounded = {
                latitude: roundCoordinate(parsed.latitude),
                longitude: roundCoordinate(parsed.longitude),
              };
              sessionLocalCoords = rounded;
              sessionGeolocationDenied = false;
              sessionGeolocationUnavailable = false;
              pending.resolve({ status: "granted", ...rounded });
            } else if (parsed.status === "denied") {
              sessionGeolocationDenied = true;
              pending.resolve({ status: "denied" });
            } else {
              sessionGeolocationUnavailable = true;
              pending.resolve({ status: "unavailable" });
            }
          }
          return;
        }
        if (parsed.type === "clientState") {
          if (parsed.userSpeaking === true) {
            wasClientUserSpeaking = true;
            lastUserSpeechEndedAt = null;
          } else if (parsed.userSpeaking === false && wasClientUserSpeaking) {
            wasClientUserSpeaking = false;
            lastUserSpeechEndedAt = Date.now();
          }
          flow.onClientState({
            playbackActive: parsed.playbackActive,
            userSpeaking: parsed.userSpeaking,
            muted: parsed.muted,
          });
          return;
        }
        if (parsed.type === "audioStreamEnd") {
          if (wasClientUserSpeaking || lastUserSpeechEndedAt === null) {
            wasClientUserSpeaking = false;
            lastUserSpeechEndedAt = Date.now();
          }
          flow.onAudioStreamEnd();
          try {
            liveSession.sendRealtimeInput({ audioStreamEnd: true });
          } catch (err) {
            failSessionOnUpstreamSend("audioStreamEnd", err);
          }
          return;
        }
        const base64Audio = parsed.data ?? parsed.audio;
        if (typeof base64Audio === "string" && base64Audio.length > 0) {
          flow.onClientAudioFrameReceived();
          try {
            liveSession.sendRealtimeInput({
              audio: {
                data: base64Audio,
                mimeType: "audio/pcm;rate=16000",
              },
            });
          } catch (err) {
            failSessionOnUpstreamSend("audio chunk", err);
          }
        }
      } catch (err) {
        console.error("Failed to handle client Live message:", err);
      }
    });

    try {
      const baseLiveConfig = {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: "Aoede",
            },
          },
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        realtimeInputConfig: {
          automaticActivityDetection: {
            startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
            endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
            prefixPaddingMs: 160,
            silenceDurationMs: 480,
          },
          activityHandling: ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
        },
        contextWindowCompression: {
          slidingWindow: {},
        },
        tools: [
          {
            functionDeclarations: [
              ...WORLD_CLOCK_FUNCTION_DECLARATIONS,
              WEB_SEARCH_FUNCTION_DECLARATION,
              WEATHER_FUNCTION_DECLARATION,
              ...MEMORY_FUNCTION_DECLARATIONS,
            ],
          },
        ],
        systemInstruction: lastAppliedSystemInstruction,
      };

      const liveCallbacks: LiveCallbacks = {
          onopen: () => {
            // Connection opened; ready event is emitted once liveSession is assigned below
          },
          onmessage: (message: LiveServerMessage) => {
            if (isClosed) return;

            if (message.goAway) {
              console.warn(
                `[Yunerth Live] Upstream GoAway received (timeLeft=${message.goAway.timeLeft ?? "unknown"})`
              );
            }

            const cancelledIds = message.toolCallCancellation?.ids;
            if (cancelledIds && cancelledIds.length > 0) {
              for (const id of cancelledIds) {
                cancelledToolCallIds.add(id);
                for (const pending of pendingGeolocationRequests.values()) {
                  if (pending.toolCallId === id) {
                    pending.resolve({ status: "unavailable" });
                  }
                }
                for (const pendingMem of pendingMemoryRelays.values()) {
                  if (pendingMem.toolCallId === id) {
                    pendingMem.resolve({
                      status: "error",
                      saved: false,
                      message: "Tool call cancelled.",
                    });
                  }
                }
              }
            }

            const functionCalls = message.toolCall?.functionCalls;
            if (functionCalls && functionCalls.length > 0 && liveSession) {
              flow.onToolCallStarted(functionCalls.length);
              const intentToToolCallMs =
                lastUserSpeechEndedAt !== null
                  ? Math.max(0, Date.now() - lastUserSpeechEndedAt)
                  : null;
              void (async () => {
                let latestWeatherOutcome: {
                  result: WeatherToolResult;
                  metrics: WeatherExecutionMetrics;
                } | null = null;
                try {
                  const searchAi = functionCalls.some(
                    (c) => c.name === "search_web"
                  )
                    ? createSearchGenAIClient() ?? ai
                    : ai;
                  const responses = await Promise.all(
                    functionCalls.map(async (call) => {
                      try {
                        if (call.name === "get_weather") {
                          const normalizedArgs =
                            weatherMonitor.prepareWeatherArgs(call.args);
                          const { result, metrics } =
                            await executeWeatherToolWithMetrics(
                              normalizedArgs,
                              {
                                resolveLocalLocation: () =>
                                  requestClientGeolocation(call.id),
                                fallbackTimeZone: userLocalTimeZone,
                              }
                            );
                          latestWeatherOutcome = { result, metrics };
                          return {
                            id: call.id,
                            name: call.name,
                            response: result as unknown as Record<
                              string,
                              unknown
                            >,
                          };
                        }

                        if (
                          call.name === "save_memory" ||
                          call.name === "update_memory" ||
                          call.name === "search_memories" ||
                          call.name === "resolve_pending_memory_approval"
                        ) {
                          const args = (call.args || {}) as Record<
                            string,
                            unknown
                          >;
                          if (
                            call.name === "save_memory" ||
                            call.name === "update_memory"
                          ) {
                            const desc =
                              typeof args.description === "string"
                                ? args.description
                                : "";
                            const secretCheck = containsSensitiveSecret(desc);
                            if (secretCheck.blocked) {
                              return {
                                id: call.id,
                                name: call.name,
                                response: {
                                  status: "error",
                                  saved: false,
                                  privacyBlocked: true,
                                  message:
                                    secretCheck.reason ||
                                    "Sensitive security details cannot be stored in memory.",
                                },
                              };
                            }
                          }
                          if (call.name === "resolve_pending_memory_approval") {
                            pendingLevel2SpokenPrompt = null;
                            if (
                              args.decision === "decline" &&
                              typeof args.description === "string"
                            ) {
                              recentlyDeclinedDescriptions.push(
                                args.description
                              );
                            }
                          }
                          const memResult = await requestClientMemoryAction(
                            call.name as MemoryToolAction,
                            args,
                            call.id
                          );
                          return {
                            id: call.id,
                            name: call.name,
                            response: memResult,
                          };
                        }

                        const response = (
                          call.name === "search_web"
                            ? await executeWebSearch(
                                searchAi,
                                call.args,
                                userLocalTimeZone
                              )
                            : executeWorldClockTool(
                                call.name,
                                call.args,
                                userLocalTimeZone
                              )
                        ) as unknown as Record<string, unknown>;
                        return {
                          id: call.id,
                          name: call.name,
                          response,
                        };
                      } catch (toolErr) {
                        console.error(
                          `Live tool "${call.name || "unknown"}" failed:`,
                          toolErr
                        );
                        return {
                          id: call.id,
                          name: call.name,
                          response: {
                            status: "error",
                            message:
                              toolErr instanceof Error
                                ? toolErr.message
                                : "Tool execution failed unexpectedly.",
                          },
                        };
                      }
                    })
                  );

                  if (isClosed || !liveSession) return;
                  const activeResponses = responses.filter(
                    (r) => !r.id || !cancelledToolCallIds.has(r.id)
                  );
                  if (activeResponses.length > 0) {
                    if (latestWeatherOutcome) {
                      const outcome = latestWeatherOutcome as {
                        result: WeatherToolResult;
                        metrics: WeatherExecutionMetrics;
                      };
                      weatherMonitor.onWeatherToolResponseSent(outcome.result);
                      const payloadBytes = Buffer.byteLength(
                        JSON.stringify(outcome.result),
                        "utf8"
                      );
                      console.log(
                        `[Yunerth Weather] scope=${outcome.metrics.scope} status=${outcome.result.status} cacheHit=${outcome.metrics.cacheHit} geocodeCacheHit=${outcome.metrics.geocodeCacheHit} intentToToolMs=${intentToToolCallMs ?? "n/a"} geocodingMs=${outcome.metrics.geocodingMs} weatherRetrievalMs=${outcome.metrics.weatherRetrievalMs} responsePrepMs=${outcome.metrics.responsePreparationMs} totalToolMs=${outcome.metrics.totalMs} payloadBytes=${payloadBytes}`
                      );
                    }
                    liveSession.sendToolResponse({
                      functionResponses: activeResponses,
                    });
                  }
                } catch (err) {
                  console.error("Failed to process Live tool call:", err);
                } finally {
                  flow.onToolCallFinished(functionCalls.length);
                }
              })();
            }

            const serverContent = message.serverContent;
            if (!serverContent) return;

            if (serverContent.inputTranscription?.text) {
              flow.onInputTranscription(serverContent.inputTranscription.text);
            }
            if (serverContent.outputTranscription?.text) {
              flow.onOutputTranscription(
                serverContent.outputTranscription.text
              );
            }

            if (serverContent.interrupted) {
              weatherMonitor.onInterrupted();
              flow.onInterrupted();
              sendJson(clientWs, { type: "interrupted" });
              return;
            }

            const parts = serverContent.modelTurn?.parts ?? [];
            for (const part of parts) {
              if (part.inlineData?.data) {
                const isFirstChunk = flow.onModelAudioChunk();
                if (isFirstChunk) {
                  sendJson(clientWs, { type: "modelTurnStarted" });
                  const voiceHandoffMs =
                    weatherMonitor.onFirstModelAudioChunk();
                  if (voiceHandoffMs !== null) {
                    console.log(
                      `[Yunerth Weather] voiceHandoffMs=${voiceHandoffMs}`
                    );
                  }
                  if (lastUserSpeechEndedAt !== null) {
                    const startupMs = Date.now() - lastUserSpeechEndedAt;
                    lastUserSpeechEndedAt = null;
                    console.log(`[Yunerth Latency] speechEndToFirstAudioMs=${startupMs}`);
                  }
                }
                sendJson(clientWs, {
                  type: "audio",
                  data: part.inlineData.data,
                });
              }
            }

            if (serverContent.turnComplete) {
              const recoveryDecision = weatherMonitor.onTurnComplete();
              if (
                recoveryDecision.action === "trigger_recovery" &&
                liveSession &&
                !isClosed
              ) {
                console.warn(
                  "[Yunerth Weather] Silent turn after weather tool response; triggering spoken recovery."
                );
                try {
                  liveSession.sendClientContent({
                    turns: [
                      {
                        role: "user",
                        parts: [{ text: recoveryDecision.prompt }],
                      },
                    ],
                    turnComplete: true,
                  });
                  return;
                } catch (err) {
                  console.error(
                    "Failed to send weather silent-turn recovery:",
                    err
                  );
                }
              }
              flow.onTurnComplete();
              sendJson(clientWs, { type: "turnComplete" });
            }
          },
          onerror: (event) => {
            console.error("Gemini Live session error:", event);
            if (!isClosed) {
              sendJson(clientWs, {
                type: "error",
                code: "LIVE_SESSION_ERROR",
                message:
                  event.message ||
                  "The voice connection encountered an unexpected error.",
              });
              cleanupSession();
              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.close(1011, "Gemini Live session error");
              }
            }
          },
          onclose: (event) => {
            if (!isClosed) {
              sendJson(clientWs, {
                type: "closed",
                reason: event.reason || "Session ended.",
              });
              cleanupSession();
              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.close(1000, event.reason || "Live session closed");
              }
            }
          },
        };

      liveSession = await ai.live.connect({
        model: LIVE_MODEL,
        config: baseLiveConfig,
        callbacks: liveCallbacks,
      });

      if (isClosed && liveSession) {
        liveSession.close();
        liveSession = null;
      } else if (!isClosed) {
        sendJson(clientWs, { type: "ready" });
        flow.onSessionReady();
      }
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Unable to establish Gemini Live connection.";
      console.error("Failed to connect to Gemini Live:", err);
      sendJson(clientWs, {
        type: "error",
        code: "CONNECT_FAILED",
        message,
      });
      cleanupSession();
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close(1011, "Live connection failed");
      }
    }
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Yunerth server listening on http://0.0.0.0:${PORT}`);
    warmWeatherConnections();
  });
}

startServer().catch((err) => {
  console.error("Fatal server startup error:", err);
  process.exit(1);
});
