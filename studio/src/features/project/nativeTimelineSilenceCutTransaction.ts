import { removeElementFromHtml } from "@hyperframes/studio-server/source-mutation";
import { projectFrameFromSeconds, resolveNativeClipSelection, type NativeSelectedElementReference } from "../../../shared/project/nativePropertyEditPlan";
import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  parseNativeProjectDocument,
  serializeNativeProjectDocument,
  type NativeProjectClip,
  type NativeProjectDocument,
} from "../../../shared/project/nativeProjectDocument";
import type { TimelineElement } from "../../player/index";
import type { SilenceRemovalPlan } from "../timeline/removeSilence";
import { buildPatchTarget, buildTimelineMoveTimingPatch } from "../timeline/timelineEditingHelpers";
import { nativeBindingTarget, patchNativeTimelineSplitCompatibility } from "../timeline/nativeTimelineSplitCompatibility";
import type { RecordEditInput } from "../history/studioFileHistory";
import { serializeStudioFileMutations } from "../history/studioFileMutationCoordinator";
import { commitNativeTimelineSplits } from "./nativeTimelineSplitTransaction";
import { commitNativeTimelineDelete } from "./nativeTimelineDeleteTransaction";
import { commitNativeTimelineMultiMove } from "./nativeTimelineMultiMoveTransaction";
import { NativeProjectRevisionConflictError } from "./nativeProjectPersistence";
import { commitNativeTimelineFileSnapshots, type CommitNativeTimelineFileTransaction } from "./nativeTimelineTransactionCommit";

type FileWriter = (path: string, content: string, expected?: string) => Promise<void>;

export interface CommitNativeTimelineSilenceCutInput {
  expectedRevision: number;
  element: NativeSelectedElementReference;
  playbackElement: Pick<TimelineElement, "kind" | "playbackStartAttr">;
  plan: SilenceRemovalPlan;
  readOptionalProjectFile(path: string): Promise<string | null | undefined>;
  writeProjectFile: FileWriter;
  recordEdit(input: RecordEditInput): Promise<void>;
  commitFileTransaction?: CommitNativeTimelineFileTransaction;
  onCommitted?(document: NativeProjectDocument): void;
  signal?: AbortSignal;
}

const frameSeconds = (frame: number, document: NativeProjectDocument) =>
  frame * document.frameRate.denominator / document.frameRate.numerator;

function onlyClip(document: NativeProjectDocument, id: string): NativeProjectClip {
  const clips = document.sequence.tracks.flatMap(track => track.clips).filter(clip => clip.id === id);
  if (clips.length !== 1) throw new Error(`Native clip ${id} was not found uniquely`);
  return clips[0]!;
}

/**
 * Stage every native split/delete/move against a private file map, then save
 * only the final sidecar and authored source as one undoable transaction.
 */
export async function commitNativeTimelineSilenceCut(
  input: CommitNativeTimelineSilenceCutInput,
): Promise<NativeProjectDocument> {
  const initialContent = await input.readOptionalProjectFile(NATIVE_PROJECT_DOCUMENT_PATH);
  if (!initialContent) throw new Error("The authoritative native project is unavailable");
  const initial = parseNativeProjectDocument(JSON.parse(initialContent));
  if (initial.revision !== input.expectedRevision) {
    throw new NativeProjectRevisionConflictError(input.expectedRevision, initial.revision);
  }
  const selected = resolveNativeClipSelection(initial, input.element);
  if (!selected.ok) throw new Error(selected.failure.message);
  const originalClip = selected.located.clip;
  const sourceFile = originalClip.binding?.sourceFile;
  if (!sourceFile) throw new Error("Silence removal requires an authored source binding");

  return serializeStudioFileMutations(
    input.writeProjectFile,
    [NATIVE_PROJECT_DOCUMENT_PATH, sourceFile],
    async () => {
      const nativeBefore = await input.readOptionalProjectFile(NATIVE_PROJECT_DOCUMENT_PATH);
      const sourceBefore = await input.readOptionalProjectFile(sourceFile);
      if (!nativeBefore || sourceBefore == null) throw new Error("Silence removal source is unavailable");
      let document = parseNativeProjectDocument(JSON.parse(nativeBefore));
      if (document.revision !== input.expectedRevision) {
        throw new NativeProjectRevisionConflictError(input.expectedRevision, document.revision);
      }
      const resolved = resolveNativeClipSelection(document, input.element);
      if (!resolved.ok || resolved.located.clip.id !== originalClip.id) {
        throw new Error("The selected clip changed before silence removal");
      }
      const files = new Map([[NATIVE_PROJECT_DOCUMENT_PATH, nativeBefore], [sourceFile, sourceBefore]]);
      const stage = {
        readOptionalProjectFile: async (path: string) => files.get(path),
        writeProjectFile: async (path: string, content: string, expected?: string) => {
          if (files.get(path) !== expected) throw new Error(`Staged silence cut changed ${path} unexpectedly`);
          files.set(path, content);
        },
        recordEdit: async (_entry: RecordEditInput) => {},
        signal: input.signal,
      };
      const pieceIds = new Set([originalClip.id]);
      const boundaries = [...new Set(input.plan.cutTimes.map(time => projectFrameFromSeconds(time, document.frameRate)))];
      for (const splitFrame of boundaries.sort((a, b) => b - a)) {
        const beforeIds = new Set(document.sequence.tracks.flatMap(track => track.clips).map(clip => clip.id));
        const result = await commitNativeTimelineSplits({
          ...stage, expectedRevision: document.revision,
          splits: [{ element: { attributes: { "data-studio-clip-id": originalClip.id } },
            requestedSplitSeconds: frameSeconds(splitFrame, document) }],
          patchCompatibilityContent: (content, edit) => patchNativeTimelineSplitCompatibility(
            content, edit, onlyClip(document, originalClip.id), document, input.playbackElement,
          ),
        });
        if (!result.committed) throw new Error(`Silence split was rejected: ${result.reason}`);
        document = result.document;
        for (const clip of document.sequence.tracks.flatMap(track => track.clips)) {
          if (!beforeIds.has(clip.id)) pieceIds.add(clip.id);
        }
      }

      const pieces = input.plan.segments.map(segment => {
        const start = projectFrameFromSeconds(segment.start, document.frameRate);
        const end = projectFrameFromSeconds(segment.end, document.frameRate);
        const matches = document.sequence.tracks.flatMap(track => track.clips)
          .filter(clip => pieceIds.has(clip.id) && clip.startFrame === start && clip.durationFrames === end - start);
        if (matches.length !== 1) throw new Error("Silence pieces did not match the native timeline");
        return { segment, clip: matches[0]! };
      });
      const removed = pieces.filter(piece => piece.segment.remove);
      if (removed.length === 0) throw new Error("No silence pieces were selected");
      const deleted = await commitNativeTimelineDelete({
        ...stage, expectedRevision: document.revision,
        targets: removed.map(({ clip }) => ({ attributes: { "data-studio-clip-id": clip.id } })),
        removeCompatibilityTarget: (content, edit) =>
          removeElementFromHtml(content, nativeBindingTarget(edit.binding)),
      });
      if (!deleted.committed) throw new Error(`Silence delete was rejected: ${deleted.reason}`);
      document = deleted.document;

      let nextFrame = originalClip.startFrame;
      const moves = pieces.filter(piece => !piece.segment.remove).flatMap(({ clip }) => {
        const startFrame = nextFrame;
        nextFrame += clip.durationFrames;
        return startFrame === clip.startFrame ? [] : [{
          element: { attributes: { "data-studio-clip-id": clip.id } },
          requestedStartSeconds: frameSeconds(startFrame, document),
        }];
      });
      if (moves.length > 0) {
        const moved = await commitNativeTimelineMultiMove({
          ...stage, expectedRevision: document.revision, changes: moves,
          patchCompatibilityContent: (content, edit) => {
            const target = buildPatchTarget(edit.binding);
            const clip = onlyClip(document, edit.address.clipId);
            return target ? buildTimelineMoveTimingPatch(
              content, target, edit.exactStartSeconds, frameSeconds(clip.durationFrames, document),
              undefined, String(edit.exactStartSeconds),
            ) : content;
          },
        });
        if (!moved.committed) throw new Error(`Silence move was rejected: ${moved.reason}`);
        document = moved.document;
      }

      // The staged commands are implementation steps of one user action.
      // Publish one native revision alongside the one history entry.
      document = parseNativeProjectDocument({ ...document, revision: input.expectedRevision + 1 });
      const nativeAfter = serializeNativeProjectDocument(document);
      const sourceAfter = files.get(sourceFile)!;
      await commitNativeTimelineFileSnapshots({
        orderedPaths: [NATIVE_PROJECT_DOCUMENT_PATH, sourceFile],
        snapshots: {
          [NATIVE_PROJECT_DOCUMENT_PATH]: { before: nativeBefore, after: nativeAfter },
          [sourceFile]: { before: sourceBefore, after: sourceAfter },
        },
        history: { label: "Remove silence", kind: "timeline" },
        commitFileTransaction: input.commitFileTransaction,
        writeProjectFile: input.writeProjectFile,
        recordEdit: input.recordEdit,
        rollbackFailureMessage: "Silence removal failed and rollback did not complete",
        signal: input.signal,
      });
      input.onCommitted?.(document);
      return document;
    },
  );
}
