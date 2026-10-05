import { parseHTML } from "linkedom";
import { parseAudioFxChain } from "@hyperframes/core/audio-fx";
import { parseAutomation } from "@hyperframes/core/audio-automation";
import type { PreviewElementState } from "../../../shared/preview/agentProtocol";
import { resolveNativeClipSelection } from "../../../shared/project/nativePropertyEditPlan";
import { resolveNativeDomBinding } from "../../../shared/project/nativeDomBinding";
import { planNativeTimelineRangeEdit } from "../../../shared/project/nativeTimelineRangeEditPlan";
import { availableTimelineFrames, rationalFromNumber, sourceFrameValue, sourcePositionFromSeconds } from "../../../shared/project/nativeSourceTime";
import {
  NATIVE_PROJECT_DOCUMENT_PATH, parseNativeProjectDocument, serializeNativeProjectDocument,
  type NativeProjectAsset, type NativeProjectClip, type NativeProjectDocument,
} from "../../../shared/project/nativeProjectDocument";
import { serializeStudioFileMutations } from "../history/studioFileMutationCoordinator";
import type { RecordEditInput } from "../history/studioFileHistory";
import { commitNativeTimelineFileSnapshots, type CommitNativeTimelineFileTransaction } from "./nativeTimelineTransactionCommit";
import { stabilizeNativeBindingSource, synchronizeNativeBindingSource } from "./nativeBindingSource";
import { NativeProjectRevisionConflictError } from "./nativeProjectPersistence";

export type RemoteNativeMediaCommand =
  | { kind: "muted"; value: boolean }
  | { kind: "gain"; value: number }
  | { kind: "playback-rate"; value: number }
  | { kind: "source-start"; value: number }
  | { kind: "trim"; startSeconds: number; durationSeconds: number }
  | { kind: "audio-fx-chain"; value: string | null }
  | { kind: "audio-automation"; value: string | null };

export interface RemoteNativeMediaSnapshot {
  clipId: string;
  assetKind: "video" | "audio";
  muted: boolean;
  gain: number;
  playbackRate: number;
  sourceStartSeconds: number;
  startSeconds: number;
  durationSeconds: number;
  audioFxChain: string | null;
  audioAutomation: string | null;
}

export interface RemoteNativeMediaDeps {
  expectedRevision: number;
  readOptionalProjectFile(path: string): Promise<string | null | undefined>;
  writeProjectFile(path: string, content: string, expectedContent?: string): Promise<void>;
  recordEdit(input: RecordEditInput): Promise<void>;
  commitFileTransaction?: CommitNativeTimelineFileTransaction;
  onNativeDocumentCommitted?(document: NativeProjectDocument): void;
}

type Located = { clip: NativeProjectClip; asset: NativeProjectAsset; trackId: string };

function locate(document: NativeProjectDocument, state: PreviewElementState): Located | null {
  const clipId = state.dataAttributes["studio-clip-id"];
  if (!clipId || clipId.length > 256 || !state.sourceFile) return null;
  const resolved = resolveNativeClipSelection(document, {
    attributes: { "data-studio-clip-id": clipId }, sourceFile: state.sourceFile,
    id: state.id || null, hfId: state.dataAttributes["hf-id"] ?? null,
    selector: state.selector ?? null, selectorIndex: state.selectorIndex ?? null,
  });
  if (!resolved.ok) return null;
  const { clip, trackId } = resolved.located;
  const binding = clip.binding;
  const asset = document.assets.find(item => item.id === clip.assetId);
  if (!binding || !asset || (asset.kind !== "video" && asset.kind !== "audio") ||
    binding.sourceFile !== state.sourceFile ||
    (binding.domId && binding.domId !== state.id) ||
    (binding.hfId && binding.hfId !== state.dataAttributes["hf-id"]) ||
    (!binding.domId && !binding.hfId && binding.selector && binding.selector !== state.selector) ||
    (!binding.domId && !binding.hfId && binding.selectorIndex !== undefined && binding.selectorIndex !== state.selectorIndex)) return null;
  return { clip, asset, trackId };
}

export function snapshotRemoteNativeMedia(
  state: PreviewElementState,
  document: NativeProjectDocument,
): RemoteNativeMediaSnapshot | null {
  const located = locate(document, state);
  if (!located) return null;
  const { clip, asset } = located;
  const secondsPerFrame = document.frameRate.denominator / document.frameRate.numerator;
  const rate = clip.playbackRate ?? { numerator: 1, denominator: 1 };
  const rawGain = clip.staticParameters?.["audio.volume"];
  return {
    clipId: clip.id, assetKind: asset.kind as "video" | "audio", muted: clip.muted,
    gain: typeof rawGain === "number" ? rawGain : 1,
    playbackRate: rate.numerator / rate.denominator,
    sourceStartSeconds: sourceFrameValue(clip) * secondsPerFrame,
    startSeconds: clip.startFrame * secondsPerFrame,
    durationSeconds: clip.durationFrames * secondsPerFrame,
    audioFxChain: clip.audioFxChain ?? null,
    audioAutomation: clip.audioAutomation ?? null,
  };
}

function assertCommand(command: RemoteNativeMediaCommand): void {
  if (!command || !["muted", "gain", "playback-rate", "source-start", "trim", "audio-fx-chain", "audio-automation"].includes(command.kind)) {
    throw new Error("Unsupported native media command");
  }
  const maxGain = 10 ** (12 / 20) + 0.0000005;
  if (command.kind === "muted" && typeof command.value !== "boolean") throw new Error("Invalid mute value");
  if (command.kind === "gain" && (!Number.isFinite(command.value) || command.value < 0 || command.value > maxGain)) throw new Error("Invalid gain");
  if (command.kind === "playback-rate" && (!Number.isFinite(command.value) || command.value <= 0 || command.value > 16)) throw new Error("Invalid playback rate");
  if (command.kind === "source-start" && (!Number.isFinite(command.value) || command.value < 0)) throw new Error("Invalid source start");
  if (command.kind === "trim" && (!Number.isFinite(command.startSeconds) || !Number.isFinite(command.durationSeconds) ||
    command.startSeconds < 0 || command.durationSeconds <= 0)) throw new Error("Invalid trim range");
  if ((command.kind === "audio-fx-chain" || command.kind === "audio-automation") && command.value !== null) {
    if (typeof command.value !== "string" || command.value.length > 65536) throw new Error("Invalid audio payload");
    if (command.kind === "audio-fx-chain") parseAudioFxChain(command.value);
    else parseAutomation(command.value);
  }
}

function mutate(
  document: NativeProjectDocument,
  located: Located,
  state: PreviewElementState,
  command: RemoteNativeMediaCommand,
): NativeProjectDocument {
  const { clip, asset } = located;
  if (command.kind === "trim") {
    const plan = planNativeTimelineRangeEdit({ document,
      element: { attributes: { "data-studio-clip-id": clip.id }, sourceFile: state.sourceFile },
      requestedStartSeconds: command.startSeconds, requestedDurationSeconds: command.durationSeconds });
    if (!plan.ok) throw new Error(plan.failure.message);
    return plan.document;
  }
  const next = parseNativeProjectDocument(document);
  const target = next.sequence.tracks.flatMap(track => track.clips).find(item => item.id === clip.id)!;
  if (command.kind === "muted") {
    if (!command.value && asset.kind === "video" && next.sequence.tracks.some(track =>
      track.clips.some(other => other.audioDetachedFrom === target.id))) {
      throw new Error("This video's audio is detached");
    }
    target.muted = command.value;
  } else if (command.kind === "gain") {
    target.staticParameters = { ...target.staticParameters, "audio.volume": Math.min(command.value, 10 ** (12 / 20)) };
  } else if (command.kind === "playback-rate") {
    target.playbackRate = rationalFromNumber(command.value);
  } else if (command.kind === "source-start") {
    Object.assign(target, sourcePositionFromSeconds(command.value, next.frameRate));
  } else if (command.kind === "audio-fx-chain") {
    if (command.value) target.audioFxChain = command.value;
    else delete target.audioFxChain;
  } else if (command.kind === "audio-automation") {
    if (command.value) target.audioAutomation = command.value;
    else delete target.audioAutomation;
  }
  if (availableTimelineFrames(target, asset.durationFrames) < target.durationFrames) {
    throw new Error("The source range exceeds available media");
  }
  return next;
}

/** Re-resolve inside the file lock, then commit project and HTML mirrors atomically. */
export async function commitRemoteNativeMediaEdit(
  state: PreviewElementState,
  command: RemoteNativeMediaCommand,
  deps: RemoteNativeMediaDeps,
): Promise<NativeProjectDocument> {
  assertCommand(command);
  const sourceFile = state.sourceFile;
  if (!sourceFile || sourceFile === NATIVE_PROJECT_DOCUMENT_PATH) throw new Error("Invalid media source");
  const paths = [NATIVE_PROJECT_DOCUMENT_PATH, sourceFile];
  const saved = await serializeStudioFileMutations(deps.writeProjectFile, paths, async () => {
    const nativeBefore = await deps.readOptionalProjectFile(NATIVE_PROJECT_DOCUMENT_PATH);
    const htmlBefore = await deps.readOptionalProjectFile(sourceFile);
    if (!nativeBefore?.trim() || htmlBefore == null) throw new Error("Native media source is unavailable");
    const current = parseNativeProjectDocument(JSON.parse(nativeBefore));
    if (current.revision !== deps.expectedRevision) throw new NativeProjectRevisionConflictError(deps.expectedRevision, current.revision);
    const located = locate(current, state);
    if (!located) throw new Error("The selected media is not bound to this native clip");
    const next = mutate(current, located, state, command);
    const nextClip = next.sequence.tracks.flatMap(track => track.clips).find(item => item.id === located.clip.id)!;
    const stabilized = synchronizeNativeBindingSource(current, sourceFile,
      stabilizeNativeBindingSource(current, sourceFile, htmlBefore));
    const parsed = parseHTML(stabilized);
    const root = resolveNativeDomBinding(selector => [...parsed.document.querySelectorAll(selector)], located.clip.binding!);
    if (!root || root.getAttribute("data-studio-clip-id") !== located.clip.id) throw new Error("The native media has no unique authored element");
    const tag = located.asset.kind;
    const media = root.tagName.toLowerCase() === tag ? root : root.querySelector(tag);
    if (!media) throw new Error("The authored media element is unavailable");
    const secondsPerFrame = next.frameRate.denominator / next.frameRate.numerator;
    media.setAttribute("data-start", String(nextClip.startFrame * secondsPerFrame));
    media.setAttribute("data-duration", String(nextClip.durationFrames * secondsPerFrame));
    media.setAttribute("data-media-start", String(sourceFrameValue(nextClip) * secondsPerFrame));
    media.removeAttribute("data-playback-start");
    media.setAttribute("data-playback-rate", String(nextClip.playbackRate!.numerator / nextClip.playbackRate!.denominator));
    if (nextClip.muted) media.setAttribute("muted", ""); else media.removeAttribute("muted");
    if (nextClip.staticParameters?.["audio.volume"] !== undefined) media.setAttribute("data-volume", String(nextClip.staticParameters["audio.volume"]));
    else media.removeAttribute("data-volume");
    if (nextClip.audioFxChain) media.setAttribute("data-fx-chain", nextClip.audioFxChain); else media.removeAttribute("data-fx-chain");
    if (nextClip.audioAutomation) media.setAttribute("data-automation", nextClip.audioAutomation); else media.removeAttribute("data-automation");
    const committed = parseNativeProjectDocument({ ...next, revision: current.revision + 1 });
    const nativeAfter = serializeNativeProjectDocument(committed);
    const htmlAfter = parsed.document.toString();
    await commitNativeTimelineFileSnapshots({ orderedPaths: paths,
      snapshots: { [NATIVE_PROJECT_DOCUMENT_PATH]: { before: nativeBefore, after: nativeAfter },
        [sourceFile]: { before: htmlBefore, after: htmlAfter } },
      history: { kind: "timeline", label: `Edit media ${command.kind}` },
      commitFileTransaction: deps.commitFileTransaction, writeProjectFile: deps.writeProjectFile,
      recordEdit: deps.recordEdit, rollbackFailureMessage: "Media edit failed and rollback did not complete" });
    return committed;
  });
  deps.onNativeDocumentCommitted?.(saved);
  return saved;
}
