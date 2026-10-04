import { resolveNativeDomBinding } from "../../../shared/project/nativeDomBinding";
import { getSourceFileForElement, normalizeTimelineCompositionSource } from "../canvas/domEditingDom";
import { sourceFrameValue } from "../../../shared/project/nativeSourceTime";
/** Optional preview adapter for an already-validated native project sidecar. */
import {
  NATIVE_CLIP_ID_ATTRIBUTE,
} from "./nativeFrameApplication";
import type { NativeClipDomBinding, NativeProjectDocument } from "../../../shared/project/nativeProjectDocument";
import { createNativePlaybackAdapter } from "../../player/lib/nativePlaybackAdapter";
import type { NativePlaybackClipBinding } from "../../player/lib/nativePlaybackAdapter";
import type { RuntimePlaybackAdapter, StaticSeekPlaybackClock } from "../../player/lib/playbackTypes";

export type NativeProjectRuntimeClock = StaticSeekPlaybackClock;

export interface NativeProjectRuntimeWindow extends Window {
  __studioNativePlayer?: RuntimePlaybackAdapter;
  __player?: RuntimePlaybackAdapter;
}

export interface NativeProjectRuntimeOptions {
  window: NativeProjectRuntimeWindow;
  document: Document;
  project: NativeProjectDocument;
  activeSourceFile?: string;
  onBindingError?: (error: Error) => void;
  clock: NativeProjectRuntimeClock;
  getPlaybackRate?: () => number;
}

export interface NativeProjectRuntime {
  readonly clips: readonly NativePlaybackClipBinding[];
  readonly durationFrames: number;
  readonly player: RuntimePlaybackAdapter;
  /** Pauses and removes/restores only the adapter this installation owns. */
  cleanup(): void;
}

type RuntimeClipBinding = NativePlaybackClipBinding & { readonly binding?: NativeClipDomBinding };

interface DomBindingLease {
  readonly clipId: string;
  readonly owners: Set<symbol>;
  readonly addedByRuntime: boolean;
}

// A preview refresh and React StrictMode can briefly overlap two native
// evaluators for the same live document. Binding ownership therefore cannot be
// represented by a runtime-local `HTMLElement[]`: the predecessor's cleanup
// would remove the attribute out from under its replacement.
const domBindingLeases = new WeakMap<HTMLElement, DomBindingLease>();
const disposedNativePlayers = new WeakSet<object>();

export function flattenClips(project: NativeProjectDocument): RuntimeClipBinding[] {
  const assetsById = new Map(project.assets.map((asset) => [asset.id, asset]));
  return project.sequence.tracks.flatMap((track) =>
    track.clips.map((clip) => {
      const asset = assetsById.get(clip.assetId);
      const playbackRate = (clip as typeof clip & {
        playbackRate?: number | { numerator: number; denominator: number };
      }).playbackRate;
      return {
        clipId: clip.id,
        assetId: clip.assetId,
        ...(asset ? { assetKind: asset.kind } : {}),
        startFrame: clip.startFrame,
        durationFrames: clip.durationFrames,
        sourceInFrame: sourceFrameValue(clip),
        muted: clip.muted,
        ...(playbackRate !== undefined ? { playbackRate } : {}),
        staticParameters: clip.staticParameters,
        parameterTracks: clip.parameterTracks,
        ...(clip.binding ? { binding: clip.binding } : {}),
      };
    }),
  );
}

function scopedQuery(document: Document, clip: RuntimeClipBinding, activeSourceFile: string) {
  const normalize = (path: string) => normalizeTimelineCompositionSource(path) ?? path;
  return (selector: string): HTMLElement[] => [...document.querySelectorAll(selector)]
    .filter(candidate => !clip.binding || normalize(getSourceFileForElement(candidate as HTMLElement, activeSourceFile).sourceFile) === normalize(clip.binding.sourceFile)) as HTMLElement[];
}

export function boundNativeClips(document: Document, clips: readonly RuntimeClipBinding[], _activeSourceFile = "index.html"): RuntimeClipBinding[] {
  const counts = new Map<string, number>();
  for (const node of document.querySelectorAll(`[${NATIVE_CLIP_ID_ATTRIBUTE}]`)) {
    const id = node.getAttribute(NATIVE_CLIP_ID_ATTRIBUTE)!;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return clips.filter(clip => counts.get(clip.clipId) === 1);
}

/**
 * The attribute is the native preview contract. Canonical clip ids are never
 * treated as DOM ids; a legacy node is addressed only through its scoped binding.
 */
export function bindLegacyDomIds(document: Document, clips: readonly RuntimeClipBinding[], activeSourceFile = "index.html"): () => void {
  const owner = Symbol("native-project-runtime-dom-binding");
  const acquired: Array<{ element: HTMLElement; lease: DomBindingLease }> = [];
  const explicitById = new Map<string, HTMLElement[]>();
  for (const node of document.querySelectorAll(`[${NATIVE_CLIP_ID_ATTRIBUTE}]`)) {
    const id = node.getAttribute(NATIVE_CLIP_ID_ATTRIBUTE)!;
    explicitById.set(id, [...(explicitById.get(id) ?? []), node as HTMLElement]);
  }
  const resolved = clips.map(clip => {
    const query = scopedQuery(document, clip, activeSourceFile);
    // Canonical IDs are global project identities. Only legacy fallback hints
    // need composition scoping; exported subcompositions already carry the ID.
    const explicitMatches = explicitById.get(clip.clipId) ?? [];
    if (explicitMatches.length > 1) throw new Error(`More than one preview element claims native clip ${clip.clipId}`);
    return { clip, query, explicit: explicitMatches[0] };
  });
  for (const { clip, query, explicit } of resolved) {
    if (explicit) {
      const existingLease = domBindingLeases.get(explicit);
      if (existingLease?.clipId === clip.clipId) {
        existingLease.owners.add(owner);
        acquired.push({ element: explicit, lease: existingLease });
      }
      continue;
    }
    const fallback = clip.binding ? resolveNativeDomBinding(query, clip.binding) : null;
    if (!fallback || fallback.getAttribute(NATIVE_CLIP_ID_ATTRIBUTE) !== null) continue;
    fallback.setAttribute(NATIVE_CLIP_ID_ATTRIBUTE, clip.clipId);
    const lease: DomBindingLease = {
      clipId: clip.clipId,
      owners: new Set([owner]),
      addedByRuntime: true,
    };
    domBindingLeases.set(fallback, lease);
    acquired.push({ element: fallback, lease });
  }
  return () => {
    for (const { element, lease } of acquired) {
      lease.owners.delete(owner);
      if (lease.owners.size > 0) continue;
      if (
        lease.addedByRuntime &&
        element.getAttribute(NATIVE_CLIP_ID_ATTRIBUTE) === lease.clipId
      ) {
        element.removeAttribute(NATIVE_CLIP_ID_ATTRIBUTE);
      }
      if (domBindingLeases.get(element) === lease) domBindingLeases.delete(element);
    }
  };
}

/**
 * Install a native frame evaluator into one preview iframe. It never alters the
 * legacy `__player`; cleanup restores any prior native adapter only if this
 * exact installation is still current.
 */
export function installNativeProjectRuntime(options: NativeProjectRuntimeOptions): NativeProjectRuntime {
  const allClips = flattenClips(options.project);
  let releaseDomBindings = bindLegacyDomIds(options.document, allClips, options.activeSourceFile);
  const clips = boundNativeClips(options.document, allClips, options.activeSourceFile);
  const authoredDuration = Number(options.document.querySelector("[data-composition-id]")?.getAttribute("data-duration"));
  const durationFrames = Math.max(
    1,
    Number.isFinite(authoredDuration) && authoredDuration > 0 ? Math.ceil(authoredDuration * options.project.frameRate.numerator / options.project.frameRate.denominator) : 0,
    ...clips.map((clip) => clip.startFrame + clip.durationFrames),
  );
  const priorNativePlayer = options.window.__studioNativePlayer;
  let player: ReturnType<typeof createNativePlaybackAdapter>;
  try { player = createNativePlaybackAdapter({
    document: options.document,
    frameRate: options.project.frameRate,
    durationFrames,
    clips,
    clock: options.clock,
    getPlaybackRate: options.getPlaybackRate,
    baseAdapter: options.window.__player ?? null,
  }); } catch (error) { releaseDomBindings(); throw error; }
  options.window.__studioNativePlayer = player;

  // Nested compositions can finish loading after the iframe's load event.
  // Rebind structural changes without rebuilding the player's transport clock.
  const observer = new MutationObserver(records => {
    if (!records.some(record => [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1))) return;
    try {
      const nextRelease = bindLegacyDomIds(options.document, allClips, options.activeSourceFile);
      releaseDomBindings();
      releaseDomBindings = nextRelease;
      clips.splice(0, clips.length, ...boundNativeClips(options.document, allClips, options.activeSourceFile));
      player.reapplyFrame?.();
    } catch (error) {
      clips.splice(0, clips.length, ...boundNativeClips(options.document, allClips, options.activeSourceFile));
      options.onBindingError?.(error instanceof Error ? error : new Error(String(error)));
    }
  });
  observer.observe(options.document, { childList: true, subtree: true });

  let cleaned = false;
  return {
    clips,
    durationFrames,
    player,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      observer.disconnect();
      // Replacing a sidecar evaluator must not stop the shared HTML media/audio
      // transport. `dispose` owns only the native requestAnimationFrame clock;
      // the public `player.pause()` remains the user-facing pause operation.
      player.dispose();
      disposedNativePlayers.add(player);
      if (options.window.__studioNativePlayer === player) {
        if (priorNativePlayer && !disposedNativePlayers.has(priorNativePlayer)) {
          options.window.__studioNativePlayer = priorNativePlayer;
        }
        else delete options.window.__studioNativePlayer;
      }
      releaseDomBindings();
    },
  };
}
