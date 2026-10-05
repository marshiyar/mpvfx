import { useState } from "react";
import { toastPresentation } from "./toastPresentation";

interface StudioToastProps {
  message: string;
  tone?: "error" | "info";
  occurrences?: number;
  details?: readonly string[];
  /** Plays the exit animation when true (owner removes the node after ~160ms). */
  leaving?: boolean;
  onDismiss?: () => void;
}

export function StudioToast({
  message, tone, occurrences = 1, details = [message], leaving, onDismiss,
}: StudioToastProps) {
  const isError = tone === "error";
  const { summary, hint } = toastPresentation(message, tone ?? "info");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const fullDetails = details.join("\n\n");

  const copyDetails = async () => {
    try {
      await navigator.clipboard.writeText(fullDetails);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <div
      className={`pointer-events-auto w-fit max-w-[min(340px,calc(100vw-24px))] rounded-lg border px-2.5 py-1.5 text-[11px] motion-reduce:animate-none ${
        isError
          ? "border-red-500/40 bg-red-950 text-red-100"
          : "border-neutral-700 bg-neutral-900 text-neutral-200"
      } ${leaving ? "hf-toast-exit" : "hf-toast-enter"}`}
    >
      <div className="flex items-start gap-2">
        <span role={isError ? "alert" : "status"} className="min-w-0 flex-1 break-words leading-4">
          {summary}
          {isError && occurrences > 1 && (
            <span className="ml-1 whitespace-nowrap text-red-300">
              ×{occurrences}
              <span className="sr-only"> occurrences</span>
            </span>
          )}
        </span>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="shrink-0 rounded px-1 text-neutral-400 hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-studio-accent"
            aria-label="Dismiss notification"
          >
            ×
          </button>
        )}
      </div>
      {isError && (
        <>
          {hint && <p className="mt-1 text-red-200/80">{hint}</p>}
          <details className="mt-1 border-t border-red-400/20 pt-1">
            <summary className="w-fit cursor-pointer text-red-200 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-studio-accent">
              Technical details
            </summary>
            <div className="mt-1 max-h-40 max-w-full overflow-auto rounded border border-red-400/20 bg-black/30 p-1.5">
              <pre className="whitespace-pre-wrap break-all text-[10px] leading-4" style={{ userSelect: "text", WebkitUserSelect: "text" }}>
                {fullDetails}
              </pre>
            </div>
            <button
              type="button"
              onClick={() => void copyDetails()}
              className="mt-1 rounded px-1 py-0.5 text-red-200 hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-studio-accent"
            >
              {copyState === "copied" ? "Copied" : "Copy details"}
            </button>
            {copyState === "failed" && <span role="status" className="ml-1 text-red-200">Copy failed; select the text above.</span>}
          </details>
        </>
      )}
    </div>
  );
}
