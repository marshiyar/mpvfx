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
import type { DomEditSelection } from "./domEditing";

function mediaField(operation: PatchOperation): "rate" | "source" | "muted" | null {
  if (operation.childSelector || operation.childIndex !== undefined) return null;
  if (operation.type === "html-attribute" && operation.property === "muted") return "muted";
  if (operation.type !== "attribute") return null;
  const name = operation.property.replace(/^data-/, "");
  return name === "playback-rate" ? "rate" : name === "media-start" || name === "playback-start" ? "source" : null;
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
    const candidate = { ...clip };
    for (const operation of operations) {
      const field = mediaField(operation);
      if (field === "muted") candidate.muted = operation.value !== null;
      if (field === "rate") {
        const value = operation.value === null ? 1 : Number(operation.value);
        if (!Number.isFinite(value) || value <= 0) throw new Error("Playback rate must be greater than zero");
        candidate.playbackRate = rationalFromNumber(value);
      }
      if (field === "source") Object.assign(candidate, sourcePositionFromSeconds(operation.value === null ? 0 : Number(operation.value), project.frameRate));
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
    Object.assign(clip, { muted: candidate.muted, playbackRate: candidate.playbackRate, sourceInFrame: candidate.sourceInFrame, sourceInFraction: candidate.sourceInFraction });
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
