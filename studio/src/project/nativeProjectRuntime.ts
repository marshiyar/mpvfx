/** Optional preview adapter for an already-validated native project sidecar. */
import {
  NATIVE_CLIP_ID_ATTRIBUTE,
} from "./nativeFrameApplication";
import type { NativeClipDomBinding, NativeProjectDocument } from "./nativeProjectDocument";
import { createNativePlaybackAdapter } from "../player/lib/nativePlaybackAdapter";
import type { NativePlaybackClipBinding } from "../player/lib/nativePlaybackAdapter";
import type { RuntimePlaybackAdapter, StaticSeekPlaybackClock } from "../player/lib/playbackTypes";

export type NativeProjectRuntimeClock = StaticSeekPlaybackClock;

export interface NativeProjectRuntimeWindow extends Window {
  __studioNativePlayer?: RuntimePlaybackAdapter;
  __player?: RuntimePlaybackAdapter;
}

export interface NativeProjectRuntimeOptions {
  window: NativeProjectRuntimeWindow;
  document: Document;
  project: NativeProjectDocument;
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

function flattenClips(project: NativeProjectDocument): RuntimeClipBinding[] {
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
        sourceInFrame: clip.sourceInFrame,
        muted: clip.muted,
        ...(playbackRate !== undefined ? { playbackRate } : {}),
        staticParameters: clip.staticParameters,
        parameterTracks: clip.parameterTracks,
        ...(clip.binding ? { binding: clip.binding } : {}),
      };
    }),
  );
}

function findExplicitClipElement(document: Document, clipId: string): HTMLElement | null {
  for (const candidate of document.querySelectorAll(`[${NATIVE_CLIP_ID_ATTRIBUTE}]`)) {
    // `instanceof HTMLElement` fails across iframe realms; querySelectorAll
    // already gives us an element from this document.
    if (candidate.getAttribute(NATIVE_CLIP_ID_ATTRIBUTE) === clipId) return candidate as HTMLElement;
  }
  return null;
}

function uniqueAttributeElement(document: Document, attribute: string, value: string): HTMLElement | null {
  const candidates = [...document.querySelectorAll(`[${attribute}]`)].filter(
    (candidate) => candidate.getAttribute(attribute) === value,
  ) as HTMLElement[];
  return candidates.length === 1 ? candidates[0]! : null;
}

function selectorElement(
  document: Document,
  selector: string,
  selectorIndex: number | undefined,
): HTMLElement | null {
  let candidates: HTMLElement[];
  try {
    candidates = [...document.querySelectorAll(selector)] as HTMLElement[];
  } catch {
    return null;
  }
  if (typeof selectorIndex === "number") return candidates[selectorIndex] ?? null;
  return candidates.length === 1 ? candidates[0]! : null;
}

/** All supplied hints must resolve to one exact element; ambiguity is never guessed. */
function resolveScopedBinding(document: Document, binding: NativeClipDomBinding | undefined): HTMLElement | null {
  if (!binding) return null;
  const candidates: HTMLElement[] = [];
  if (binding.domId) {
    const element = document.getElementById(binding.domId);
    if (!element) return null;
    candidates.push(element);
  }
  if (binding.hfId) {
    const element = uniqueAttributeElement(document, "data-hf-id", binding.hfId);
    if (!element) return null;
    candidates.push(element);
  }
  if (binding.selector) {
    const element = selectorElement(document, binding.selector, binding.selectorIndex);
    if (!element) return null;
    candidates.push(element);
  }
  if (candidates.length === 0 || !candidates.every((element) => element === candidates[0])) {
    return null;
  }
  return candidates[0]!;
}

/**
 * The attribute is the native preview contract. Canonical clip ids are never
 * treated as DOM ids; a legacy node is addressed only through its scoped binding.
 */
function bindLegacyDomIds(document: Document, clips: readonly RuntimeClipBinding[]): () => void {
  const owner = Symbol("native-project-runtime-dom-binding");
  const acquired: Array<{ element: HTMLElement; lease: DomBindingLease }> = [];
  for (const clip of clips) {
    const explicit = findExplicitClipElement(document, clip.clipId);
    if (explicit) {
      const existingLease = domBindingLeases.get(explicit);
      if (existingLease?.clipId === clip.clipId) {
        existingLease.owners.add(owner);
        acquired.push({ element: explicit, lease: existingLease });
      }
      continue;
    }
    const fallback = resolveScopedBinding(document, clip.binding);
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
  const clips = flattenClips(options.project);
  const durationFrames = Math.max(
    1,
    ...clips.map((clip) => clip.startFrame + clip.durationFrames),
  );
  const releaseDomBindings = bindLegacyDomIds(options.document, clips);
  const priorNativePlayer = options.window.__studioNativePlayer;
  const player = createNativePlaybackAdapter({
    document: options.document,
    frameRate: options.project.frameRate,
    durationFrames,
    clips,
    clock: options.clock,
    getPlaybackRate: options.getPlaybackRate,
    baseAdapter: options.window.__player ?? null,
  });
  options.window.__studioNativePlayer = player;

  let cleaned = false;
  return {
    clips,
    durationFrames,
    player,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
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
