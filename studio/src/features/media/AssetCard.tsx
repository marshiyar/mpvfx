/**
 * AssetCard and FontRow — visual asset tile / row components for the Assets panel.
 * Extracted from AssetsTab.tsx to keep that file under the 600-line CI gate.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { VideoFrameThumbnail } from "../../ui/VideoFrameThumbnail";
import { VIDEO_EXT, IMAGE_EXT } from "./mediaTypes";
import { TIMELINE_ASSET_MIME } from "../timeline/timelineAssetDrop";
import { ContextMenu } from "./AssetContextMenu";
import { usePlayerStore } from "../../player/store/playerStore";
import { useMediaSourceVersion } from "../../player/hooks/useMediaSourceVersion";
import { revisionedMediaUrl } from "../../player/lib/mediaSourceChanges";
import { timelineClipFocusId } from "../../player/components/timelineNavigationIdentity";
import { useAssetPreviewStore } from "./assetPreviewStore";
import { findClipForAsset, isPointerClick } from "./assetClickBehavior";
import { basename, ext, truncateMiddle, formatDuration, type CopyFeedback } from "./assetHelpers";
import { resolveMediaPreviewUrl } from "../../player/components/thumbnailUtils";

/** Drag payload writer shared by the asset tile and the font row: copy effect
 *  plus the timeline-asset MIME and a plain-text path fallback. */
function writeAssetDragData(e: React.DragEvent, asset: string): void {
  e.dataTransfer.effectAllowed = "copy";
  e.dataTransfer.setData(TIMELINE_ASSET_MIME, JSON.stringify({ path: asset }));
  e.dataTransfer.setData("text/plain", asset);
}

/** Copy-path outcome chip. Copying is a context-menu action, so this is pure
 *  feedback — it renders only once a copy has succeeded or failed, and never
 *  as an idle affordance for something the tile itself does not do. */
function CopyChip({ feedback, asset }: { feedback: CopyFeedback; asset: string }) {
  if (feedback?.path !== asset) return null;
  return (
    <span
      role="status"
      className={`flex-shrink-0 text-[9px] font-medium px-1.5 py-px rounded ${
        feedback.ok ? "text-panel-accent bg-panel-accent/10" : "text-red-400 bg-red-500/10"
      }`}
    >
      {feedback.ok ? "Copied" : "Copy failed"}
    </span>
  );
}

/** Open the row/tile context menu at the pointer, shared by asset tile + font row. */
function openAssetContextMenu(
  e: React.MouseEvent,
  setContextMenu: (menu: { x: number; y: number }) => void,
): void {
  e.preventDefault();
  setContextMenu({ x: e.clientX, y: e.clientY });
}

export interface AssetCardProps {
  projectId: string;
  asset: string;
  used: boolean;
  duration?: number;
  onCopy: (path: string) => void;
  copyFeedback: CopyFeedback;
  onDelete?: (path: string) => void;
  onRename?: (oldPath: string, newPath: string) => void;
  onAddAssetToTimeline?: (path: string) => void;
}

/**
 * Thumbnail card for images and video assets. Renders in a 2-col grid.
 *
 * Click behaviour (CapCut-style):
 *   - Already added  → selects the clip on the timeline (setSelectedElementId).
 *   - Not yet added  → opens the asset preview overlay over the canvas.
 * Drag behaviour is preserved: a pointer movement exceeding DRAG_THRESHOLD_PX
 * before pointerup is treated as drag-start, not a click.
 */
// fallow-ignore-next-line complexity
export function AssetCard({
  projectId,
  asset,
  used,
  duration,
  onCopy,
  copyFeedback,
  onDelete,
  onRename,
  onAddAssetToTimeline,
}: AssetCardProps) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [hovered, setHovered] = useState(false);
  const [imgError, setImgError] = useState(false);
  const isCopied = copyFeedback?.path === asset && copyFeedback.ok;
  const fullName = asset.split("/").pop() ?? asset;
  const name = basename(asset);
  const extension = ext(asset);
  const sourceUrl = resolveMediaPreviewUrl(asset, projectId);
  const sourceRevision = useMediaSourceVersion(projectId, sourceUrl);
  const serveUrl = revisionedMediaUrl(sourceUrl, sourceRevision);
  const isVideo = VIDEO_EXT.test(asset);
  const isImage = IMAGE_EXT.test(asset);
  const [probedDuration, setProbedDuration] = useState<number>();
  useEffect(() => { setProbedDuration(undefined); setImgError(false); }, [serveUrl]);
  const resolvedDuration = probedDuration ?? (sourceRevision === 0 ? duration : undefined);
  const durationLabel = formatDuration(resolvedDuration ?? 0);

  // Drag-threshold click gate: track pointer-down position so we can ignore
  // pointer-up events that followed a real drag gesture.
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null);

  const setSelectedElementId = usePlayerStore((s) => s.setSelectedElementId);
  const requestTimelineFocus = usePlayerStore((s) => s.requestTimelineFocus);
  const elements = usePlayerStore((s) => s.elements);
  const setPreviewAsset = useAssetPreviewStore((s) => s.setPreviewAsset);
  const clearPreviewAsset = useAssetPreviewStore((s) => s.clearPreviewAsset);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    pointerDownRef.current = { x: e.clientX, y: e.clientY };
  }, []);

  // Reveal the clip when the asset is already on the timeline, otherwise open
  // the preview overlay. Shared by pointer-up and keyboard activation so the
  // tile does the same thing however it is operated.
  const activateCard = useCallback(() => {
    if (used) {
      const clip = findClipForAsset(elements, asset);
      if (clip) {
        // Dismiss any open preview overlay (from another asset) — the reveal
        // must not leave a stale preview card floating over the canvas.
        clearPreviewAsset();
        const clipKey = clip.key ?? clip.id;
        setSelectedElementId(clipKey);
        // Scroll the timeline so the selected clip is actually visible.
        requestTimelineFocus(timelineClipFocusId(clipKey));
        return;
      }
    }
    // Not added (or no matching clip found) → preview overlay
    setPreviewAsset(asset, projectId);
  }, [
    used,
    elements,
    asset,
    projectId,
    setSelectedElementId,
    requestTimelineFocus,
    setPreviewAsset,
    clearPreviewAsset,
  ]);

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      const origin = pointerDownRef.current;
      pointerDownRef.current = null;
      if (!origin) return;
      if (!isPointerClick(e.clientX - origin.x, e.clientY - origin.y)) return;
      activateCard();
    },
    [activateCard],
  );

  return (
    <>
      <div
        draggable
        role="button"
        tabIndex={0}
        aria-label={`${name} — open, drag to timeline, right-click for actions`}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            activateCard();
          }
        }}
        onDragStart={(e) => writeAssetDragData(e, asset)}
        onContextMenu={(e) => openAssetContextMenu(e, setContextMenu)}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        className={`flex flex-col gap-1 cursor-pointer rounded-md p-1 transition-colors outline-none focus-visible:bg-neutral-800/60 ${
          isCopied ? "bg-studio-accent/10" : "hover:bg-neutral-800/40"
        }`}
      >
        {/* Thumbnail */}
        <div className="w-full aspect-video rounded overflow-hidden bg-neutral-900 relative">
          {isImage && !imgError && (
            <img
              src={serveUrl}
              alt={name}
              loading="lazy"
              className="w-full h-full object-cover"
              onError={() => setImgError(true)}
            />
          )}
          {isVideo && (
            <>
              <VideoFrameThumbnail src={serveUrl} onDuration={setProbedDuration} />
              {hovered && (
                <video
                  src={serveUrl}
                  autoPlay
                  muted
                  loop
                  playsInline
                  className="absolute inset-0 w-full h-full object-cover"
                />
              )}
            </>
          )}
          {((!isImage && !isVideo) || (isImage && imgError)) && (
            <div className="w-full h-full flex items-center justify-center">
              <span className="text-[10px] font-medium text-neutral-600">{extension}</span>
            </div>
          )}

          {/* "Added" badge — top-left */}
          {used && (
            <span className="absolute top-1 left-1 text-[9px] font-semibold leading-none px-1.5 py-[3px] rounded bg-neutral-950/80 text-panel-text-1">
              Added
            </span>
          )}

          {/* Duration badge — top-right, media only */}
          {durationLabel && (
            <span className="absolute top-1 right-1 text-[9px] font-medium leading-none px-1.5 py-[3px] rounded bg-neutral-950/80 text-panel-text-2 tabular-nums">
              {durationLabel}
            </span>
          )}
        </div>

        {/* Filename caption */}
        <div className="flex items-center justify-center gap-1">
          <span
            className={`text-[10px] leading-tight text-center ${
              used ? "text-panel-text-2" : "text-panel-text-4"
            }`}
            title={fullName}
          >
            {truncateMiddle(fullName, 22)}
          </span>
          <CopyChip feedback={copyFeedback} asset={asset} />
        </div>
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          asset={asset}
          onClose={() => setContextMenu(null)}
          onCopy={onCopy}
          onDelete={onDelete}
          onRename={onRename}
          onAddAtPlayhead={onAddAssetToTimeline}
        />
      )}
    </>
  );
}

export interface FontRowProps {
  asset: string;
  used: boolean;
  onCopy: (path: string) => void;
  copyFeedback: CopyFeedback;
  onDelete?: (path: string) => void;
  onRename?: (oldPath: string, newPath: string) => void;
  onAddAssetToTimeline?: (path: string) => void;
}

/**
 * Compact row for font assets (no meaningful thumbnail; show ext badge + name).
 */
export function FontRow({
  asset,
  used,
  onCopy,
  copyFeedback,
  onDelete,
  onRename,
  onAddAssetToTimeline,
}: FontRowProps) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const name = basename(asset);
  const extension = ext(asset);
  const isCopied = copyFeedback?.path === asset && copyFeedback.ok;

  return (
    <>
      <div
        draggable
        role="button"
        tabIndex={0}
        aria-label={`${name} — copy path, drag to timeline, right-click for actions`}
        onClick={() => onCopy(asset)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onCopy(asset);
          }
        }}
        onDragStart={(e) => writeAssetDragData(e, asset)}
        onContextMenu={(e) => openAssetContextMenu(e, setContextMenu)}
        className={`px-2.5 py-1.5 flex items-center gap-2.5 cursor-pointer transition-colors outline-none focus-visible:bg-neutral-800/60 ${
          isCopied
            ? "bg-studio-accent/10 border-l-2 border-studio-accent"
            : "border-l-2 border-transparent hover:bg-neutral-800/50"
        }`}
      >
        <div className="w-[50px] h-[32px] rounded overflow-hidden bg-neutral-900 flex-shrink-0 flex items-center justify-center">
          <span className="text-[9px] font-medium text-neutral-700">{extension}</span>
        </div>
        <div className="min-w-0 flex-1">
          <span
            className={`text-xs font-medium truncate block ${used ? "text-panel-text-1" : "text-panel-text-3"}`}
          >
            {name}
          </span>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-neutral-600 truncate">{extension}</span>
            <CopyChip feedback={copyFeedback} asset={asset} />
          </div>
        </div>
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          asset={asset}
          onClose={() => setContextMenu(null)}
          onCopy={onCopy}
          onDelete={onDelete}
          onRename={onRename}
          onAddAtPlayhead={onAddAssetToTimeline}
        />
      )}
    </>
  );
}
