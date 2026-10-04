import type { RationalFrameRate } from "../../../shared/project/nativeKeyframeTypes";
import { encodeMediaPath } from "../../../shared/media/mediaUrl";
import { classifyMediaImportPath } from "../../../shared/media/mediaImportPolicy";
import { roundToCenti } from "../../lib/rounding";
import { generateId } from "../../lib/generateId";
import { patchRootCompositionDuration, readRootCompositionDuration } from "./rootDuration";
import { escapeHtmlAttribute, viewportDimensions } from "./timelineAssetSource";
export {
  assertTimelineAssetTargetSource,
  ensureTimelineAssetTargetSource,
  insertTimelineAssetIntoSource,
  neutralizeCompositionRoot3dTransforms,
} from "./timelineAssetSource";

export const TIMELINE_ASSET_MIME = "application/x-hyperframes-asset";
export const TIMELINE_BLOCK_MIME = "application/x-hyperframes-block";
const FALLBACK_TIMELINE_FILE_DROP_DURATION = 5;

export type TimelineAssetKind = "image" | "video" | "audio";

export function getTimelineAssetKind(assetPath: string): TimelineAssetKind | null {
  const kind = classifyMediaImportPath(assetPath);
  return kind === "image" || kind === "video" || kind === "audio" ? kind : null;
}

export function buildTimelineAssetId(assetPath: string, existingIds: Iterable<string>): string {
  const baseName = assetPath.split("/").pop() ?? "asset";
  const normalized = baseName
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  const baseId = normalized || "asset";
  const ids = new Set(existingIds);
  // A removed clip can still have GSAP/CSS selectors in the compatibility
  // source. Reusing its former DOM ID would attach those edits to a fresh clip.
  // Clip duplication and Undo restore their own saved markup instead of calling
  // this new-insertion path, so they retain the original identity and edits.
  let id: string;
  do {
    id = `${baseId}-${generateId()}`;
  } while (ids.has(id));
  return id;
}

export function resolveTimelineAssetSrc(targetPath: string, assetPath: string): string {
  const targetDir = targetPath.includes("/")
    ? targetPath.slice(0, targetPath.lastIndexOf("/"))
    : "";
  if (!targetDir) return encodeMediaPath(assetPath);

  const fromParts = targetDir.split("/").filter(Boolean);
  const toParts = assetPath.split("/").filter(Boolean);
  while (fromParts.length > 0 && toParts.length > 0 && fromParts[0] === toParts[0]) {
    fromParts.shift();
    toParts.shift();
  }

  const up = fromParts.map(() => "..");
  const relative = [...up, ...toParts].join("/");
  return encodeMediaPath(relative || assetPath.split("/").pop() || assetPath);
}

/**
 * Sequence one or more dropped files end-to-end starting at the drop point. The
 * requested track is preserved here; the asset-drop operation resolves that
 * requested track against existing same-zone clips after each asset's duration
 * is known, so this helper only owns the time sequence and frame quantization.
 */
export function buildTimelineFileDropPlacements(
  placement: { start: number; track: number },
  durations: number[],
  frameRate?: RationalFrameRate,
): Array<{ start: number; track: number }> {
  const validFrameRate = Boolean(
    frameRate &&
    Number.isSafeInteger(frameRate.numerator) &&
    frameRate.numerator > 0 &&
    Number.isSafeInteger(frameRate.denominator) &&
    frameRate.denominator > 0,
  );
  if (!validFrameRate || !frameRate) {
    let nextStart = roundToCenti(Math.max(0, placement.start));
    return durations.map((rawDuration) => {
      const duration =
        Number.isFinite(rawDuration) && rawDuration > 0
          ? rawDuration
          : FALLBACK_TIMELINE_FILE_DROP_DURATION;
      const start = nextStart;
      nextStart = roundToCenti(nextStart + duration);
      return { start, track: placement.track };
    });
  }

  const frameAt = (seconds: number): number => Math.floor(
    (seconds * frameRate.numerator) / frameRate.denominator + 1e-9,
  );
  const secondsAt = (frame: number): number =>
    (frame * frameRate.denominator) / frameRate.numerator;
  let nextFrame = frameAt(Math.max(0, placement.start));
  return durations.map((rawDuration) => {
    const duration =
      Number.isFinite(rawDuration) && rawDuration > 0
        ? rawDuration
        : FALLBACK_TIMELINE_FILE_DROP_DURATION;
    const startFrame = nextFrame;
    nextFrame += Math.max(1, frameAt(duration));
    return { start: secondsAt(startFrame), track: placement.track };
  });
}

export function quantizeTimelineAssetDuration(
  duration: number,
  frameRate?: RationalFrameRate,
): number {
  if (
    !frameRate ||
    !Number.isSafeInteger(frameRate.numerator) ||
    frameRate.numerator <= 0 ||
    !Number.isSafeInteger(frameRate.denominator) ||
    frameRate.denominator <= 0
  ) {
    return roundToCenti(duration);
  }
  const durationFrames = Math.max(
    1,
    Math.floor((duration * frameRate.numerator) / frameRate.denominator + 1e-9),
  );
  return (durationFrames * frameRate.denominator) / frameRate.numerator;
}

export function resolveTimelineAssetCompositionSize(source: string): {
  width: number;
  height: number;
} {
  const width = Number.parseFloat(source.match(/\bdata-width=(["'])([^"']+)\1/i)?.[2] ?? "");
  const height = Number.parseFloat(source.match(/\bdata-height=(["'])([^"']+)\1/i)?.[2] ?? "");
  const viewport = viewportDimensions(source);
  return {
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : (viewport?.width ?? 640),
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : (viewport?.height ?? 360),
  };
}

/**
 * CapCut-style placement: natural size when it fits, scaled-to-fit when
 * oversized, always centered. Unknown natural size → full-frame.
 */
export function fitTimelineAssetGeometry(
  natural: { width: number; height: number } | null,
  comp: { width: number; height: number },
): { left: number; top: number; width: number; height: number } {
  if (!natural || natural.width <= 0 || natural.height <= 0) {
    return { left: 0, top: 0, width: comp.width, height: comp.height };
  }
  const scale = Math.min(1, comp.width / natural.width, comp.height / natural.height);
  const width = Math.round(natural.width * scale);
  const height = Math.round(natural.height * scale);
  return {
    left: Math.round((comp.width - width) / 2),
    top: Math.round((comp.height - height) / 2),
    width,
    height,
  };
}

export function buildTimelineAssetInsertHtml(input: {
  id: string;
  hfId: string;
  assetPath: string;
  kind: TimelineAssetKind;
  hasAudio?: boolean;
  start: number;
  duration: number;
  track: number;
  zIndex: number;
  geometry?: { left: number; top: number; width: number; height: number };
}): string {
  const escapedAssetPath = escapeHtmlAttribute(input.assetPath);
  const sharedAttrs = `id="${input.id}" data-hf-id="${input.hfId}" class="clip" src="${escapedAssetPath}" data-start="${input.start}" data-duration="${input.duration}" data-track-index="${input.track}"`;
  const geometry = input.geometry ?? { left: 0, top: 0, width: 640, height: 360 };
  const visualStyles = `position: absolute; left: ${geometry.left}px; top: ${geometry.top}px; width: ${geometry.width}px; height: ${geometry.height}px; object-fit: contain; z-index: ${input.zIndex}`;

  if (input.kind === "image") {
    return `<img ${sharedAttrs} style="${visualStyles}" />`;
  }

  if (input.kind === "video") {
    const audioAttribute = input.hasAudio === undefined ? "" : ` data-has-audio="${input.hasAudio}"`;
    return `<video ${sharedAttrs}${audioAttribute} playsinline style="${visualStyles}"></video>`;
  }

  return `<audio ${sharedAttrs} data-volume="1" style="z-index: ${input.zIndex}"></audio>`;
}

/**
 * A clip inserted past the composition end would exist in the HTML but never
 * appear on the timeline or in playback. Extend the root's data-duration to
 * cover it (mirrors blockInstaller's behavior for installed blocks).
 */
export function extendCompositionDurationIfNeeded(source: string, requiredEnd: number): string {
  const rootDur = readRootCompositionDuration(source);
  if (rootDur == null || !Number.isFinite(rootDur) || requiredEnd <= rootDur) return source;
  // Keep enough precision for exact fractional project frames. Rounding this
  // to centiseconds can make the root shorter than its final media frame.
  const exactEnd = Math.ceil(requiredEnd * 1e12) / 1e12;
  return patchRootCompositionDuration(source, String(exactEnd));
}

/**
 * Set the composition root's `data-duration` to `contentEnd` (grow OR shrink) so the
 * timeline length tracks content — the content-driven counterpart to
 * extendCompositionDurationIfNeeded's grow-only ratchet. Used after edits that can
 * reduce the furthest clip end (delete/trim). No-op when `contentEnd` is not > 0, so
 * an empty timeline keeps its declared duration instead of collapsing to 0.
 */
export function setCompositionDurationToContent(source: string, contentEnd: number): string {
  if (!Number.isFinite(contentEnd) || contentEnd <= 0) return source;
  const rootDur = readRootCompositionDuration(source);
  if (rootDur == null) return source;
  const next = roundToCenti(contentEnd);
  if (rootDur === next) return source;
  return patchRootCompositionDuration(source, String(next));
}
