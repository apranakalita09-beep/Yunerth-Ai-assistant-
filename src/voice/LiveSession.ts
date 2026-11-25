import type {
  AnalyzedMemoryCandidate,
  MemoryAutoSaveNotice,
  MemoryRecord,
  MemoryToolRelayRequest,
} from "../memory/types";
import type {
  ExpressionState,
  SessionContextSummary,
  VoiceSpeedMode,
} from "./types";

const HEARTBEAT_INTERVAL_MS = 15000;
const HEARTBEAT_TIMEOUT_MS = 28000;
const CONNECT_TIMEOUT_MS = 15000;

export interface LiveSessionCallbacks {
  onReady: () => void;
  onModelTurnStarted?: () => void;
  onAudio: (base64Pcm16: string) => void;
  onInterrupted: () => void;
  onTurnComplete: () => void;
  onExpression?: (expression: ExpressionState) => void;
  onVoiceMode?: (mode: VoiceSpeedMode) => void;
  onContextSummary?: (summary: SessionContextSummary) => void;
  onGeolocationRequest?: (requestId: string) => void;
  onMemoryToolRequest?: (request: MemoryToolRelayRequest) => void;
  onMemoryAutoSave?: (candidate: AnalyzedMemoryCandidate) => void;
  onMemoryApprovalRequested?: (candidate: AnalyzedMemoryCandidate) => void;
  onError: (message: string, code?: string) => void;
  onClose: (intentional: boolean, reason?: string) => void;
}

interface ServerLiveEvent {
  type:
    | "ready"
    | "modelTurnStarted"
    | "audio"
    | "interrupted"
    | "turnComplete"
    | "expression"
    | "voiceMode"
    | "contextSummary"
    | "requestGeolocation"
    | "memoryToolRequest"
    | "memoryAutoSave"
    | "memoryApprovalRequested"
    | "pong"
    | "error"
    | "closed";
  data?: string;
  expression?: ExpressionState;
  mode?: VoiceSpeedMode;
  summary?: SessionContextSummary;
  requestId?: string;
  action?: MemoryToolRelayRequest["action"];
  args?: Record<string, unknown>;
  candidate?: AnalyzedMemoryCandidate;
  notice?: MemoryAutoSaveNotice;
  ts?: number;
  message?: string;
  code?: string;
  reason?: string;
}

export class LiveSession {
  private ws: WebSocket | null = null;
  private ready = false;
  private intentionalClose = false;
  private heartbeatTimer: number | null = null;
  private lastServerActivityAt = 0;
  private readonly callbacks: LiveSessionCallbacks;

  constructor(callbacks: LiveSessionCallbacks) {
    this.callbacks = callbacks;
  }

  connect(options?: { voiceMode?: VoiceSpeedMode }): Promise<void> {
    if (this.ws) {
      this.close();
    }

    this.intentionalClose = false;
    this.ready = false;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const params = new URLSearchParams();
    try {
      const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (detectedTz) {
        params.set("tz", detectedTz);
      }
    } catch {
      // Proceed without local tz if Intl detection is unavailable
    }
    if (options?.voiceMode) {
      params.set("mode", options.voiceMode);
    }
    const query = params.toString();
    const url = `${protocol}//${window.location.host}/live${query ? `?${query}` : ""}`;

    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url);
      this.ws = ws;
      this.lastServerActivityAt = Date.now();

      const connectTimeout = window.setTimeout(() => {
        if (this.ws !== ws) return;
        if (!settled) {
          settled = true;
          this.stopHeartbeat();
          try {
            ws.close();
          } catch {
            // Ignore close failure on timed-out connect
          }
          reject(new Error("Connection to Yunerth timed out. Please try again."));
        }
      }, CONNECT_TIMEOUT_MS);

      ws.onmessage = (event) => {
        if (this.ws !== ws) return;
        this.lastServerActivityAt = Date.now();
        try {
          const msg = JSON.parse(event.data as string) as ServerLiveEvent;
          switch (msg.type) {
            case "ready":
              this.ready = true;
              this.startHeartbeat(ws);
              if (!settled) {
                settled = true;
                window.clearTimeout(connectTimeout);
                resolve();
              }
              this.callbacks.onReady();
              break;
            case "modelTurnStarted":
              this.callbacks.onModelTurnStarted?.();
              break;
            case "audio":
              if (msg.data) {
                this.callbacks.onAudio(msg.data);
              }
              break;
            case "interrupted":
              this.callbacks.onInterrupted();
              break;
            case "turnComplete":
              this.callbacks.onTurnComplete();
              break;
            case "expression":
              if (msg.expression) {
                this.callbacks.onExpression?.(msg.expression);
              }
              break;
            case "voiceMode":
              if (
                msg.mode === "slow" ||
                msg.mode === "normal" ||
                msg.mode === "fast"
              ) {
                this.callbacks.onVoiceMode?.(msg.mode);
              }
              break;
            case "contextSummary":
              if (msg.summary) {
                this.callbacks.onContextSummary?.(msg.summary);
              }
              break;
            case "requestGeolocation":
              if (msg.requestId) {
                this.callbacks.onGeolocationRequest?.(msg.requestId);
              }
              break;
            case "memoryToolRequest":
              if (msg.requestId && msg.action) {
                this.callbacks.onMemoryToolRequest?.({
                  requestId: msg.requestId,
                  action: msg.action,
                  args: msg.args ?? {},
                });
              }
              break;
            case "memoryAutoSave":
              if (msg.candidate) {
                this.callbacks.onMemoryAutoSave?.(msg.candidate);
              }
              break;
            case "memoryApprovalRequested":
              if (msg.candidate) {
                this.callbacks.onMemoryApprovalRequested?.(msg.candidate);
              }
              break;
            case "pong":
              // Heartbeat acknowledged
              break;
            case "error": {
              const errMsg =
                msg.message || "Voice session encountered an error.";
              if (!settled) {
                settled = true;
                window.clearTimeout(connectTimeout);
                reject(new Error(errMsg));
              } else {
                this.callbacks.onError(errMsg, msg.code);
              }
              break;
            }
            case "closed":
              if (!settled) {
                settled = true;
                window.clearTimeout(connectTimeout);
                reject(new Error(msg.reason || "Live session closed."));
              }
              break;
          }
        } catch (err) {
          console.error("Malformed Live server event:", err);
        }
      };

      ws.onerror = () => {
        if (this.ws !== ws) return;
        if (!settled) {
          settled = true;
          window.clearTimeout(connectTimeout);
          this.stopHeartbeat();
          reject(
            new Error(
              "Unable to reach the Yunerth voice server. Check your connection and try again."
            )
          );
          return;
        }
        // Transport errored mid-session: ensure socket transitions through close/recovery
        if (
          ws.readyState === WebSocket.OPEN ||
          ws.readyState === WebSocket.CONNECTING
        ) {
          try {
            ws.close(4000, "Voice socket transport error.");
          } catch {
            // Ignore close failure
          }
        }
      };

      ws.onclose = (event) => {
        if (this.ws !== ws) return;
        window.clearTimeout(connectTimeout);
        this.stopHeartbeat();
        const wasIntentional = this.intentionalClose;
        this.ready = false;
        this.ws = null;
        if (!settled) {
          settled = true;
          reject(
            new Error(
              event.reason || "Connection closed before the voice session started."
            )
          );
        } else {
          this.callbacks.onClose(wasIntentional, event.reason);
        }
      };
    });
  }

  sendAudio(base64Pcm16: string): void {
    if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.safeSend({ type: "audio", data: base64Pcm16 });
  }

  sendAudioStreamEnd(): void {
    if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.safeSend({ type: "audioStreamEnd" });
  }

  sendClientState(state: {
    playbackActive: boolean;
    userSpeaking: boolean;
    muted: boolean;
  }): void {
    if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.safeSend({ type: "clientState", ...state });
  }

  sendGeolocationResult(payload: {
    requestId: string;
    status: "granted" | "denied" | "unavailable";
    latitude?: number;
    longitude?: number;
  }): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.safeSend({ type: "geolocationResult", ...payload });
  }

  sendRestoreSessionContext(summary: SessionContextSummary): void {
    if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.safeSend({ type: "restoreSessionContext", summary });
  }

  sendMemoryContext(payload: {
    memories: MemoryRecord[];
    retrievedBlock: string;
  }): void {
    if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.safeSend({
      type: "memoryContext",
      memories: payload.memories,
      retrievedBlock: payload.retrievedBlock,
    });
  }

  sendMemoryToolResult(payload: {
    requestId: string;
    result: Record<string, unknown>;
  }): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.safeSend({ type: "memoryToolResult", ...payload });
  }

  sendMemoryApprovalResolution(payload: {
    decision: "approve" | "decline";
    description?: string;
  }): void {
    if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.safeSend({ type: "memoryApprovalResolution", ...payload });
  }

  sendPing(): void {
    if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.safeSend({ type: "ping", ts: Date.now() });
  }

  isOpen(): boolean {
    return this.ready && this.ws?.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.intentionalClose = true;
    this.ready = false;
    this.stopHeartbeat();
    if (this.ws) {
      const socket = this.ws;
      this.ws = null;
      // Detach handlers first so tearing down an old socket during reconnect never
      // invokes a late onClose() against a newly connecting session.
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        try {
          socket.close(1000, "User disconnected");
        } catch {
          // Ignore errors when closing an already closing socket
        }
      }
    }
  }

  private safeSend(payload: Record<string, unknown>): void {
    const socket = this.ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      socket.send(JSON.stringify(payload));
    } catch (err) {
      console.error("Failed to send message over Live WebSocket:", err);
      this.stopHeartbeat();
      this.ready = false;
      try {
        socket.close(4002, "Failed to transmit voice data.");
      } catch {
        // Ignore close error
      }
    }
  }

  private startHeartbeat(ws: WebSocket): void {
    this.stopHeartbeat();
    if (typeof window === "undefined") return;
    this.heartbeatTimer = window.setInterval(() => {
      if (this.ws !== ws || !this.ready) {
        this.stopHeartbeat();
        return;
      }
      if (Date.now() - this.lastServerActivityAt > HEARTBEAT_TIMEOUT_MS) {
        this.stopHeartbeat();
        try {
          ws.close(4001, "Voice connection heartbeat timed out.");
        } catch {
          // Ignore close error
        }
        return;
      }
      this.sendPing();
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null && typeof window !== "undefined") {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
