import { resolveNativeClipSelection, type NativeSelectedElementReference } from "../../../shared/project/nativePropertyEditPlan";
import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  parseNativeProjectDocument,
  serializeNativeProjectDocument,
  type NativeProjectDocument,
} from "../../../shared/project/nativeProjectDocument";
import type { RecordEditInput } from "../history/studioFileHistory";
import { serializeStudioFileMutations } from "../history/studioFileMutationCoordinator";
import { NativeProjectRevisionConflictError } from "./nativeProjectPersistence";
import {
  commitNativeTimelineFileSnapshots,
  type CommitNativeTimelineFileTransaction,
} from "./nativeTimelineTransactionCommit";
import { discoverNativeTimelineSources } from "./nativeTimelineSources";

interface CommitNativeAudioGroupInput {
  expectedRevision: number;
  members: readonly NativeSelectedElementReference[];
  groupId: string;
  groupLabel?: string;
  groupPath: string;
  readOptionalProjectFile: (path: string) => Promise<string | null | undefined>;
  writeProjectFile: (path: string, content: string, expectedContent?: string) => Promise<void>;
  recordEdit: (input: RecordEditInput) => Promise<void>;
  commitFileTransaction?: CommitNativeTimelineFileTransaction;
  patchCompatibilityFile: (path: string, content: string) => string;
  onCommitted?: (document: NativeProjectDocument) => void;
}

/** Commit the bus, all clip memberships and their HTML mirrors in one history entry. */
export async function commitNativeTimelineAudioGroup(input: CommitNativeAudioGroupInput): Promise<NativeProjectDocument> {
  if (input.members.length < 2) throw new Error("An audio group needs at least two clips");
  const discovery = await discoverNativeTimelineSources(input, input.members);
  if (!discovery.ok) throw new Error(`Cannot group clips: ${discovery.reason}`);
  const sourcePaths = [...new Set([...discovery.sourceFiles, input.groupPath])].sort();
  const orderedPaths = [NATIVE_PROJECT_DOCUMENT_PATH, ...sourcePaths];

  const document = await serializeStudioFileMutations(input.writeProjectFile, orderedPaths, async () => {
    const nativeBefore = await input.readOptionalProjectFile(NATIVE_PROJECT_DOCUMENT_PATH);
    if (!nativeBefore?.trim()) throw new Error("Native project is missing");
    const current = parseNativeProjectDocument(JSON.parse(nativeBefore));
    if (current.revision !== input.expectedRevision) {
      throw new NativeProjectRevisionConflictError(input.expectedRevision, current.revision);
    }
    if (current.sequence.audioGroups?.some((group) => group.id === input.groupId)) {
      throw new Error(`Audio group ${input.groupId} already exists`);
    }

    const memberIds = new Set<string>();
    const touchedTrackIds = new Set<string>();
    for (const member of input.members) {
      const resolution = resolveNativeClipSelection(current, member);
      if (!resolution.ok) throw new Error(resolution.failure.message);
      const clip = resolution.located.clip;
      const asset = current.assets.find((item) => item.id === clip.assetId);
      if (asset?.kind !== "audio" && asset?.kind !== "video") {
        throw new Error(`Clip ${clip.id} is not an audio or video clip`);
      }
      touchedTrackIds.add(resolution.located.trackId);
      if (!clip.binding?.domId || !sourcePaths.includes(clip.binding.sourceFile)) {
        throw new Error(`Clip ${clip.id} needs a bound DOM id to join an audio group`);
      }
      if (memberIds.has(clip.id)) throw new Error(`Clip ${clip.id} was selected twice`);
      memberIds.add(clip.id);
    }
    for (const track of current.sequence.tracks) {
      if (!touchedTrackIds.has(track.id)) continue;
      const containsVideo = track.clips.some((clip) =>
        current.assets.some((asset) => asset.id === clip.assetId && asset.kind === "video"));
      if (!containsVideo) continue;
      if (track.clips.some((clip) => !memberIds.has(clip.id))) {
        throw new Error("Select every clip on a video track before grouping its audio");
      }
    }

    const next = parseNativeProjectDocument({
      ...current,
      revision: current.revision + 1,
      sequence: {
        ...current.sequence,
        audioGroups: [
          ...(current.sequence.audioGroups ?? []),
          { id: input.groupId, ...(input.groupLabel ? { label: input.groupLabel } : {}) },
        ],
        tracks: current.sequence.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) =>
            memberIds.has(clip.id) ? { ...clip, audioGroupId: input.groupId } : clip),
        })),
      },
    });
    const snapshots: Record<string, { before: string; after: string }> = {
      [NATIVE_PROJECT_DOCUMENT_PATH]: {
        before: nativeBefore,
        after: serializeNativeProjectDocument(next),
      },
    };
    for (const path of sourcePaths) {
      const before = await input.readOptionalProjectFile(path);
      if (before == null) throw new Error(`Audio group source ${path} is missing`);
      const after = input.patchCompatibilityFile(path, before);
      if (after === before) throw new Error(`Audio group source ${path} was not patched`);
      snapshots[path] = { before, after };
    }
    await commitNativeTimelineFileSnapshots({
      orderedPaths,
      snapshots,
      history: {
        label: input.groupLabel
          ? `Group ${memberIds.size} clips as ${input.groupLabel}`
          : `Group ${memberIds.size} audio clips`,
        kind: "timeline",
      },
      commitFileTransaction: input.commitFileTransaction,
      writeProjectFile: input.writeProjectFile,
      recordEdit: input.recordEdit,
      rollbackFailureMessage: "Audio group save failed and rollback did not complete",
    });
    return next;
  });
  input.onCommitted?.(document);
  return document;
}
