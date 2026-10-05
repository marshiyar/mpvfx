import { memo, useCallback, useEffect, useRef, useState } from "react";
import { setPreviewMediaMuted } from "../../player/lib/timelineIframeHelpers";
import { acceptedRuntimeMessageFps, postRuntimeControlMessage } from "../../player/lib/runtimeProtocol";
import { isExpectedPreviewMessage, previewOriginFromIframe, resolvePreviewUrl } from "../../player/lib/previewUrl";
import { buildCompositionThumbnailUrl } from "../../player/components/CompositionThumbnail";
import { TIMELINE_COMPOSITION_MIME } from "../timeline/timelineCompositionDrop";
import { Tooltip } from "../../ui/Tooltip";

interface CompositionsTabProps {
  projectId: string;
  compositions: string[];
  masterComposition?: string | null;
  activeComposition: string | null;
  onSelect: (comp: string) => void;
  onRenderComposition?: (comp: string) => void;
  onAddToTimeline?: (comp: string) => void;
  onDeleteComposition?: (comp: string) => void | Promise<unknown>;
  isRendering?: boolean;
}

const DEFAULT_PREVIEW_STAGE = { width: 1920, height: 1080 };
const CARD_W = 80;
const CARD_H = 45;
const THUMBNAIL_SEEK_TIME_SECONDS = 3;
const THUMBNAIL_PLAYBACK_SYNC_ATTEMPTS = 10;

export function resolveCompositionPreviewScale(input: {
  cardWidth: number;
  cardHeight: number;
  stageWidth: number;
  stageHeight: number;
}): number {
  const safeStageWidth =
    Number.isFinite(input.stageWidth) && input.stageWidth > 0
      ? input.stageWidth
      : DEFAULT_PREVIEW_STAGE.width;
  const safeStageHeight =
    Number.isFinite(input.stageHeight) && input.stageHeight > 0
      ? input.stageHeight
      : DEFAULT_PREVIEW_STAGE.height;
  const scaleX = input.cardWidth / safeStageWidth;
  const scaleY = input.cardHeight / safeStageHeight;
  return Math.min(scaleX, scaleY);
}

export function resolveThumbnailSeekTime(durationSeconds: number | null | undefined): number {
  if (
    Number.isFinite(durationSeconds) &&
    durationSeconds != null &&
    durationSeconds > 0 &&
    durationSeconds < THUMBNAIL_SEEK_TIME_SECONDS
  ) {
    return durationSeconds / 2;
  }

  return THUMBNAIL_SEEK_TIME_SECONDS;
}

export function syncIframePlayback(
  iframe: HTMLIFrameElement | null,
  shouldPlay: boolean,
  durationSeconds?: number | null,
): boolean {
  if (!iframe) return false;
  try {
    const origin = previewOriginFromIframe(iframe);
    const win = iframe.contentWindow;
    if (!origin || !win) return false;
    if (shouldPlay) {
      setPreviewMediaMuted(iframe, true);
      postRuntimeControlMessage(win, "play", {}, 30, origin);
    } else {
      postRuntimeControlMessage(win, "pause", {}, 30, origin);
      postRuntimeControlMessage(win, "seek", {
        timeSeconds: resolveThumbnailSeekTime(durationSeconds),
      }, 30, origin);
    }
    return true;
  } catch {
    return false;
  }
}

function CompCard({
  projectId,
  comp,
  isActive,
  onSelect,
  onRender,
  isRendering,
  onAddToTimeline,
  onDelete,
}: {
  projectId: string;
  comp: string;
  isActive: boolean;
  onSelect: () => void;
  onRender?: () => void;
  isRendering?: boolean;
  onAddToTimeline?: () => void;
  onDelete?: () => void | Promise<unknown>;
}) {
  const [hovered, setHovered] = useState(false);
  const [stageSize, setStageSize] = useState(DEFAULT_PREVIEW_STAGE);
  const [previewDuration, setPreviewDuration] = useState<number | null>(null);
  const [livePreviewLoaded, setLivePreviewLoaded] = useState(false);
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draggedRef = useRef(false);

  const requestIframePlaybackSync = useCallback((shouldPlay: boolean) => {
    if (syncTimer.current) {
      clearTimeout(syncTimer.current);
      syncTimer.current = null;
    }

    const sync = (remainingAttempts: number) => {
      if (syncIframePlayback(iframeRef.current, shouldPlay, previewDuration) || remainingAttempts <= 0) return;

      syncTimer.current = setTimeout(() => sync(remainingAttempts - 1), 100);
    };

    sync(THUMBNAIL_PLAYBACK_SYNC_ATTEMPTS);
  }, [previewDuration]);

  const handleEnter = () => {
    hoverTimer.current = setTimeout(() => setHovered(true), 300);
  };
  const handleLeave = () => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    if (syncTimer.current) {
      clearTimeout(syncTimer.current);
      syncTimer.current = null;
    }
    setHovered(false);
    setLivePreviewLoaded(false);
  };
  const name = comp.replace(/^compositions\//, "").replace(/\.html$/, "");
  const previewUrl = `/api/projects/${encodeURIComponent(projectId)}/preview/comp/${comp}`;
  const isolatedPreviewUrl = resolvePreviewUrl(projectId, previewUrl, window.location.origin);
  const thumbnailUrl = buildCompositionThumbnailUrl({
    previewUrl,
    seekTime: THUMBNAIL_SEEK_TIME_SECONDS,
    duration: 0,
    origin: window.location.origin,
  });
  const previewScale = resolveCompositionPreviewScale({
    cardWidth: CARD_W,
    cardHeight: CARD_H,
    stageWidth: stageSize.width,
    stageHeight: stageSize.height,
  });
  const thumbnailOffsetX = (CARD_W - stageSize.width * previewScale) / 2;
  const thumbnailOffsetY = (CARD_H - stageSize.height * previewScale) / 2;

  useEffect(() => {
    if (hovered) requestIframePlaybackSync(true);
  }, [hovered, requestIframePlaybackSync]);

  useEffect(() => {
    if (!hovered) return;
    const onMessage = (event: MessageEvent) => {
      if (!isExpectedPreviewMessage(event, iframeRef.current)) return;
      const data = event.data;
      if (data?.source !== "hf-preview") return;
      if (data.type === "ready") requestIframePlaybackSync(true);
      if (data.type === "timeline") {
        const width = Number(data.compositionWidth);
        const height = Number(data.compositionHeight);
        if (width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height)) {
          setStageSize({ width, height });
        }
        const fps = acceptedRuntimeMessageFps(data);
        const frames = Number(data.durationInFrames);
        if (Number.isFinite(fps) && fps > 0 && Number.isFinite(frames) && frames > 0) {
          setPreviewDuration(frames / fps);
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [hovered, requestIframePlaybackSync]);

  useEffect(() => {
    return () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      if (syncTimer.current) clearTimeout(syncTimer.current);
    };
  }, []);

  return (
    <div
      role="button"
      tabIndex={0}
      draggable={!isActive}
      aria-label={`Open composition ${name}`}
      aria-pressed={isActive}
      onDragStart={(event) => {
        if (isActive) {
          event.preventDefault();
          return;
        }
        draggedRef.current = true;
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData(TIMELINE_COMPOSITION_MIME, JSON.stringify({ sourcePath: comp }));
      }}
      onDragEnd={() => {
        window.setTimeout(() => {
          draggedRef.current = false;
        }, 0);
      }}
      onClick={() => {
        if (!draggedRef.current) onSelect();
      }}
      onKeyDown={(event) => {
        // Only when the row itself is focused — keydowns bubbling from the
        // inner controls (play button) must keep their native activation.
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      onPointerEnter={handleEnter}
      onPointerLeave={handleLeave}
      className={`group/card w-full select-none text-left px-2 py-1.5 flex items-center gap-2.5 transition-colors outline-none focus-visible:bg-neutral-800/60 ${
        isActive
          ? "cursor-default bg-studio-accent/10 border-l-2 border-studio-accent"
          : "cursor-grab active:cursor-grabbing border-l-2 border-transparent hover:bg-neutral-800/50"
      }`}
    >
      <div className="w-20 h-[45px] rounded overflow-hidden bg-neutral-900 flex-shrink-0 relative">
        {thumbnailFailed ? (
          <div className="absolute inset-0 flex items-center justify-center px-1 text-center text-[8px] leading-tight text-neutral-600">
            Preview unavailable
          </div>
        ) : (
          <img
            src={thumbnailUrl}
            alt=""
            draggable={false}
            loading="lazy"
            decoding="async"
            onError={() => setThumbnailFailed(true)}
            className={`absolute inset-0 h-full w-full object-contain transition-opacity ${
              livePreviewLoaded ? "opacity-0" : "opacity-100"
            }`}
          />
        )}
        {hovered && (
          <iframe
            ref={iframeRef}
            src={isolatedPreviewUrl}
            allow="autoplay"
            sandbox="allow-scripts allow-same-origin"
            className="absolute border-none pointer-events-none"
            style={{
              transformOrigin: "0 0",
              width: stageSize.width,
              height: stageSize.height,
              left: thumbnailOffsetX,
              top: thumbnailOffsetY,
              transform: `scale(${previewScale})`,
            }}
            onLoad={(e) => {
              setLivePreviewLoaded(true);
              requestIframePlaybackSync(true);
            }}
            title={`${name} preview`}
            tabIndex={-1}
          />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <span className="text-[11px] font-medium text-neutral-300 truncate">{name}</span>
        </div>
        <span className="text-[9px] text-neutral-600 truncate block">{comp}</span>
      </div>
      {onAddToTimeline && !isActive && (
        <button
          type="button"
          title={`Add ${name} to timeline at playhead`}
          aria-label={`Add ${name} to timeline at playhead`}
          onClick={(event) => {
            event.stopPropagation();
            onAddToTimeline();
          }}
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded text-neutral-600 opacity-0 transition-[color,background-color,opacity] hover:bg-neutral-800 hover:text-studio-accent group-hover/card:opacity-100 group-focus-within/card:opacity-100 focus:opacity-100"
        >
          <span aria-hidden="true">+</span>
        </button>
      )}
      {onRender && (
        <Tooltip label={isRendering ? "An export is already in progress" : `Export scene ${name}`}>
          <button
            type="button"
            aria-label={isRendering ? "An export is already in progress" : `Export scene ${name}`}
            disabled={isRendering}
            onClick={(e) => {
              e.stopPropagation();
              onRender();
            }}
            // h-6 w-6 = the 24x24 WCAG 2.2 (2.5.8) minimum target; the 14px glyph
            // is unchanged, only the box grows. The sibling "+" button is h-8 w-8,
            // so the card row already has the room.
            className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded transition-colors ${
              isRendering
                ? "text-neutral-600 cursor-not-allowed"
                : "text-neutral-600 hover:text-studio-accent hover:bg-neutral-800"
            }`}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
        </Tooltip>
      )}
      {onDelete && (
        <Tooltip label={`Delete scene ${name}`}>
          <button
            type="button"
            aria-label={`Delete scene ${name}`}
            onClick={(event) => {
              event.stopPropagation();
              if (
                window.confirm(
                  `Delete the reusable scene ‘${name}’? It will be moved to the recovery archive.`,
                )
              ) {
                void onDelete();
              }
            }}
            className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-neutral-600 transition-colors hover:bg-red-950/40 hover:text-red-400"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 6h18" />
              <path d="M8 6V4h8v2" />
              <path d="m19 6-1 14H6L5 6" />
              <path d="M10 11v5M14 11v5" />
            </svg>
          </button>
        </Tooltip>
      )}
    </div>
  );
}

export const CompositionsTab = memo(function CompositionsTab({
  projectId,
  compositions,
  masterComposition,
  activeComposition,
  onSelect,
  onRenderComposition,
  onAddToTimeline,
  onDeleteComposition,
  isRendering,
}: CompositionsTabProps) {
  const reusableCompositions = compositions.filter((comp) => comp !== masterComposition);
  if (reusableCompositions.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-4">
        <p className="text-xs text-neutral-600 text-center">
          No reusable scenes. The main timeline is protected and stays in the editor.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {reusableCompositions.map((comp) => (
        <CompCard
          key={`${projectId}:${comp}`}
          projectId={projectId}
          comp={comp}
          isActive={activeComposition === comp}
          onSelect={() => onSelect(comp)}
          onRender={onRenderComposition ? () => onRenderComposition(comp) : undefined}
          onAddToTimeline={onAddToTimeline ? () => onAddToTimeline(comp) : undefined}
          onDelete={onDeleteComposition ? () => onDeleteComposition(comp) : undefined}
          isRendering={isRendering}
        />
      ))}
    </div>
  );
});
