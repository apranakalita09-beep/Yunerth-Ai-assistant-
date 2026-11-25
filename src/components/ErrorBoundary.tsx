import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = {
    hasError: false,
    message: "",
  };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      message:
        error?.message || "An unexpected interface error interrupted this view.",
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Yunerth ErrorBoundary caught error:", error, info);
  }

  private handleReload = () => {
    this.setState({ hasError: false, message: "" });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-dvh w-full items-center justify-center bg-[#07090E] px-6 text-slate-100">
          <div className="w-full max-w-md rounded-2xl border border-slate-800/80 bg-[#0B1019]/90 p-6 shadow-2xl">
            <h2 className="font-display text-lg font-semibold text-slate-100">
              Something went wrong
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">
              Yunerth ran into an unexpected error. Your active session state can
              be restored safely.
            </p>
            {this.state.message && (
              <p className="mt-3 rounded-lg border border-rose-500/25 bg-rose-500/10 px-3 py-2 font-mono text-xs text-rose-200 break-words">
                {this.state.message}
              </p>
            )}
            <button
              type="button"
              onClick={this.handleReload}
              className="mt-5 inline-flex min-h-[44px] w-full items-center justify-center rounded-xl border border-sky-400/30 bg-sky-500/15 px-4 py-2.5 text-sm font-medium text-sky-200 transition-colors hover:bg-sky-500/25"
            >
              Recover View
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
