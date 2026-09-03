import { StudioToast } from "./StudioToast";
import { StudioFeedbackCard } from "./feedback/StudioFeedbackCard";
import type { useToast } from "../hooks/useToast";

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
      <div className="absolute bottom-6 right-6 z-[91] flex flex-col items-end gap-2">
        {toasts.map((toast) => (
          <StudioToast
            key={toast.id}
            message={toast.message}
            tone={toast.tone}
            leaving={toast.leaving}
            onDismiss={() => dismissToast(toast.id)}
          />
        ))}
        <StudioFeedbackCard />
      </div>
    </>
  );
}
