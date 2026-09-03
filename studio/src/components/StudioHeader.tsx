import type { MouseEvent } from "react";
import { Camera } from "../icons/SystemIcons";
import { useStudioShellContext } from "../contexts/StudioContext";
import { trackStudioEvent } from "../utils/studioTelemetry";
import { Tooltip } from "./ui";

export interface StudioHeaderProps {
  captureFrameHref: string;
  captureFrameFilename: string;
  handleCaptureFrameClick: (event: MouseEvent<HTMLAnchorElement>) => void;
  refreshCaptureFrameTime: () => void;
  capturing?: boolean;
}

const STUDIO_BRAND = "MpVFX";

function VideoEditorBrand() {
  return (
    <span className="select-none text-xs font-semibold tracking-wide text-neutral-100">
      {STUDIO_BRAND}
    </span>
  );
}
// fallow-ignore-next-line complexity
export function StudioHeader({
  captureFrameHref,
  captureFrameFilename,
  handleCaptureFrameClick,
  refreshCaptureFrameTime,
  capturing,
}: StudioHeaderProps) {
  const { projectId } = useStudioShellContext();
  const projectLabel = projectId.trim();
  const showProjectLabel =
    projectLabel.length > 0 && projectLabel.toLocaleLowerCase() !== STUDIO_BRAND.toLocaleLowerCase();

  return (
    <div className="flex items-center justify-between h-10 px-3 bg-neutral-900 border-b border-neutral-800 flex-shrink-0">
      {/* Left: logo + project name */}
      <div className="flex items-center gap-3">
        <VideoEditorBrand />
        {showProjectLabel && (
          <>
            <span className="text-neutral-700 select-none" aria-hidden="true">
              |
            </span>
            <span className="text-[11px] font-medium text-neutral-300">{projectLabel}</span>
          </>
        )}
      </div>
      {/* Right: toolbar buttons */}
      <div className="flex items-center gap-1.5">
        <Tooltip label={capturing ? "Capturing frame…" : "Capture current frame"} side="bottom">
          <a
            href={captureFrameHref}
            download={captureFrameFilename}
            onClick={(e) => {
              if (capturing) {
                e.preventDefault();
                return;
              }
              trackStudioEvent("toolbar_action", { action: "capture_frame" });
              handleCaptureFrameClick(e);
            }}
            onFocus={refreshCaptureFrameTime}
            onPointerDown={refreshCaptureFrameTime}
            aria-disabled={capturing || undefined}
            className={`h-7 flex items-center gap-1.5 px-2.5 rounded-md text-[11px] font-medium transition-colors ${
              capturing
                ? "text-neutral-600 cursor-default"
                : "text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 active:scale-[0.98]"
            }`}
            aria-label={capturing ? "Capturing frame" : "Capture current frame"}
          >
            {capturing ? (
              <svg
                className="animate-spin motion-reduce:animate-none h-3.5 w-3.5"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
            ) : (
              <Camera size={14} />
            )}
            <span>{capturing ? "Capturing…" : "Capture"}</span>
          </a>
        </Tooltip>
      </div>
    </div>
  );
}
