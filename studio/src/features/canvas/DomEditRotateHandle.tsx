import type { PointerEvent as ReactPointerEvent } from "react";
import type { OverlayRect } from "./domEditOverlayGeometry";

/** Rotate handle below the selection: an attached circular-arrows icon chip
 *  (no connecting stem). Presentation only —
 *  the rotation gesture measures pointer angles from the element CENTER
 *  (resolveDomEditRotationGesture), so the handle position doesn't affect the
 *  math. Sits 12px below the bbox, past the bottom crop handle's hit strip. */
export function DomEditRotateHandle({
  overlayRect,
  onStartRotate,
}: {
  overlayRect: OverlayRect;
  onStartRotate: (e: ReactPointerEvent<HTMLButtonElement>) => void;
}) {
  const visibleLeft = overlayRect.left;
  const visibleWidth = overlayRect.width;
  const visibleBottom = overlayRect.top + overlayRect.height;
  return (
    <button
      type="button"
      className="pointer-events-auto absolute flex items-center justify-center border-0 bg-transparent p-0"
      style={{
        left: visibleLeft + visibleWidth / 2,
        top: visibleBottom + 12,
        width: 22,
        height: 22,
        transform: "translateX(-50%)",
        touchAction: "none",
        // Closed-hand grab cursor: this handle is grabbed and dragged to rotate.
        cursor: "grabbing",
      }}
      title="Rotate"
      aria-label="Rotate selection"
      onPointerDown={onStartRotate}
    >
      <span className="pointer-events-none flex h-[18px] w-[18px] items-center justify-center rounded-full border border-studio-accent/70 bg-studio-surface text-studio-accent">
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
          <path d="M21 3v5h-5" />
          <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
          <path d="M8 16H3v5" />
        </svg>
      </span>
    </button>
  );
}
