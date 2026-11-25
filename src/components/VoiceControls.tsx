import { Mic, MicOff, Power } from "lucide-react";
import type { VoiceState } from "../voice/types";

interface VoiceControlsProps {
  state: VoiceState;
  isSessionOpen: boolean;
  isMuted: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onToggleMute: () => void;
}

export function VoiceControls({
  state,
  isSessionOpen,
  isMuted,
  onConnect,
  onDisconnect,
  onToggleMute,
}: VoiceControlsProps) {
  const isConnecting = state === "CONNECTING";
  const isActive = isSessionOpen || isConnecting;
  const canToggleMic = isSessionOpen && !isConnecting;

  const handlePowerClick = () => {
    if (isActive) {
      onDisconnect();
    } else {
      onConnect();
    }
  };

  return (
    <div className="flex w-full max-w-sm items-center justify-center gap-4">
      <button
        type="button"
        onClick={handlePowerClick}
        aria-label={isActive ? "Disconnect Yunerth" : "Connect to Yunerth"}
        className={`inline-flex h-14 flex-1 items-center justify-center gap-2.5 rounded-2xl px-6 text-sm font-semibold whitespace-nowrap transition-all duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 active:scale-[0.98] ${
          isActive
            ? "border border-slate-700/80 bg-[#121927] text-slate-100 hover:border-rose-400/50 hover:bg-rose-950/35 hover:text-rose-100"
            : "bg-sky-400 text-slate-950 shadow-[0_8px_30px_rgba(56,189,248,0.22)] hover:bg-sky-300"
        }`}
      >
        <Power className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>
          {isConnecting
            ? "Cancel"
            : isSessionOpen
              ? "Disconnect"
              : state === "ERROR"
                ? "Reconnect"
                : "Connect"}
        </span>
      </button>

      <button
        type="button"
        onClick={onToggleMute}
        disabled={!canToggleMic}
        aria-label={isMuted ? "Unmute microphone" : "Mute microphone"}
        aria-pressed={isMuted}
        className={`inline-flex h-14 min-w-[128px] items-center justify-center gap-2 rounded-2xl border px-5 text-sm font-medium whitespace-nowrap transition-all duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 ${
          !canToggleMic
            ? "border-slate-800/80 bg-[#0E131D] text-slate-500"
            : isMuted
              ? "border-amber-400/40 bg-amber-950/25 text-amber-200 hover:bg-amber-950/40"
              : "border-emerald-400/35 bg-emerald-950/25 text-emerald-200 hover:bg-emerald-950/40"
        }`}
      >
        {isMuted ? (
          <>
            <MicOff className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>Unmute</span>
          </>
        ) : (
          <>
            <Mic className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>Mute</span>
          </>
        )}
      </button>
    </div>
  );
}
