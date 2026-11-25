import { useState } from "react";
import { Check, Loader2, Sparkles, X } from "lucide-react";
import { useMemoryCore } from "../memory/MemoryProvider";

interface MemoryStatusOverlayProps {
  onApprovalResolved?: (
    decision: "approve" | "decline",
    description?: string
  ) => void;
}

export function MemoryStatusOverlay({
  onApprovalResolved,
}: MemoryStatusOverlayProps) {
  const {
    pendingApproval,
    autoSaveNotice,
    approvePendingMemory,
    declinePendingMemory,
    dismissAutoSaveNotice,
    openDrawer,
  } = useMemoryCore();

  const [submittingDecision, setSubmittingDecision] = useState(false);

  if (!pendingApproval && !autoSaveNotice) {
    return null;
  }

  const handleApprove = async () => {
    if (!pendingApproval || submittingDecision) return;
    setSubmittingDecision(true);
    const description = pendingApproval.description;
    try {
      const result = await approvePendingMemory();
      if (result.ok) {
        onApprovalResolved?.("approve", description);
      }
    } finally {
      setSubmittingDecision(false);
    }
  };

  const handleDecline = () => {
    if (!pendingApproval || submittingDecision) return;
    const declined = declinePendingMemory();
    if (declined) {
      onApprovalResolved?.("decline", declined);
    }
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-30 flex flex-col items-center gap-2.5 px-4 sm:bottom-28">
      {pendingApproval && (
        <div
          role="region"
          aria-label="Important memory permission request"
          className="pointer-events-auto w-full max-w-md rounded-2xl border border-sky-400/35 bg-[#0B111C]/95 p-4 text-slate-100 shadow-2xl backdrop-blur-xl"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="font-mono text-[11px] font-medium tracking-[0.08em] text-sky-300 uppercase">
                Confirm Important Memory · {pendingApproval.category}
              </p>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-100">
                “{pendingApproval.description}”
              </p>
            </div>
          </div>

          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              disabled={submittingDecision}
              onClick={handleDecline}
              className="inline-flex min-h-[44px] items-center gap-1.5 whitespace-nowrap rounded-xl border border-slate-700/80 bg-slate-900/80 px-4 py-2 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-800"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Decline</span>
            </button>
            <button
              type="button"
              disabled={submittingDecision}
              onClick={() => void handleApprove()}
              className="inline-flex min-h-[44px] items-center gap-1.5 whitespace-nowrap rounded-xl border border-sky-400/40 bg-sky-500/20 px-4 py-2 text-xs font-semibold text-sky-100 transition-colors hover:bg-sky-500/30 disabled:opacity-60"
            >
              {submittingDecision ? (
                <Loader2
                  className="h-3.5 w-3.5 animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <span>Approve</span>
            </button>
          </div>
        </div>
      )}

      {autoSaveNotice && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-auto flex w-full max-w-md items-center justify-between gap-3 rounded-2xl border border-slate-800/90 bg-[#0B1019]/92 px-4 py-2.5 text-xs text-slate-200 shadow-xl backdrop-blur-xl"
        >
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <Sparkles
              className="h-4 w-4 shrink-0 text-sky-400"
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <span className="font-medium text-sky-200">
                {autoSaveNotice.action === "updated"
                  ? "Updated memory"
                  : "Saved memory"}
              </span>
              {" · "}
              <span className="truncate text-slate-300">
                {autoSaveNotice.description}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => openDrawer(autoSaveNotice.memoryId)}
              className="inline-flex min-h-[36px] items-center rounded-lg px-2.5 py-1 text-xs font-medium text-sky-300 transition-colors hover:bg-sky-500/15"
            >
              Review
            </button>
            <button
              type="button"
              onClick={dismissAutoSaveNotice}
              aria-label="Dismiss memory notice"
              className="inline-flex min-h-[36px] min-w-[36px] items-center justify-center rounded-lg text-slate-400 transition-colors hover:text-slate-200"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
