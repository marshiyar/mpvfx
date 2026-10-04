import { parseHTML } from "linkedom";
import { resolveNativeDomBinding } from "../../../shared/project/nativeDomBinding";
import {
  detachNativeVideoAudio,
  reattachNativeVideoAudio,
  createNativeDetachAudioIds,
  type NativeDetachAudioIds,
} from "../../../shared/project/nativeProjectAudioCommands";
import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  parseNativeProjectDocument,
  serializeNativeProjectDocument,
  type NativeProjectClip,
  type NativeProjectDocument,
} from "../../../shared/project/nativeProjectDocument";
import { sourceFrameValue } from "../../../shared/project/nativeSourceTime";
import type { RecordEditInput } from "../history/studioFileHistory";
import { serializeStudioFileMutations } from "../history/studioFileMutationCoordinator";
import { stabilizeNativeBindingSource } from "./nativeBindingSource";
import { NativeProjectRevisionConflictError } from "./nativeProjectPersistence";
import {
  commitNativeTimelineFileSnapshots,
  type CommitNativeTimelineFileTransaction,
} from "./nativeTimelineTransactionCommit";

type ProjectFileWriter = (path: string, content: string, expectedContent?: string) => Promise<void>;

export interface CommitNativeTimelineAudioInput {
  expectedRevision: number;
  action: "detach" | "reattach";
  clipId: string;
  /** A fresh, project-contained FFprobe result; required for detach. */
  hasAudioStream?: boolean;
  ids?: NativeDetachAudioIds;
  readOptionalProjectFile(path: string): Promise<string | null | undefined>;
  writeProjectFile: ProjectFileWriter;
  recordEdit(input: RecordEditInput): Promise<void>;
  commitFileTransaction?: CommitNativeTimelineFileTransaction;
  onCommitted?(document: NativeProjectDocument): void;
}

function uniqueClip(project: NativeProjectDocument, id: string): NativeProjectClip {
  const matches = project.sequence.tracks.flatMap(track => track.clips).filter(clip => clip.id === id);
  if (matches.length !== 1) throw new Error(`Native clip ${id} was not found uniquely`);
  return matches[0]!;
}

function boundMedia(document: Document, clip: NativeProjectClip, tag: "video" | "audio"): Element {
  if (!clip.binding) throw new Error(`Native clip ${clip.id} has no preview binding`);
  const root = resolveNativeDomBinding(selector => [...document.querySelectorAll(selector)], clip.binding);
  if (!root) throw new Error(`Native clip ${clip.id} cannot be found in its source`);
  const media = root.tagName.toLowerCase() === tag ? root : root.querySelector(tag);
  if (!media) throw new Error(`Native clip ${clip.id} has no ${tag} element`);
  return media;
}

function clipSeconds(frame: number, project: NativeProjectDocument): string {
  return String(frame * project.frameRate.denominator / project.frameRate.numerator);
}

function patchPreview(
  source: string,
  current: NativeProjectDocument,
  next: NativeProjectDocument,
  input: CommitNativeTimelineAudioInput,
  sourceFile: string,
): { html: string; document: NativeProjectDocument } {
  const stable = stabilizeNativeBindingSource(current, sourceFile, source);
  const { document } = parseHTML(stable);
  if (input.action === "detach") {
    const video = uniqueClip(current, input.clipId);
    const linked = next.sequence.tracks.flatMap(track => track.clips)
      .find(clip => clip.audioDetachedFrom === video.id);
    if (!linked || !input.ids) throw new Error("Detached audio was not created uniquely");
    const media = boundMedia(document, video, "video");
    const src = media.getAttribute("src");
    if (!src) throw new Error("The selected video has no preview source");
    if ([...document.querySelectorAll("[id]")].some(node => node.getAttribute("id") === input.ids!.clipId)) {
      throw new Error("The detached audio preview ID already exists");
    }
    const audio = document.createElement("audio");
    audio.setAttribute("id", input.ids.clipId);
    audio.setAttribute("data-studio-clip-id", linked.id);
    audio.setAttribute("class", "clip");
    audio.setAttribute("src", src);
    audio.setAttribute("data-start", clipSeconds(linked.startFrame, next));
    audio.setAttribute("data-duration", clipSeconds(linked.durationFrames, next));
    audio.setAttribute("data-media-start", clipSeconds(sourceFrameValue(linked), next));
    audio.setAttribute("data-playback-rate", String(linked.playbackRate!.numerator / linked.playbackRate!.denominator));
    const track = next.sequence.tracks.find(track => track.clips.some(clip => clip.id === linked.id))!;
    audio.setAttribute("data-track-index", String(track.lane?.authoredTrack ?? 0));
    for (const attribute of ["data-source-duration", "data-volume", "data-fx-chain", "data-automation", "data-audio-group"]) {
      const value = media.getAttribute(attribute);
      if (value !== null) audio.setAttribute(attribute, value);
      if (attribute !== "data-source-duration") media.removeAttribute(attribute);
    }
    if (linked.muted) audio.setAttribute("muted", "");
    media.setAttribute("muted", "");
    media.setAttribute("data-has-audio", "false");
    media.after(audio);
    linked.binding = { sourceFile, domId: input.ids.clipId };
  } else {
    const audio = uniqueClip(current, input.clipId);
    if (!audio.audioDetachedFrom) throw new Error("This audio is not linked to a video");
    const video = uniqueClip(current, audio.audioDetachedFrom);
    const audioMedia = boundMedia(document, audio, "audio");
    const videoMedia = boundMedia(document, video, "video");
    if (audioMedia.getAttribute("src") !== videoMedia.getAttribute("src")) {
      throw new Error("The detached audio preview source no longer matches the video");
    }
    for (const attribute of ["data-volume", "data-fx-chain", "data-automation", "data-audio-group"]) {
      const value = audioMedia.getAttribute(attribute);
      if (value === null) videoMedia.removeAttribute(attribute);
      else videoMedia.setAttribute(attribute, value);
    }
    audioMedia.remove();
    const nextVideo = uniqueClip(next, video.id);
    if (nextVideo.muted) {
      videoMedia.setAttribute("muted", "");
      videoMedia.setAttribute("data-has-audio", "false");
    } else {
      videoMedia.removeAttribute("muted");
      videoMedia.setAttribute("data-has-audio", "true");
    }
  }
  return { html: document.toString(), document: parseNativeProjectDocument(next) };
}

/** One revision, one history entry, and one durable file transaction for both representations. */
export async function commitNativeTimelineAudio(input: CommitNativeTimelineAudioInput): Promise<NativeProjectDocument> {
  // The compatibility element and native clip must use the very same generated id.
  const ids = input.action === "detach" ? input.ids ?? createNativeDetachAudioIds() : undefined;
  const initialContent = await input.readOptionalProjectFile(NATIVE_PROJECT_DOCUMENT_PATH);
  if (!initialContent?.trim()) throw new Error("The native project document is unavailable");
  const initial = parseNativeProjectDocument(JSON.parse(initialContent));
  if (initial.revision !== input.expectedRevision)
    throw new NativeProjectRevisionConflictError(input.expectedRevision, initial.revision);
  const selected = uniqueClip(initial, input.clipId);
  const video = input.action === "detach" ? selected : uniqueClip(initial, selected.audioDetachedFrom ?? "");
  const sourceFile = video.binding?.sourceFile;
  if (!sourceFile || (input.action === "reattach" && selected.binding?.sourceFile !== sourceFile)) {
    throw new Error("The linked clips need exact bindings in one preview source");
  }

  const committed = await serializeStudioFileMutations(input.writeProjectFile,
    [NATIVE_PROJECT_DOCUMENT_PATH, sourceFile], async () => {
      const nativeBefore = await input.readOptionalProjectFile(NATIVE_PROJECT_DOCUMENT_PATH);
      const htmlBefore = await input.readOptionalProjectFile(sourceFile);
      if (!nativeBefore?.trim() || htmlBefore == null) throw new Error("The native project or preview source is unavailable");
      const current = parseNativeProjectDocument(JSON.parse(nativeBefore));
      if (current.revision !== input.expectedRevision)
        throw new NativeProjectRevisionConflictError(input.expectedRevision, current.revision);
      const currentSelected = uniqueClip(current, input.clipId);
      const currentVideo = input.action === "detach" ? currentSelected : uniqueClip(current, currentSelected.audioDetachedFrom ?? "");
      if (currentVideo.binding?.sourceFile !== sourceFile ||
          (input.action === "reattach" && currentSelected.binding?.sourceFile !== sourceFile)) {
        throw new Error("The clip binding changed while detaching audio");
      }
      const next = input.action === "detach"
        ? detachNativeVideoAudio(current, input.clipId, input.hasAudioStream === true, ids)
        : reattachNativeVideoAudio(current, input.clipId);
      const patched = patchPreview(htmlBefore, current, next, { ...input, ids }, sourceFile);
      patched.document.revision = current.revision + 1;
      const nativeAfter = serializeNativeProjectDocument(patched.document);
      await commitNativeTimelineFileSnapshots({
        orderedPaths: [NATIVE_PROJECT_DOCUMENT_PATH, sourceFile],
        snapshots: {
          [NATIVE_PROJECT_DOCUMENT_PATH]: { before: nativeBefore, after: nativeAfter },
          [sourceFile]: { before: htmlBefore, after: patched.html },
        },
        history: { label: input.action === "detach" ? "Detach video audio" : "Reattach video audio", kind: "timeline" },
        commitFileTransaction: input.commitFileTransaction,
        writeProjectFile: input.writeProjectFile,
        recordEdit: input.recordEdit,
        rollbackFailureMessage: "Video audio edit failed and rollback did not complete",
      });
      return patched.document;
    });
  input.onCommitted?.(committed);
  return committed;
}
