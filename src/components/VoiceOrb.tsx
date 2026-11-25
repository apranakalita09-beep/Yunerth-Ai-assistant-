import { Mic, MicOff, Volume2, AlertTriangle, Loader2 } from "lucide-react";
import type { VoiceState } from "../voice/types";

interface VoiceOrbProps {
  state: VoiceState;
  isMuted: boolean;
  inputLevel: number;
  outputLevel: number;
}

export function VoiceOrb({
  state,
  isMuted,
  inputLevel,
  outputLevel,
}: VoiceOrbProps) {
  const activeEnergy =
    state === "SPEAKING"
      ? outputLevel
      : state === "USER SPEAKING" || state === "LISTENING"
        ? inputLevel
        : 0;

  const outerScale = 1 + activeEnergy * 0.24;
  const midScale = 1 + activeEnergy * 0.14;
  const coreScale = 1 + activeEnergy * 0.08;

  const isError = state === "ERROR";
  const isConnecting = state === "CONNECTING";
  const isSpeaking = state === "SPEAKING";
  const isUserSpeaking = state === "USER SPEAKING";
  const isThinking = state === "THINKING";
  const isListening = state === "LISTENING";
  const isConnectedMuted = state === "CONNECTED" && isMuted;

  const auraClass = isError
    ? "bg-rose-500/20"
    : isThinking
      ? "bg-violet-400/20"
      : isListening || isUserSpeaking
        ? "bg-emerald-400/20"
        : isSpeaking || state === "CONNECTED"
          ? "bg-sky-400/22"
          : "bg-slate-500/10";

  const ringBorderClass = isError
    ? "border-rose-400/40"
    : isThinking
      ? "border-violet-400/40"
      : isUserSpeaking
        ? "border-emerald-300/60"
        : isListening
          ? "border-emerald-400/35"
          : isSpeaking
            ? "border-sky-300/65"
            : state === "CONNECTED" || isConnecting
              ? "border-sky-400/35"
              : "border-slate-700/60";

  const coreBorderClass = isError
    ? "border-rose-400/50 bg-[#140C12]"
    : isThinking
      ? "border-violet-400/50 bg-[#100E1B]"
      : isUserSpeaking || isListening
        ? "border-emerald-400/50 bg-[#0A1614]"
        : isSpeaking || state === "CONNECTED" || isConnecting
          ? "border-sky-400/55 bg-[#0A1420]"
          : "border-slate-700/70 bg-[#0C111B]";

  const renderCenterGlyph = () => {
    if (isError) {
      return (
        <AlertTriangle
          className="h-9 w-9 text-rose-300 transition-transform duration-200"
          aria-hidden="true"
        />
      );
    }
    if (isConnecting) {
      return (
        <Loader2
          className="h-9 w-9 animate-spin text-sky-300"
          aria-hidden="true"
        />
      );
    }
    if (isSpeaking) {
      return (
        <Volume2
          className="h-9 w-9 text-sky-300 transition-transform duration-150"
          aria-hidden="true"
        />
      );
    }
    if (isConnectedMuted) {
      return (
        <MicOff
          className="h-9 w-9 text-slate-400 transition-transform duration-150"
          aria-hidden="true"
        />
      );
    }
    if (isThinking) {
      return (
        <div className="flex items-center gap-1.5" aria-hidden="true">
          <span className="h-2 w-2 rounded-full bg-violet-300 animate-orb-breathe" />
          <span
            className="h-2 w-2 rounded-full bg-violet-300 animate-orb-breathe"
            style={{ animationDelay: "180ms" }}
          />
          <span
            className="h-2 w-2 rounded-full bg-violet-300 animate-orb-breathe"
            style={{ animationDelay: "360ms" }}
          />
        </div>
      );
    }
    return (
      <Mic
        className={`h-9 w-9 transition-colors duration-200 ${
          isUserSpeaking
            ? "text-emerald-200"
            : isListening
              ? "text-emerald-300"
              : state === "CONNECTED"
                ? "text-sky-300"
                : "text-slate-400"
        }`}
        aria-hidden="true"
      />
    );
  };

  return (
    <div className="relative flex h-64 w-64 items-center justify-center sm:h-72 sm:w-72">
      {/* Soft ambient radial aura driven by audio energy */}
      <div
        className={`pointer-events-none absolute inset-4 rounded-full blur-3xl transition-colors duration-500 ${auraClass}`}
        style={{
          transform: `scale(${outerScale})`,
          transitionProperty: "transform, background-color, opacity",
          transitionDuration: "120ms, 400ms, 300ms",
        }}
      />

      {/* Outer orbital precision ring */}
      <div
        className={`pointer-events-none absolute inset-3 rounded-full border border-dashed transition-colors duration-300 ${ringBorderClass} ${
          state !== "DISCONNECTED" && !isError ? "animate-orb-ring-spin" : ""
        }`}
        style={{
          transform: `scale(${outerScale})`,
          opacity: state === "DISCONNECTED" ? 0.35 : 0.78,
          transitionProperty: "transform, opacity, border-color",
          transitionDuration: "90ms, 300ms, 300ms",
        }}
      />

      {/* Middle acoustic wave ring */}
      <div
        className={`pointer-events-none absolute inset-10 rounded-full border transition-colors duration-300 ${ringBorderClass} ${
          isListening || isConnecting || isThinking ? "animate-orb-breathe" : ""
        }`}
        style={{
          transform: `scale(${midScale})`,
          opacity: state === "DISCONNECTED" ? 0.45 : 0.9,
          transitionProperty: "transform, opacity, border-color",
          transitionDuration: "80ms, 300ms, 300ms",
        }}
      />

      {/* Inner tactile orb core */}
      <div
        className={`relative flex h-32 w-32 items-center justify-center rounded-full border shadow-[0_0_50px_rgba(15,23,42,0.85)] transition-colors duration-300 sm:h-36 sm:w-36 ${coreBorderClass}`}
        style={{
          transform: `scale(${coreScale})`,
          transitionProperty: "transform, border-color, background-color",
          transitionDuration: "80ms, 250ms, 250ms",
        }}
      >
        <div
          className="pointer-events-none absolute inset-2 rounded-full border border-white/[0.06]"
          aria-hidden="true"
        />
        {renderCenterGlyph()}
      </div>
    </div>
  );
}
