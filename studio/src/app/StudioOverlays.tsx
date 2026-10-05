import { StudioToast } from "./StudioToast";
import { StudioFeedbackCard } from "../features/feedback/StudioFeedbackCard";
import type { useToast } from "./useToast";

export interface StudioOverlaysProps {
  toasts: ReturnType<typeof useToast>["toasts"];
  dismissToast: (id: number) => void;
}

/**
 * Floating overlays for the studio shell: feedback and toasts. Extracted from
 * `App.tsx` to keep the shell within the studio's 600-line decomposition budget.
 */
// fallow-ignore-next-line complexity
export function StudioOverlays({
  toasts,
  dismissToast,
}: StudioOverlaysProps) {
  return (
    <>
      {/* One bottom-right stack so the feedback card and toasts queue instead
          of covering each other. Empty when nothing is showing. */}
      <div className="pointer-events-none absolute bottom-4 right-4 z-[91] flex max-h-[60vh] flex-col items-end gap-1.5 overflow-y-auto">
        {toasts.map((toast) => (
          <StudioToast
            key={toast.id}
            message={toast.message}
            tone={toast.tone}
            occurrences={toast.occurrences}
            details={toast.details}
            leaving={toast.leaving}
            onDismiss={() => dismissToast(toast.id)}
          />
        ))}
        <div className="pointer-events-auto"><StudioFeedbackCard /></div>
      </div>
    </>
  );
}
