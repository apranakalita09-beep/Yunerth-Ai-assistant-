import { useCallback, useEffect, useRef, useState } from "react";
import {
  AudioDiagnosticsTracker,
  type AudioReliabilityMetrics,
} from "./AudioDiagnostics";
import { AudioPlayer } from "./AudioPlayer";
import { AudioStreamer } from "./AudioStreamer";
import { LiveSession } from "./LiveSession";
import { StateManager } from "./StateManager";
import {
  clearSessionCoordinates,
  requestBrowserLocation,
} from "./geolocation";
import type {
  AnalyzedMemoryCandidate,
  MemoryRecord,
  MemoryToolRelayRequest,
} from "../memory/types";
import type {
  SessionContextSummary,
  VoiceSnapshot,
  VoiceSpeedMode,
} from "./types";

const MAX_AUTO_RECONNECTS = 1;

export interface YunerthVoiceMemoryBridge {
  getRelevantMemoriesPayload: (queryText?: string) => {
    memories: MemoryRecord[];
    retrievedBlock: string;
  };
  allMemories: MemoryRecord[];
  handleVoiceToolAction: (
    request: MemoryToolRelayRequest
  ) => Promise<Record<string, unknown>>;
  handleAsyncAutoSaveCandidate: (
    candidate: AnalyzedMemoryCandidate
  ) => Promise<void>;
  handleAsyncApprovalCandidate: (candidate: AnalyzedMemoryCandidate) => void;
}

export function useYunerthVoice(memoryBridge?: YunerthVoiceMemoryBridge) {
  const memoryBridgeRef = useRef<YunerthVoiceMemoryBridge | undefined>(
    memoryBridge
  );
  memoryBridgeRef.current = memoryBridge;
  const diagnosticsRef = useRef<AudioDiagnosticsTracker | null>(null);
  if (!diagnosticsRef.current) {
    diagnosticsRef.current = new AudioDiagnosticsTracker();
  }

  const stateManagerRef = useRef<StateManager | null>(null);
  if (!stateManagerRef.current) {
    stateManagerRef.current = new StateManager({
      onWatchdogTimeout: () => {
        diagnosticsRef.current?.recordMissedTurnRecovery();
      },
    });
  }

  const [snapshot, setSnapshot] = useState<VoiceSnapshot>(() =>
    stateManagerRef.current!.getSnapshot()
  );

  const sessionRef = useRef<LiveSession | null>(null);
  const streamerRef = useRef<AudioStreamer | null>(null);
  const playerRef = useRef<AudioPlayer | null>(null);
  const connectingRef = useRef(false);
  const connectionAttemptIdRef = useRef(0);
  const manualCloseRef = useRef(false);
  const reconnectCountRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const muteSeqRef = useRef(0);
  const desiredMutedRef = useRef(false);
  const sessionContextSummaryRef = useRef<SessionContextSummary | null>(null);
  const voiceModeRef = useRef<VoiceSpeedMode>("normal");
  const isReconnectAttemptRef = useRef(false);

  const inputLevelRef = useRef(0);
  const outputLevelRef = useRef(0);
  const userSpeakingRef = useRef(false);
  const lastSentClientStateRef = useRef<{
    open: boolean;
    playbackActive: boolean;
    userSpeaking: boolean;
    muted: boolean;
  }>({
    open: false,
    playbackActive: false,
    userSpeaking: false,
    muted: false,
  });

  const syncClientState = useCallback(() => {
    const sm = stateManagerRef.current;
    const session = sessionRef.current;
    if (!sm || !session || !session.isOpen()) {
      lastSentClientStateRef.current.open = false;
      return;
    }
    const snap = sm.getSnapshot();
    const muted = desiredMutedRef.current || snap.isMuted;
    const next = {
      open: snap.isSessionOpen,
      playbackActive: snap.isPlayingAudio,
      userSpeaking: userSpeakingRef.current && !muted,
      muted,
    };
    const prev = lastSentClientStateRef.current;
    if (
      !prev.open ||
      prev.playbackActive !== next.playbackActive ||
      prev.userSpeaking !== next.userSpeaking ||
      prev.muted !== next.muted
    ) {
      lastSentClientStateRef.current = next;
      session.sendClientState({
        playbackActive: next.playbackActive,
        userSpeaking: next.userSpeaking,
        muted: next.muted,
      });
    }
  }, []);

  const teardownAll = useCallback(() => {
    muteSeqRef.current += 1;
    desiredMutedRef.current = false;
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    if (streamerRef.current) {
      streamerRef.current.stop();
      streamerRef.current = null;
    }

    if (playerRef.current) {
      playerRef.current.clear();
    }

    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }

    inputLevelRef.current = 0;
    outputLevelRef.current = 0;
    userSpeakingRef.current = false;
    lastSentClientStateRef.current.open = false;
    clearSessionCoordinates();
  }, []);

  const ensurePlayer = useCallback((): AudioPlayer => {
    if (playerRef.current) {
      return playerRef.current;
    }
    const sm = stateManagerRef.current!;
    const player = new AudioPlayer({
      onPlaybackStart: () => {
        diagnosticsRef.current?.markPlaybackStarted();
        sm.setPlayingAudio(true);
      },
      onPlaybackEnd: () => {
        outputLevelRef.current = 0;
        sm.setLevels(inputLevelRef.current, 0);
        sm.setPlayingAudio(false);
      },
      onLevel: (level) => {
        outputLevelRef.current = level;
        sm.setLevels(inputLevelRef.current, level);
      },
      onPlaybackBlocked: (message) => {
        manualCloseRef.current = true;
        connectionAttemptIdRef.current += 1;
        connectingRef.current = false;
        teardownAll();
        sm.setError(message);
      },
    });
    playerRef.current = player;
    return player;
  }, [teardownAll]);

  const startConnection = useCallback(
    async (isReconnect = false) => {
      if (connectingRef.current) return;
      const sm = stateManagerRef.current!;
      const current = sm.getSnapshot();
      if (!isReconnect && current.isSessionOpen) return;

      const attemptId = ++connectionAttemptIdRef.current;
      connectingRef.current = true;
      manualCloseRef.current = false;
      isReconnectAttemptRef.current = isReconnect;
      if (!isReconnect) {
        reconnectCountRef.current = 0;
        sessionContextSummaryRef.current = null;
        voiceModeRef.current = "normal";
        diagnosticsRef.current?.reset();
      } else {
        diagnosticsRef.current?.recordReconnect();
      }

      teardownAll();
      sm.setConnecting();
      if (isReconnect) {
        sm.setVoiceMode(voiceModeRef.current);
      }

      const player = ensurePlayer();
      // Unlock AudioContext immediately inside the user gesture before any await
      // (getUserMedia permission prompts can otherwise consume the gesture token).
      const unlockPromise = player.unlock().catch(() => undefined);

      const streamer = new AudioStreamer({
        onAudioChunk: (base64Pcm16) => {
          if (streamerRef.current !== streamer) return;
          sessionRef.current?.sendAudio(base64Pcm16);
        },
        onLevel: (level) => {
          if (streamerRef.current !== streamer) return;
          inputLevelRef.current = level;
          sm.setLevels(level, outputLevelRef.current);
        },
        onSpeechStateChange: (speaking) => {
          if (streamerRef.current !== streamer) return;
          const prevSpeaking = userSpeakingRef.current;
          userSpeakingRef.current = speaking;
          if (prevSpeaking && !speaking && !desiredMutedRef.current) {
            diagnosticsRef.current?.markUserSpeechCompleted(false);
          }
          sm.setUserSpeaking(speaking);
          syncClientState();
        },
        onFrameMetric: (kind) => {
          if (streamerRef.current !== streamer) return;
          if (kind === "transmitted") {
            diagnosticsRef.current?.recordTransmittedSpeechFrame();
          } else {
            diagnosticsRef.current?.recordSuppressedNoiseFrame();
          }
        },
        onError: (message) => {
          if (streamerRef.current !== streamer) return;
          manualCloseRef.current = true;
          teardownAll();
          sm.setError(message);
        },
      });
      streamerRef.current = streamer;

      try {
        await unlockPromise;
        await streamer.start();
        if (attemptId !== connectionAttemptIdRef.current || manualCloseRef.current) {
          streamer.stop();
          if (streamerRef.current === streamer) {
            streamerRef.current = null;
          }
          connectingRef.current = false;
          return;
        }
      } catch (err) {
        if (attemptId === connectionAttemptIdRef.current) {
          teardownAll();
          sm.setError(
            err instanceof Error
              ? err.message
              : "Microphone access could not be started."
          );
        }
        connectingRef.current = false;
        return;
      }

      const session = new LiveSession({
        onReady: () => {
          if (sessionRef.current !== session) return;
          reconnectCountRef.current = 0;
          sm.setSessionOpen(true);
          sm.setMicActive(streamer.isActive());
          if (
            isReconnectAttemptRef.current &&
            sessionContextSummaryRef.current
          ) {
            session.sendRestoreSessionContext(sessionContextSummaryRef.current);
          }
          isReconnectAttemptRef.current = false;
          const memBridge = memoryBridgeRef.current;
          if (memBridge) {
            const payload = memBridge.getRelevantMemoriesPayload();
            session.sendMemoryContext({
              memories: memBridge.allMemories,
              retrievedBlock: payload.retrievedBlock,
            });
          }
          syncClientState();
        },
        onModelTurnStarted: () => {
          if (sessionRef.current !== session) return;
          diagnosticsRef.current?.markServerTurnCommitted();
        },
        onAudio: (base64Pcm16) => {
          if (sessionRef.current !== session) return;
          diagnosticsRef.current?.markFirstResponseAudioReceived();
          void player.enqueuePcm16Base64(base64Pcm16);
        },
        onInterrupted: () => {
          if (sessionRef.current !== session) return;
          diagnosticsRef.current?.recordInterruption();
          player.clear();
          sm.onInterrupted();
        },
        onTurnComplete: () => {
          if (sessionRef.current !== session) return;
          sm.onTurnComplete();
        },
        onExpression: (expression) => {
          if (sessionRef.current !== session) return;
          sm.setExpression(expression);
        },
        onVoiceMode: (mode) => {
          if (sessionRef.current !== session) return;
          voiceModeRef.current = mode;
          sm.setVoiceMode(mode);
        },
        onContextSummary: (summary) => {
          if (sessionRef.current !== session) return;
          sessionContextSummaryRef.current = summary;
        },
        onGeolocationRequest: (requestId) => {
          if (sessionRef.current !== session) return;
          void requestBrowserLocation().then((result) => {
            if (sessionRef.current === session) {
              session.sendGeolocationResult({ requestId, ...result });
            }
          });
        },
        onMemoryToolRequest: (request) => {
          if (sessionRef.current !== session) return;
          const memBridge = memoryBridgeRef.current;
          if (!memBridge) {
            session.sendMemoryToolResult({
              requestId: request.requestId,
              result: {
                status: "error",
                saved: false,
                message: "Memory Core is unavailable.",
              },
            });
            return;
          }
          void memBridge
            .handleVoiceToolAction(request)
            .then((result) => {
              if (sessionRef.current === session) {
                session.sendMemoryToolResult({
                  requestId: request.requestId,
                  result,
                });
                // Immediately refresh Live memory context snapshot after voice mutation
                const refreshed = memBridge.getRelevantMemoriesPayload();
                session.sendMemoryContext({
                  memories: memBridge.allMemories,
                  retrievedBlock: refreshed.retrievedBlock,
                });
              }
            })
            .catch((err) => {
              if (sessionRef.current === session) {
                session.sendMemoryToolResult({
                  requestId: request.requestId,
                  result: {
                    status: "error",
                    saved: false,
                    message:
                      err instanceof Error
                        ? err.message
                        : "Failed to access Memory Core.",
                  },
                });
              }
            });
        },
        onMemoryAutoSave: (candidate) => {
          if (sessionRef.current !== session) return;
          void memoryBridgeRef.current?.handleAsyncAutoSaveCandidate(candidate);
        },
        onMemoryApprovalRequested: (candidate) => {
          if (sessionRef.current !== session) return;
          memoryBridgeRef.current?.handleAsyncApprovalCandidate(candidate);
        },
        onError: (message) => {
          if (sessionRef.current !== session) return;
          manualCloseRef.current = true;
          teardownAll();
          sm.setError(message);
        },
        onClose: (intentional, reason) => {
          if (sessionRef.current !== session) return;
          const wasManual = manualCloseRef.current || intentional;
          if (streamerRef.current) {
            streamerRef.current.stop();
            streamerRef.current = null;
          }
          player.clear();
          sessionRef.current = null;
          inputLevelRef.current = 0;
          outputLevelRef.current = 0;
          userSpeakingRef.current = false;
          desiredMutedRef.current = false;
          lastSentClientStateRef.current.open = false;

          if (wasManual) {
            sm.resetDisconnected();
            return;
          }

          if (reconnectCountRef.current < MAX_AUTO_RECONNECTS) {
            reconnectCountRef.current += 1;
            sm.setConnecting();
            reconnectTimerRef.current = window.setTimeout(() => {
              reconnectTimerRef.current = null;
              if (!manualCloseRef.current) {
                void startConnection(true);
              }
            }, 800);
          } else {
            sm.setError(
              reason ||
                "Voice connection closed unexpectedly. Tap Connect to start a new session."
            );
          }
        },
      });
      sessionRef.current = session;

      try {
        await session.connect({
          voiceMode: isReconnect ? voiceModeRef.current : "normal",
        });
        if (attemptId !== connectionAttemptIdRef.current || manualCloseRef.current) {
          session.close();
          if (sessionRef.current === session) {
            teardownAll();
          }
        }
      } catch (err) {
        if (attemptId === connectionAttemptIdRef.current && sessionRef.current === session) {
          teardownAll();
          sm.setError(
            err instanceof Error
              ? err.message
              : "Failed to connect to Gemini Live."
          );
        }
      } finally {
        if (attemptId === connectionAttemptIdRef.current) {
          connectingRef.current = false;
        }
      }
    },
    [ensurePlayer, syncClientState, teardownAll]
  );

  const connect = useCallback(() => {
    void startConnection(false);
  }, [startConnection]);

  const disconnect = useCallback(() => {
    manualCloseRef.current = true;
    connectionAttemptIdRef.current += 1;
    connectingRef.current = false;
    isReconnectAttemptRef.current = false;
    sessionContextSummaryRef.current = null;
    voiceModeRef.current = "normal";
    teardownAll();
    stateManagerRef.current?.resetDisconnected();
  }, [teardownAll]);

  const toggleMute = useCallback(() => {
    const sm = stateManagerRef.current;
    const streamer = streamerRef.current;
    if (!sm || !streamer) return;
    const current = sm.getSnapshot();
    if (!current.isSessionOpen) return;

    const seq = ++muteSeqRef.current;
    const nextMuted = !desiredMutedRef.current;
    desiredMutedRef.current = nextMuted;

    if (!nextMuted) {
      // Unmute synchronously in UI state, then verify/recover capture health & AudioContext resume
      sm.setMuted(false);
      syncClientState();
      void streamer.ensureActiveAndUnmute().then((healthy) => {
        if (seq !== muteSeqRef.current || desiredMutedRef.current) return;
        const snap = stateManagerRef.current?.getSnapshot();
        if (!snap?.isSessionOpen) return;
        if (healthy) {
          sm.setMicActive(streamer.isActive());
          syncClientState();
        }
      });
      return;
    }

    const wasSpeakingBeforeMute = userSpeakingRef.current;
    // Apply muted state synchronously so rapid taps cannot read stale isMuted=false
    userSpeakingRef.current = false;
    sm.setMuted(true, wasSpeakingBeforeMute);
    syncClientState();

    void streamer.flushAndMute().then(({ hadRecentSpeech }) => {
      if (seq !== muteSeqRef.current || !desiredMutedRef.current) return;
      const spokeRecently = wasSpeakingBeforeMute || hadRecentSpeech;
      if (spokeRecently) {
        diagnosticsRef.current?.markUserSpeechCompleted(true);
        if (!wasSpeakingBeforeMute) {
          sm.setMuted(true, true);
        }
      }
      syncClientState();
      if (spokeRecently) {
        sessionRef.current?.sendAudioStreamEnd();
      }
    });
  }, [syncClientState]);

  const getDiagnosticsMetrics = useCallback((): AudioReliabilityMetrics => {
    return diagnosticsRef.current!.getMetrics();
  }, []);

  const syncMemoryContext = useCallback(
    (allMemories: MemoryRecord[], retrievedBlock: string) => {
      if (sessionRef.current?.isOpen()) {
        sessionRef.current.sendMemoryContext({
          memories: allMemories,
          retrievedBlock,
        });
      }
    },
    []
  );

  const notifyMemoryApprovalResolution = useCallback(
    (decision: "approve" | "decline", description?: string) => {
      if (sessionRef.current?.isOpen()) {
        sessionRef.current.sendMemoryApprovalResolution({
          decision,
          description,
        });
      }
    },
    []
  );

  useEffect(() => {
    const sm = stateManagerRef.current!;
    const unsubscribe = sm.subscribe((next) => {
      setSnapshot(next);
      syncClientState();
    });
    return () => {
      unsubscribe();
      manualCloseRef.current = true;
      connectionAttemptIdRef.current += 1;
      teardownAll();
      if (playerRef.current) {
        void playerRef.current.dispose();
        playerRef.current = null;
      }
    };
  }, [syncClientState, teardownAll]);

  return {
    snapshot,
    connect,
    disconnect,
    toggleMute,
    getDiagnosticsMetrics,
    syncMemoryContext,
    notifyMemoryApprovalResolution,
  };
}
