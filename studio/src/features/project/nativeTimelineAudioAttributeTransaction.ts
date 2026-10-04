import { parseHTML } from "linkedom";
import { resolveNativeDomBinding } from "../../../shared/project/nativeDomBinding";
import { resolveNativeClipSelection, type NativeSelectedElementReference } from "../../../shared/project/nativePropertyEditPlan";
import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  parseNativeProjectDocument,
  serializeNativeProjectDocument,
  type NativeProjectDocument,
} from "../../../shared/project/nativeProjectDocument";
import type { RecordEditInput } from "../history/studioFileHistory";
import { serializeStudioFileMutations } from "../history/studioFileMutationCoordinator";
import { stabilizeNativeBindingSource } from "./nativeBindingSource";
import { NativeProjectRevisionConflictError } from "./nativeProjectPersistence";
import { commitNativeTimelineFileSnapshots, type CommitNativeTimelineFileTransaction } from "./nativeTimelineTransactionCommit";

export interface NativeAudioAttributeInput {
  expectedRevision: number;
  target: { kind: "group"; id: string; sourceFile: string } |
    { kind: "clip"; selection: NativeSelectedElementReference; sourceFile: string };
  attr: string;
  value: string | null;
  label: string;
  readOptionalProjectFile(path: string): Promise<string | null | undefined>;
  writeProjectFile(path: string, content: string, expectedContent?: string): Promise<void>;
  recordEdit(input: RecordEditInput): Promise<void>;
  commitFileTransaction?: CommitNativeTimelineFileTransaction;
  onCommitted?(document: NativeProjectDocument): void;
}

function gain(value: string | null): number {
  if (value === null || value === "") return 1;
  const result = Number(value);
  const max = 10 ** (12 / 20);
  // The fader writes six decimal places, so the +12 dB endpoint rounds up.
  if (!Number.isFinite(result) || result < 0 || result > max + 0.0000005) {
    throw new Error("Audio gain is outside the supported range");
  }
  return Math.min(result, max);
}

/** Keep the saved native audio model and the authored preview attributes in one undo entry. */
export async function commitNativeTimelineAudioAttribute(input: NativeAudioAttributeInput): Promise<NativeProjectDocument> {
  const target = input.target;
  const sourceFile = target.sourceFile;
  const orderedPaths = [NATIVE_PROJECT_DOCUMENT_PATH, sourceFile];
  const committed = await serializeStudioFileMutations(input.writeProjectFile, orderedPaths, async () => {
    const nativeBefore = await input.readOptionalProjectFile(NATIVE_PROJECT_DOCUMENT_PATH);
    const htmlBefore = await input.readOptionalProjectFile(sourceFile);
    if (!nativeBefore?.trim() || htmlBefore == null) throw new Error("Native audio source is unavailable");
    const current = parseNativeProjectDocument(JSON.parse(nativeBefore));
    if (current.revision !== input.expectedRevision) {
      throw new NativeProjectRevisionConflictError(input.expectedRevision, current.revision);
    }
    const next = parseNativeProjectDocument(current);
    let markup = htmlBefore;
    let element: Element;
    if (target.kind === "group") {
      const group = next.sequence.audioGroups?.find(candidate => candidate.id === target.id);
      if (!group) throw new Error("The native audio group is no longer available");
      const supported = ["data-volume", "data-hidden", "data-fx-chain", "data-automation", "data-label"];
      if (!supported.includes(input.attr)) throw new Error(`Unsupported native audio group attribute ${input.attr}`);
      if (input.attr === "data-volume") group.volume = gain(input.value);
      if (input.attr === "data-hidden") group.muted = input.value !== null;
      if (input.attr === "data-fx-chain") {
        if (input.value) group.fxChain = input.value;
        else delete group.fxChain;
      }
      if (input.attr === "data-automation") {
        if (input.value) group.automation = input.value;
        else delete group.automation;
      }
      if (input.attr === "data-label") {
        if (input.value) group.label = input.value;
        else delete group.label;
      }
      const parsed = parseHTML(markup);
      const matches = [...parsed.document.querySelectorAll("[id]")].filter(node => node.getAttribute("id") === group.id);
      if (matches.length !== 1 || matches[0]!.tagName.toLowerCase() !== "hf-audio-group") {
        throw new Error("The native audio group has no unique preview element");
      }
      element = matches[0]!;
      if (input.value === null) element.removeAttribute(input.attr);
      else element.setAttribute(input.attr, input.value);
      markup = parsed.document.toString();
    } else {
      const resolution = resolveNativeClipSelection(next, target.selection);
      if (!resolution.ok) throw new Error(resolution.failure.message);
      const clip = resolution.located.clip;
      const asset = next.assets.find(candidate => candidate.id === clip.assetId);
      if (!asset || (asset.kind !== "video" && asset.kind !== "audio") || clip.binding?.sourceFile !== sourceFile) {
        throw new Error("The native audio clip is no longer bound to this source");
      }
      const supported = ["muted", "data-volume", "data-fx-chain", "data-automation"];
      if (!supported.includes(input.attr)) throw new Error(`Unsupported native audio clip attribute ${input.attr}`);
      if (input.attr === "muted" && input.value === null && asset.kind === "video" &&
          next.sequence.tracks.some(track => track.clips.some(candidate => candidate.audioDetachedFrom === clip.id))) {
        throw new Error("This video's sound is detached; unmute its linked audio clip instead");
      }
      if (input.attr === "muted") clip.muted = input.value !== null;
      if (input.attr === "data-volume") clip.staticParameters = { ...clip.staticParameters, "audio.volume": gain(input.value) };
      if (input.attr === "data-fx-chain") {
        if (input.value) clip.audioFxChain = input.value;
        else delete clip.audioFxChain;
      }
      if (input.attr === "data-automation") {
        if (input.value) clip.audioAutomation = input.value;
        else delete clip.audioAutomation;
      }
      markup = stabilizeNativeBindingSource(next, sourceFile, markup);
      const parsed = parseHTML(markup);
      const root = resolveNativeDomBinding(selector => [...parsed.document.querySelectorAll(selector)], clip.binding!);
      if (!root) throw new Error("The native audio clip has no unique preview element");
      const tag = asset.kind;
      const media = root.tagName.toLowerCase() === tag ? root : root.querySelector(tag);
      if (!media) throw new Error("The native audio clip's preview media is unavailable");
      element = media;
      if (input.value === null) element.removeAttribute(input.attr);
      else element.setAttribute(input.attr, input.attr === "muted" ? "" : input.value);
      markup = parsed.document.toString();
    }
    next.revision = current.revision + 1;
    const nativeAfter = serializeNativeProjectDocument(parseNativeProjectDocument(next));
    await commitNativeTimelineFileSnapshots({
      orderedPaths,
      snapshots: {
        [NATIVE_PROJECT_DOCUMENT_PATH]: { before: nativeBefore, after: nativeAfter },
        [sourceFile]: { before: htmlBefore, after: markup },
      },
      history: { kind: "timeline", label: input.label },
      commitFileTransaction: input.commitFileTransaction,
      writeProjectFile: input.writeProjectFile,
      recordEdit: input.recordEdit,
      rollbackFailureMessage: "Audio edit failed and rollback did not complete",
    });
    return parseNativeProjectDocument(JSON.parse(nativeAfter));
  });
  input.onCommitted?.(committed);
  return committed;
}
