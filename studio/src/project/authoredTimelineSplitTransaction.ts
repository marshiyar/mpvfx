import type { TimelineElement } from "../player";
import { buildPatchTarget } from "../hooks/timelineEditingHelpers";
import { splitAuthoredClip } from "../utils/splitAuthoredClip";
import { serializeStudioFileMutations } from "../utils/studioFileMutationCoordinator";
import type { RecordEditInput } from "../utils/studioFileHistory";
import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  parseNativeProjectDocument,
  serializeNativeProjectDocument,
} from "./nativeProjectDocument";
import { projectFrameFromSeconds, resolveNativeClipSelection } from "./nativePropertyEditPlan";
import { planNativeTimelineSplits } from "./nativeTimelineSplitPlan";
import { planNativeTimelineDelete } from "./nativeTimelineDeletePlan";
import { removeElementFromHtml } from "@hyperframes/studio-server/source-mutation";
import { furthestClipEndFromSource } from "../player/lib/timelineElementHelpers";
import { setCompositionDurationToContent } from "../utils/timelineAssetDrop";
import {
  commitNativeTimelineFileSnapshots,
  type CommitNativeTimelineFileTransaction,
} from "./nativeTimelineTransactionCommit";

interface Input {
  elements: readonly TimelineElement[];
  splitSeconds: number;
  activeCompPath: string | null;
  readOptionalProjectFile(path: string): Promise<string | null | undefined>;
  writeProjectFile(path: string, content: string, expectedContent?: string): Promise<void>;
  recordEdit(input: RecordEditInput): Promise<void>;
  commitFileTransaction?: CommitNativeTimelineFileTransaction;
}
/** One file transaction for mixed native media and authored titles/graphics. */
export async function commitAuthoredTimelineSplits(input: Input) {
  return commitAuthoredTimelineEdits(input, "split");
}
export async function commitAuthoredTimelineDelete(input: Omit<Input, "splitSeconds">) {
  return commitAuthoredTimelineEdits({ ...input, splitSeconds: 0 }, "delete");
}
async function commitAuthoredTimelineEdits(input: Input, action: "split" | "delete") {
  if (!input.elements.length) throw new Error("Select clips to split.");
  const paths = [
    ...new Set(input.elements.map((el) => el.sourceFile || input.activeCompPath || "index.html")),
  ];
  return serializeStudioFileMutations(
    input.writeProjectFile,
    [NATIVE_PROJECT_DOCUMENT_PATH, ...paths],
    async () => {
      const nativeBefore = await input.readOptionalProjectFile(NATIVE_PROJECT_DOCUMENT_PATH);
      const initial = nativeBefore?.trim()
        ? parseNativeProjectDocument(JSON.parse(nativeBefore))
        : null;
      let document = initial;
      const snapshots: Record<string, { before: string; after: string }> = {};
      for (const path of paths) {
        const source = await input.readOptionalProjectFile(path);
        if (source == null) throw new Error("A selected clip's composition is unavailable.");
        snapshots[path] = { before: source, after: source };
      }
      const seen = new Set<string>();
      for (const element of input.elements) {
        if (element.structuralRole === "composition-root")
          throw new Error("The composition container cannot be edited as a clip.");
        if (
          element.timelineLocked ||
          element.expandedHostKey ||
          element.expandedParentStart !== undefined ||
          element.parentCompositionId
        )
          throw new Error("Open the composition and unlock selected clips before splitting.");
        const path = element.sourceFile || input.activeCompPath || "index.html";
        const target = buildPatchTarget(element);
        const identity = JSON.stringify([path, target]);
        if (!target || seen.has(identity))
          throw new Error("Split requires unique, unambiguous clip targets.");
        seen.add(identity);
        const resolution = document
          ? resolveNativeClipSelection(document, {
              ...element,
              sourceFile: path,
            })
          : null;
        if (resolution && !resolution.ok && resolution.failure.code !== "clip-not-found")
          throw new Error(resolution.failure.message);
        const clip = resolution?.ok ? resolution.located.clip : null;
        if (action === "delete") {
          const before = snapshots[path]!.after;
          const after = removeElementFromHtml(before, target);
          if (after === before)
            throw new Error("A selected clip is no longer available to delete.");
          snapshots[path]!.after = after;
          if (clip && document) {
            const planned = planNativeTimelineDelete({
              document,
              targets: [{ ...element, sourceFile: path }],
            });
            if (!planned.ok) throw new Error(planned.failure.message);
            document = planned.document;
          }
          continue;
        }
        const seconds = (frame: number) =>
          (frame * document!.frameRate.denominator) / document!.frameRate.numerator;
        const splitTime = document
          ? seconds(projectFrameFromSeconds(input.splitSeconds, document.frameRate))
          : input.splitSeconds;
        const split = splitAuthoredClip(
          snapshots[path]!.after,
          target,
          splitTime,
          crypto.randomUUID(),
          clip
            ? {
                start: seconds(clip.startFrame),
                duration: seconds(clip.durationFrames),
                sourceIn: seconds(clip.sourceInFrame),
                rate: clip.playbackRate
                  ? clip.playbackRate.numerator / clip.playbackRate.denominator
                  : 1,
                still:
                  document!.assets.find((asset) => asset.id === clip.assetId)?.kind === "image",
              }
            : undefined,
        );
        snapshots[path]!.after = split.content;
        if (document && clip) {
          const planned = planNativeTimelineSplits({
            document,
            splits: [
              {
                element: { ...element, sourceFile: path },
                requestedSplitSeconds: splitTime,
                rightBinding: { ...split.binding, sourceFile: path },
              },
            ],
          });
          if (!planned.ok) throw new Error(planned.failure.message);
          document = planned.document;
        }
      }
      if (action === "delete")
        for (const path of paths) {
          snapshots[path]!.after = setCompositionDurationToContent(
            snapshots[path]!.after,
            furthestClipEndFromSource(snapshots[path]!.after),
          );
        }
      if (document && document !== initial) {
        document.revision = initial!.revision + 1;
        snapshots[NATIVE_PROJECT_DOCUMENT_PATH] = {
          before: nativeBefore!,
          after: serializeNativeProjectDocument(document),
        };
      }
      await commitNativeTimelineFileSnapshots({
        orderedPaths: Object.keys(snapshots),
        snapshots,
        history: {
          label: action === "split" ? "Split timeline clips" : "Delete timeline clips",
          kind: "timeline",
        },
        commitFileTransaction: input.commitFileTransaction,
        writeProjectFile: input.writeProjectFile,
        recordEdit: input.recordEdit,
        rollbackFailureMessage: "Clip edit failed and rollback was incomplete",
      });
      return { document, splitCount: input.elements.length };
    },
  );
}
