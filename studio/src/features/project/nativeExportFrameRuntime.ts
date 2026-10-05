/**
 * Native frame driver for export capture pages. It is bundled into a
 * standalone script (npm run build:frame-runtime) and runs the same binding,
 * frame application and media transport code as the Studio preview.
 *
 * Capture pages cannot load the C++ engine, so the main process evaluates
 * every track with the engine beforehand and passes the samples in `baked`
 * (one list per clip in `flattenClips` order, one entry per parameter track).
 */
import { applyNativeFrameToDocument } from "./nativeFrameApplication";
import { bindLegacyDomIds, boundNativeClips, flattenClips } from "./nativeProjectRuntime";
import { applyNativeMediaTransport } from "../../player/lib/nativePlaybackAdapter";
import type { NativeProjectDocument } from "../../../shared/project/nativeProjectDocument";
import {
  createBakedEngine,
  installVkfEngine,
  vkfEngine,
  vkfEngineInstalled,
  type VkfBakedTrack,
  type VkfTrack,
} from "../../../shared/engine/vkfEngine";

export interface NativeExportFrameInput {
  readonly project: NativeProjectDocument;
  readonly engineVersion: string;
  readonly baked: readonly (readonly VkfBakedTrack[])[];
  readonly bakedReferences: readonly (readonly (readonly VkfBakedTrack[])[])[];
}

export interface NativeExportFrameWindow extends Window {
  __studioNativeProject?: NativeProjectDocument;
  __studioNativeProjectApply?: (seconds: number) => number;
  __studioNativeProjectSeekListener?: (event: Event) => void;
}

/** Install the capture driver; returns the per-seek apply function. */
export function installNativeExportFrameRuntime(
  win: NativeExportFrameWindow,
  doc: Document,
  input: NativeExportFrameInput,
): (seconds: number) => number {
  const clips = flattenClips(input.project);
  if (input.baked.length !== clips.length) {
    throw new Error("Engine samples do not match the project's clips");
  }
  if (input.bakedReferences.length !== clips.length) {
    throw new Error("Engine reference samples do not match the project's clips");
  }
  const samples = new WeakMap<VkfTrack, VkfBakedTrack>();
  clips.forEach((clip, clipIndex) => {
    const bakedTracks = input.baked[clipIndex]!;
    if (bakedTracks.length !== clip.parameterTracks.length) {
      throw new Error(`Engine samples do not match the tracks of clip ${clip.clipId}`);
    }
    clip.parameterTracks.forEach((track, trackIndex) => samples.set(track, bakedTracks[trackIndex]!));
    const referenceSamples = input.bakedReferences[clipIndex]!;
    const segments = clip.cropPivotSegments ?? [];
    if (referenceSamples.length !== segments.length) {
      throw new Error(`Engine reference samples do not match the segments of clip ${clip.clipId}`);
    }
    segments.forEach((segment, segmentIndex) => {
      const tracks = segment.reference?.parameterTracks ?? [];
      const bakedReference = referenceSamples[segmentIndex]!;
      if (bakedReference.length !== tracks.length) {
        throw new Error(`Engine reference samples do not match the tracks of clip ${clip.clipId}`);
      }
      tracks.forEach((track, trackIndex) => samples.set(track, bakedReference[trackIndex]!));
    });
  });
  // Samples answer this project's tracks; anything else keeps whatever engine
  // this realm already had (none on a real capture page).
  installVkfEngine(createBakedEngine(
    input.engineVersion,
    (track) => samples.get(track),
    vkfEngineInstalled() ? vkfEngine() : null,
  ));

  const rate = input.project.frameRate;
  const sourceFile = doc.documentElement.getAttribute("data-studio-source-file") ?? "index.html";
  bindLegacyDomIds(doc, clips, sourceFile);
  const renderedClips = boundNativeClips(doc, clips, sourceFile);
  const active = new Set<string>();
  const apply = (seconds: number): number => {
    const time = Math.max(0, Number(seconds) || 0);
    // Floor selects the frame whose interval contains the time; the epsilon
    // repairs binary floating-point error at exact rational frame boundaries.
    const projectFrame = Math.floor((time * rate.numerator) / rate.denominator + 1e-9);
    const result = applyNativeFrameToDocument(doc, renderedClips, projectFrame);
    applyNativeMediaTransport(doc, renderedClips, rate, projectFrame, true, active);
    return result.appliedClipIds.length;
  };

  win.__studioNativeProject = input.project;
  win.__studioNativeProjectApply = apply;
  if (win.__studioNativeProjectSeekListener) {
    win.removeEventListener("hf-seek", win.__studioNativeProjectSeekListener);
  }
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<{ time?: number } | undefined>).detail;
    apply(detail?.time ?? 0);
  };
  win.__studioNativeProjectSeekListener = listener;
  win.addEventListener("hf-seek", listener);
  return apply;
}
