import { NATIVE_PROJECT_DOCUMENT_PATH, parseNativeProjectDocument, serializeNativeProjectDocument } from "../../../shared/project/nativeProjectDocument";
import { resolveNativeClipSelection } from "../../../shared/project/nativePropertyEditPlan";
import { availableTimelineFrames, rationalFromNumber, sourceFrameValue, sourcePositionFromSeconds } from "../../../shared/project/nativeSourceTime";
import { applyNativeProjectClipCommand } from "../../../shared/project/nativeProjectClipCommands";
import type { UseProjectAnimatedPropertyCommitOptions } from "../animation/useProjectAnimatedPropertyCommit";
import { applyPatchByTarget, type PatchOperation } from "../legacy/sourcePatcher";
import { serializeStudioFileMutations } from "../history/studioFileMutationCoordinator";
import type { RecordEditInput } from "../history/studioFileHistory";
import { commitNativeTimelineFileSnapshots } from "../project/nativeTimelineTransactionCommit";
import { stabilizeNativeBindingSource } from "../project/nativeBindingSource";
import { commitNativeTimelineAudioAttribute } from "../project/nativeTimelineAudioAttributeTransaction";
import { HF_AUDIO_GROUP_TAG } from "@hyperframes/core/audio-groups";
import type { DomEditSelection } from "./domEditing";

const GROUP_ATTRIBUTES = new Set(["data-volume", "data-hidden", "data-fx-chain", "data-automation", "data-label"]);

function mediaField(operation: PatchOperation): "rate" | "source" | "muted" | "gain" | "fx" | "automation" | null {
  if (operation.childSelector || operation.childIndex !== undefined) return null;
  if (operation.type === "html-attribute" && operation.property === "muted") return "muted";
  if (operation.type !== "attribute") return null;
  const name = operation.property.replace(/^data-/, "");
  if (name === "playback-rate") return "rate";
  if (name === "media-start" || name === "playback-start") return "source";
  if (name === "volume") return "gain";
  if (name === "fx-chain") return "fx";
  if (name === "automation") return "automation";
  return null;
}

function audioGain(value: string | null): number {
  if (value === null || value === "") return 1;
  const gain = Number(value);
  const max = 10 ** (12 / 20);
  // The inspector writes six decimal places, so its +12 dB endpoint rounds up.
  if (!Number.isFinite(gain) || gain < 0 || gain > max + 0.0000005) {
    throw new Error("Audio gain is outside the supported range");
  }
  return Math.min(gain, max);
}

/** Media controls commit the native state and authored markup together. */
export async function commitNativeMediaAttributes(
  selection: DomEditSelection,
  operations: PatchOperation[],
  sourceFile: string,
  editing: Omit<UseProjectAnimatedPropertyCommitOptions, "legacyCommitProperties"> | undefined,
  recordEdit: (entry: RecordEditInput) => Promise<void>,
  history: { label?: string; coalesceKey?: string; prepareContent?: (html: string, sourceFile: string) => string } = {},
): Promise<boolean> {
  if (editing && selection.element.tagName.toLowerCase() === HF_AUDIO_GROUP_TAG && operations.length === 1) {
    const operation = operations[0]!;
    const attr = operation.type === "attribute" && !operation.childSelector && operation.childIndex === undefined
      ? `data-${operation.property.replace(/^data-/, "")}` : null;
    if (attr && GROUP_ATTRIBUTES.has(attr)) {
      const nativeContent = await editing.readOptionalProjectFile(NATIVE_PROJECT_DOCUMENT_PATH);
      if (!nativeContent?.trim()) return false;
      const current = parseNativeProjectDocument(JSON.parse(nativeContent));
      const id = selection.id ?? selection.element.id;
      if (!current.sequence.audioGroups?.some(group => group.id === id)) return false;
      await commitNativeTimelineAudioAttribute({
        expectedRevision: current.revision,
        target: { kind: "group", id, sourceFile },
        attr, value: operation.value, label: history.label ?? "Edit audio group",
        readOptionalProjectFile: editing.readOptionalProjectFile,
        writeProjectFile: editing.writeProjectFile,
        recordEdit, commitFileTransaction: editing.commitFileTransaction,
        onCommitted: editing.onNativeDocumentCommitted,
      });
      return true;
    }
  }
  if (!editing || !operations.some(operation => mediaField(operation))) return false;
  const result = await serializeStudioFileMutations(editing.writeProjectFile, [NATIVE_PROJECT_DOCUMENT_PATH, sourceFile], async () => {
    const nativeBefore = await editing.readOptionalProjectFile(NATIVE_PROJECT_DOCUMENT_PATH);
    if (!nativeBefore?.trim()) return null;
    let project = parseNativeProjectDocument(JSON.parse(nativeBefore));
    const resolution = resolveNativeClipSelection(project, {
      id: selection.id, hfId: selection.hfId, sourceFile,
      selector: selection.selector, selectorIndex: selection.selectorIndex,
      attributes: { "data-studio-clip-id": selection.element.getAttribute("data-studio-clip-id") },
    });
    if (!resolution.ok) {
      if (resolution.failure.code === "clip-not-found" && !selection.element.hasAttribute("data-studio-clip-id")) return null;
      throw new Error(resolution.failure.message);
    }
    let clip = resolution.located.clip;
    const asset = project.assets.find(candidate => candidate.id === clip.assetId)!;
    if (asset.kind !== "video" && asset.kind !== "audio") return null;
    if (clip.binding?.sourceFile !== sourceFile) throw new Error("The selected media does not belong to this composition");
    const before = await editing.readOptionalProjectFile(sourceFile);
    if (before == null) throw new Error(`Missing composition ${sourceFile}`);
    let after = stabilizeNativeBindingSource(project, sourceFile, before);
    const candidate = { ...clip, staticParameters: { ...clip.staticParameters } };
    for (const operation of operations) {
      const field = mediaField(operation);
      if (field === "muted") candidate.muted = operation.value !== null;
      if (field === "gain") candidate.staticParameters["audio.volume"] = audioGain(operation.value);
      if (field === "fx") candidate.audioFxChain = operation.value || undefined;
      if (field === "automation") candidate.audioAutomation = operation.value || undefined;
      if (field === "rate") {
        const value = operation.value === null ? 1 : Number(operation.value);
        if (!Number.isFinite(value) || value <= 0) throw new Error("Playback rate must be greater than zero");
        candidate.playbackRate = rationalFromNumber(value);
      }
      if (field === "source") Object.assign(candidate, sourcePositionFromSeconds(operation.value === null ? 0 : Number(operation.value), project.frameRate));
    }
    if (asset.kind === "video" && !candidate.muted &&
        project.sequence.tracks.some(track => track.clips.some(other => other.audioDetachedFrom === clip.id))) {
      throw new Error("This video's sound is detached; unmute its linked audio clip instead");
    }
    const available = availableTimelineFrames(candidate, asset.durationFrames);
    if (available < 1) throw new Error("The source offset leaves no complete frame of media");
    if (clip.durationFrames > available) {
      const trimmed = applyNativeProjectClipCommand(project, {
        type: "trim-out", address: { sequenceId: project.sequence.id, trackId: resolution.located.trackId, clipId: clip.id },
        endFrameExclusive: clip.startFrame + available,
      });
      if (!trimmed.ok) throw new Error(trimmed.failure.message);
      project = trimmed.document;
      clip = project.sequence.tracks.flatMap(track => track.clips).find(candidate => candidate.id === clip.id)!;
    }
    Object.assign(clip, {
      muted: candidate.muted, playbackRate: candidate.playbackRate,
      sourceInFrame: candidate.sourceInFrame, sourceInFraction: candidate.sourceInFraction,
      staticParameters: candidate.staticParameters,
    });
    if (candidate.audioFxChain) clip.audioFxChain = candidate.audioFxChain;
    else delete clip.audioFxChain;
    if (candidate.audioAutomation) clip.audioAutomation = candidate.audioAutomation;
    else delete clip.audioAutomation;
    const binding = clip.binding!;
    const target = { id: binding.domId, hfId: binding.hfId };
    for (const operation of operations) after = applyPatchByTarget(after, target, operation);
    const secondsPerFrame = project.frameRate.denominator / project.frameRate.numerator;
    const mirrors: PatchOperation[] = [
      { type: "attribute", property: "media-start", value: String(sourceFrameValue(clip) * secondsPerFrame) },
      { type: "attribute", property: "playback-start", value: null },
      { type: "attribute", property: "playback-rate", value: String(clip.playbackRate!.numerator / clip.playbackRate!.denominator) },
      { type: "attribute", property: "duration", value: String(clip.durationFrames * secondsPerFrame) },
      { type: "html-attribute", property: "muted", value: clip.muted ? "" : null },
    ];
    for (const mirror of mirrors) after = applyPatchByTarget(after, target, mirror);
    if (history.prepareContent) after = history.prepareContent(after, sourceFile);
    project = parseNativeProjectDocument({ ...project, revision: project.revision + 1 });
    const nativeAfter = serializeNativeProjectDocument(project);
    await commitNativeTimelineFileSnapshots({
      orderedPaths: [NATIVE_PROJECT_DOCUMENT_PATH, sourceFile],
      snapshots: { [NATIVE_PROJECT_DOCUMENT_PATH]: { before: nativeBefore, after: nativeAfter }, [sourceFile]: { before, after } },
      history: { kind: "timeline", label: history.label ?? "Edit media", coalesceKey: history.coalesceKey },
      commitFileTransaction: editing.commitFileTransaction, writeProjectFile: editing.writeProjectFile, recordEdit,
      rollbackFailureMessage: "Media edit failed and rollback did not complete",
    });
    return project;
  });
  if (!result) return false;
  editing.onNativeDocumentCommitted?.(result);
  return true;
}
