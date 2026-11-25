import { useEffect, useMemo, useRef } from "react";
import {
  AlertCircle,
  AudioWaveform,
  Brain,
  BrainCircuit,
  CheckCircle2,
  Loader2,
  Mic,
  PowerOff,
  Volume2,
} from "lucide-react";
import { MemoryCoreDrawer } from "./components/MemoryCoreDrawer";
import { MemoryStatusOverlay } from "./components/MemoryStatusOverlay";
import { VoiceControls } from "./components/VoiceControls";
import { VoiceOrb } from "./components/VoiceOrb";
import { useMemoryCore } from "./memory/MemoryProvider";
import type { VoiceState } from "./voice/types";
import { useYunerthVoice } from "./voice/useYunerthVoice";

function getStatusPresentation(
  state: VoiceState,
  isMuted: boolean,
  errorMessage: string | null
) {
  switch (state) {
    case "DISCONNECTED":
      return {
        colorClass: "text-slate-400",
        helper: "Tap Connect to start a live voice conversation.",
        icon: <PowerOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />,
      };
    case "CONNECTING":
      return {
        colorClass: "text-sky-300",
        helper: "Preparing microphone and opening voice session...",
        icon: (
          <Loader2
            className="h-3.5 w-3.5 shrink-0 animate-spin"
            aria-hidden="true"
          />
        ),
      };
    case "CONNECTED":
      return {
        colorClass: "text-sky-300",
        helper: isMuted
          ? "Microphone is muted. Tap Unmute when you want to speak."
          : "Connected to Yunerth.",
        icon: (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        ),
      };
    case "LISTENING":
      return {
        colorClass: "text-emerald-300",
        helper: "Yunerth is listening. Speak naturally.",
        icon: <Mic className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />,
      };
    case "USER SPEAKING":
      return {
        colorClass: "text-emerald-200",
        helper: "Hearing your voice...",
        icon: (
          <AudioWaveform
            className="h-3.5 w-3.5 shrink-0"
            aria-hidden="true"
          />
        ),
      };
    case "THINKING":
      return {
        colorClass: "text-violet-300",
        helper: "Yunerth is preparing a response...",
        icon: (
          <BrainCircuit className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        ),
      };
    case "SPEAKING":
      return {
        colorClass: "text-sky-200",
        helper: "Yunerth is speaking.",
        icon: <Volume2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />,
      };
    case "ERROR":
      return {
        colorClass: "text-rose-300",
        helper:
          errorMessage ||
          "Something went wrong with the voice connection. Try reconnecting.",
        icon: (
          <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        ),
      };
  }
}

export default function App() {
  const {
    memories,
    syncStatus,
    pendingApproval,
    openDrawer,
    getRelevantMemoriesPayload,
    handleVoiceToolAction,
    handleAsyncAutoSaveCandidate,
    handleAsyncApprovalCandidate,
  } = useMemoryCore();

  const memoryBridge = useMemo(
    () => ({
      getRelevantMemoriesPayload,
      allMemories: memories,
      handleVoiceToolAction,
      handleAsyncAutoSaveCandidate,
      handleAsyncApprovalCandidate,
    }),
    [
      getRelevantMemoriesPayload,
      memories,
      handleVoiceToolAction,
      handleAsyncAutoSaveCandidate,
      handleAsyncApprovalCandidate,
    ]
  );

  const {
    snapshot,
    connect,
    disconnect,
    toggleMute,
    syncMemoryContext,
    notifyMemoryApprovalResolution,
  } = useYunerthVoice(memoryBridge);

  const lastSyncedMemorySignatureRef = useRef<string | null>(null);

  useEffect(() => {
    if (!snapshot.isSessionOpen) {
      lastSyncedMemorySignatureRef.current = null;
      return;
    }
    const contentSignature = memories
      .map((m) => `${m.id}:${m.category}:${m.description}`)
      .join("|");
    if (lastSyncedMemorySignatureRef.current === contentSignature) {
      return;
    }
    lastSyncedMemorySignatureRef.current = contentSignature;
    const payload = getRelevantMemoriesPayload();
    syncMemoryContext(memories, payload.retrievedBlock);
  }, [
    memories,
    snapshot.isSessionOpen,
    getRelevantMemoriesPayload,
    syncMemoryContext,
  ]);

  const statusInfo = getStatusPresentation(
    snapshot.state,
    snapshot.isMuted,
    snapshot.errorMessage
  );

  const showBrainAlertDot =
    pendingApproval !== null ||
    syncStatus === "error" ||
    syncStatus === "auth_expired" ||
    syncStatus === "offline";

  return (
    <div className="relative flex min-h-dvh w-full flex-col overflow-hidden bg-[#07090E] text-slate-100">
      {/* Subtle atmospheric radial gradient background */}
      <div
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_42%,rgba(56,189,248,0.08),transparent_58%)]"
        aria-hidden="true"
      />

      <main className="relative z-10 mx-auto flex w-full max-w-4xl flex-1 flex-col items-center justify-between px-6 pt-[max(2rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))] sm:px-10 sm:py-12">
        {/* Assistant Identity Area + Subtle Memory Core Header Trigger */}
        <header className="relative flex w-full flex-col items-center text-center">
          <h1 className="font-display text-3xl font-semibold tracking-tight text-slate-50 sm:text-4xl">
            Yunerth
          </h1>
          <p className="mt-1.5 text-sm font-normal text-slate-400">
            Personal AI Voice Assistant
          </p>

          <button
            type="button"
            onClick={() => openDrawer()}
            aria-label="Open Yunerth Memory Core"
            title="Yunerth Memory Core"
            className="absolute top-0 right-0 inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-slate-800/80 bg-[#0B1019]/80 text-slate-300 transition-colors hover:border-sky-400/40 hover:text-sky-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
          >
            <Brain className="h-5 w-5" aria-hidden="true" />
            {showBrainAlertDot && (
              <span
                aria-hidden="true"
                className={`absolute top-2 right-2 h-2 w-2 rounded-full ${
                  pendingApproval
                    ? "bg-sky-400"
                    : syncStatus === "error" || syncStatus === "auth_expired"
                      ? "bg-rose-400"
                      : "bg-amber-400"
                }`}
              />
            )}
          </button>
        </header>

        {/* Central Voice Stage & Live State Indicator */}
        <section
          aria-label="Voice assistant status and orb"
          className="my-auto flex w-full flex-col items-center justify-center py-6"
        >
          <VoiceOrb
            state={snapshot.state}
            isMuted={snapshot.isMuted}
            inputLevel={snapshot.inputLevel}
            outputLevel={snapshot.outputLevel}
          />

          <div
            role="status"
            aria-live="polite"
            className="mt-6 flex max-w-md flex-col items-center text-center"
          >
            <div
              className={`inline-flex items-center gap-2 font-mono text-xs font-medium tracking-[0.14em] ${statusInfo.colorClass}`}
            >
              {statusInfo.icon}
              <span>{snapshot.state}</span>
            </div>
            <p className="mt-2.5 min-h-[2.75rem] text-sm leading-relaxed text-slate-300/90">
              {statusInfo.helper}
            </p>
          </div>
        </section>

        {/* Thumb-Zone Voice & Power Controls */}
        <footer className="flex w-full flex-col items-center gap-3 pt-2">
          <VoiceControls
            state={snapshot.state}
            isSessionOpen={snapshot.isSessionOpen}
            isMuted={snapshot.isMuted}
            onConnect={connect}
            onDisconnect={disconnect}
            onToggleMute={toggleMute}
          />
          <p className="text-[11px] tracking-wide text-slate-500/80">
            Weather data by{" "}
            <a
              href="https://open-meteo.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-slate-400/90 underline decoration-slate-600/60 underline-offset-2 transition-colors hover:text-slate-300"
            >
              Open-Meteo
            </a>
          </p>
        </footer>
      </main>

      <MemoryStatusOverlay
        onApprovalResolved={(decision, description) =>
          notifyMemoryApprovalResolution(decision, description)
        }
      />
      <MemoryCoreDrawer />
    </div>
  );
}
