// Asset-drop handlers for the timeline: drop an existing project asset at a
// placement, or upload dragged-in OS files and place them sequentially.
// Extracted verbatim from useTimelineEditing.ts to keep it under the studio
// 600-line cap.
import { useCallback, type MutableRefObject, type RefObject } from "react";
import type { TimelineElement } from "../player";
import type { NativeProjectDocument } from "../project/nativeProjectDocument";
import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  parseNativeProjectDocument,
} from "../project/nativeProjectDocument";
import { NativeProjectRevisionConflictError } from "../project/nativeProjectPersistence";
import {
  commitNativeTimelineAssetInsertions,
  type NativeTimelineAssetInsertRequest,
} from "../project/nativeTimelineAssetInsertTransaction";
import {
  assertTimelineAssetTargetSource,
  buildTimelineAssetId,
  buildTimelineAssetInsertHtml,
  buildTimelineFileDropPlacements,
  ensureTimelineAssetTargetSource,
  extendCompositionDurationIfNeeded,
  fitTimelineAssetGeometry,
  getTimelineAssetKind,
  insertTimelineAssetIntoSource,
  quantizeTimelineAssetDuration,
  resolveTimelineAssetCompositionSize,
  resolveTimelineAssetSrc,
} from "../utils/timelineAssetDrop";
import { generateId } from "../utils/generateId";
import { saveProjectFilesWithHistory, type RecordEditInput } from "../utils/studioFileHistory";
import { collectHtmlIds, resolveDroppedAssetDuration } from "../utils/studioHelpers";
import { formatTimelineAttributeNumber } from "./timelineEditingHelpers";
import { readFileContent } from "./timelineTimingSync";
import { commitTimelineCompositionInsertion } from "../utils/timelineCompositionInsert";
import { usePlayerStore } from "../player";
import type { NativeTimelineEditingDependencies } from "./useTimelineEditingTypes";
import { computeStackingPatches } from "../player/components/timelineStackingSync";
import { applyPatchByTarget } from "../utils/sourcePatcher";

interface UseTimelineAssetDropOpsOptions {
  projectIdRef: MutableRefObject<string | null>;
  activeCompPath: string | null;
  timelineElements: TimelineElement[];
  showToast: (message: string, tone?: "error" | "info") => void;
  writeProjectFile: (path: string, content: string, expectedContent?: string) => Promise<void>;
  recordEdit: (input: RecordEditInput) => Promise<void>;
  domEditSaveTimestampRef: MutableRefObject<number>;
  reloadPreview: () => void;
  uploadProjectFiles: (files: Iterable<File>, dir?: string) => Promise<string[]>;
  isRecordingRef?: RefObject<boolean>;
  forceReloadSdkSession?: () => void;
  observeProjectFileVersion?: (path: string, version: string | null) => void;
  nativeProjectEditing?: NativeTimelineEditingDependencies;
  nativeDocumentRef?: MutableRefObject<NativeProjectDocument | null>;
  editQueueRef?: MutableRefObject<Promise<void>>;
}

interface PreparedTimelineAsset {
  readonly assetPath: string;
  readonly kind: "video" | "audio" | "image";
  readonly start: number;
  readonly duration: number;
  readonly track: number;
}

interface TimelineAssetStackingInput {
  readonly key: string;
  readonly kind: "video" | "audio" | "image";
  readonly start: number;
  readonly duration: number;
  readonly track: number;
  readonly sourceFile: string;
}

/**
 * Imported root clips obey the same invariant as a deliberate vertical drag:
 * lower track number = higher row = higher canvas stacking order. Imports are
 * prepended inside the composition root, so their DOM index is before every
 * existing clip; the shared resolver accounts for that tie-break and only
 * changes an existing z-index when the z=0 floor makes it unavoidable.
 */
function resolveTimelineAssetStacking(
  content: string,
  timelineElements: readonly TimelineElement[],
  input: TimelineAssetStackingInput,
): { content: string; zIndex: number } {
  if (input.kind === "audio") return { content, zIndex: 0 };

  const sourceElements = timelineElements.filter(
    (element) =>
      (element.sourceFile ?? input.sourceFile) === input.sourceFile &&
      element.expandedParentStart == null,
  );
  const rootStackingContext =
    sourceElements.find((element) => element.kind !== "audio" && element.tag !== "audio")
      ?.stackingContextId ?? null;
  const imported = {
    key: input.key,
    start: input.start,
    duration: input.duration,
    track: input.track,
    zIndex: 0,
    isAudio: false,
    sourceFile: input.sourceFile,
    stackingContextId: rootStackingContext,
    // insertTimelineAssetIntoSource prepends the clip inside the root.
    domIndex: -1,
  };
  const stackingElements = sourceElements.map((element, domIndex) => ({
    key: element.key ?? element.id,
    start: element.start,
    duration: element.duration,
    track: element.track,
    zIndex: element.zIndex ?? 0,
    isAudio: element.kind === "audio" || element.tag === "audio",
    sourceFile: element.sourceFile ?? input.sourceFile,
    stackingContextId: element.stackingContextId ?? null,
    domIndex,
  }));
  const patches = computeStackingPatches([...stackingElements, imported], [input.key]);
  let patchedContent = content;
  let importedZIndex = imported.zIndex;

  for (const patch of patches) {
    if (patch.key === input.key) {
      importedZIndex = patch.zIndex;
      continue;
    }
    const element = sourceElements.find((candidate) => (candidate.key ?? candidate.id) === patch.key);
    if (!element) continue;
    patchedContent = applyPatchByTarget(
      patchedContent,
      {
        id: element.domId ?? element.id,
        hfId: element.hfId,
        selector: element.selector,
        selectorIndex: element.selectorIndex,
      },
      { type: "inline-style", property: "z-index", value: String(patch.zIndex) },
    );
  }

  return { content: patchedContent, zIndex: importedZIndex };
}

export function useTimelineAssetDropOps({
  projectIdRef,
  activeCompPath,
  timelineElements,
  showToast,
  writeProjectFile,
  recordEdit,
  domEditSaveTimestampRef,
  reloadPreview,
  uploadProjectFiles,
  isRecordingRef,
  forceReloadSdkSession,
  observeProjectFileVersion,
  nativeProjectEditing,
  nativeDocumentRef,
  editQueueRef,
}: UseTimelineAssetDropOpsOptions) {
  const commitNativeAssets = useCallback(
    async (assets: readonly PreparedTimelineAsset[], targetPath: string): Promise<void> => {
      const dependencies = nativeProjectEditing;
      const documentRef = nativeDocumentRef;
      if (!dependencies || !documentRef?.current) {
        throw new Error("The authoritative native project is no longer available");
      }
      const generatedHfIds = assets.map(() => `hf-${generateId()}`);
      const insertions: NativeTimelineAssetInsertRequest[] = assets.map((asset) => ({
        assetPath: asset.assetPath,
        assetName: asset.assetPath.split(/[\\/]/).at(-1),
        kind: asset.kind,
        sourceFile: targetPath,
        requestedStartSeconds: asset.start,
        requestedDurationSeconds: asset.duration,
        sourceDurationSeconds: asset.duration,
        requestedTrack: asset.track,
      }));
      const run = async (): Promise<void> => {
        const current = documentRef.current;
        if (!current) {
          throw new Error("The authoritative native project is no longer available");
        }
        const commitAgainst = (expectedRevision: number) =>
          commitNativeTimelineAssetInsertions({
            expectedRevision,
            insertions,
            readOptionalProjectFile: dependencies.readOptionalProjectFile,
            writeProjectFile,
            recordEdit,
            commitFileTransaction: dependencies.commitFileTransaction,
            patchCompatibilityContent: (content, insertion) => {
              const editableContent = ensureTimelineAssetTargetSource(content);
              const newId = buildTimelineAssetId(
                insertion.assetPath,
                collectHtmlIds(editableContent),
              );
              const hfId = generatedHfIds[insertion.insertionIndex]!;
              const resolvedAssetSrc = resolveTimelineAssetSrc(
                insertion.sourceFile,
                insertion.assetPath,
              );
              const stacking = resolveTimelineAssetStacking(editableContent, timelineElements, {
                key: hfId,
                kind: insertion.kind,
                start: insertion.compatibilityStartSeconds,
                duration: insertion.compatibilityDurationSeconds,
                track: insertion.requestedTrack,
                sourceFile: insertion.sourceFile,
              });
              const insertedContent = insertTimelineAssetIntoSource(
                stacking.content,
                buildTimelineAssetInsertHtml({
                  id: newId,
                  hfId,
                  assetPath: resolvedAssetSrc,
                  kind: insertion.kind,
                  start: insertion.compatibilityStartSeconds,
                  duration: insertion.compatibilityDurationSeconds,
                  track: insertion.requestedTrack,
                  zIndex: stacking.zIndex,
                  geometry: fitTimelineAssetGeometry(
                    null,
                    resolveTimelineAssetCompositionSize(editableContent),
                  ),
                }),
              );
              return {
                content: extendCompositionDurationIfNeeded(
                  insertedContent,
                  insertion.compatibilityStartSeconds +
                    insertion.compatibilityDurationSeconds,
                ),
                binding: {
                  sourceFile: insertion.sourceFile,
                  domId: newId,
                  hfId,
                },
              };
            },
            onCommitted: (document) => {
              documentRef.current = document;
              dependencies.onNativeDocumentCommitted(document);
            },
          });

        let result;
        try {
          result = await commitAgainst(current.revision);
        } catch (error) {
          if (!(error instanceof NativeProjectRevisionConflictError)) throw error;
          const latestContent = await dependencies.readOptionalProjectFile(
            NATIVE_PROJECT_DOCUMENT_PATH,
          );
          if (!latestContent?.trim()) throw error;
          const latest = parseNativeProjectDocument(JSON.parse(latestContent));
          if (latest.id !== current.id) throw error;
          documentRef.current = latest;
          result = await commitAgainst(latest.revision);
        }
        if (!result.committed) {
          if (result.reason === "incompatible-lane") {
            const requestedTrack = assets[0]?.track;
            throw new Error(
              requestedTrack === undefined
                ? "Cannot add media because the target track contains a different media type."
                : `Cannot add media to track ${requestedTrack} because that track contains a different media type.`,
            );
          }
          throw new Error(`Native timeline asset insertion was not committed: ${result.reason}`);
        }
        domEditSaveTimestampRef.current = Date.now();
        forceReloadSdkSession?.();
        reloadPreview();
      };

      if (!editQueueRef) {
        await run();
        return;
      }
      const operation = editQueueRef.current.then(run);
      editQueueRef.current = operation.catch((error) => {
        console.error("[Timeline] Failed to persist native media insertion", error);
      });
      await operation;
    },
    [
      domEditSaveTimestampRef,
      editQueueRef,
      forceReloadSdkSession,
      nativeDocumentRef,
      nativeProjectEditing,
      recordEdit,
      reloadPreview,
      timelineElements.length,
      writeProjectFile,
    ],
  );

  // fallow-ignore-next-line complexity
  const handleTimelineAssetDrop = useCallback(
    // fallow-ignore-next-line complexity
    async (
      assetPath: string,
      placement: Pick<TimelineElement, "start" | "track">,
      durationOverride?: number,
    ) => {
      if (isRecordingRef?.current) {
        showToast("Cannot edit timeline while recording", "error");
        return;
      }
      const pid = projectIdRef.current;
      if (!pid) throw new Error("No active project");

      const kind = getTimelineAssetKind(assetPath);
      if (!kind) {
        showToast("Only image, video, and audio assets can be dropped onto the timeline.");
        return;
      }

      const targetPath = activeCompPath || "index.html";
      try {
        const duration =
          Number.isFinite(durationOverride) && durationOverride != null && durationOverride > 0
            ? durationOverride
            : await resolveDroppedAssetDuration(pid, assetPath, kind);
        if (nativeProjectEditing && nativeDocumentRef?.current) {
          await commitNativeAssets(
            [{
              assetPath,
              kind,
              start: placement.start,
              duration,
              track: placement.track,
            }],
            targetPath,
          );
          return;
        }

        const frameRate = usePlayerStore.getState().timelineFrameRate ?? undefined;
        const normalizedStart = frameRate
          ? buildTimelineFileDropPlacements(placement, [duration], frameRate)[0]!.start
          : Number(formatTimelineAttributeNumber(placement.start));
        const normalizedDuration = frameRate
          ? quantizeTimelineAssetDuration(duration, frameRate)
          : Number(formatTimelineAttributeNumber(duration));
        const originalContent = await readFileContent(pid, targetPath);
        const editableContent = ensureTimelineAssetTargetSource(originalContent);
        const newId = buildTimelineAssetId(assetPath, collectHtmlIds(editableContent));
        const resolvedAssetSrc = resolveTimelineAssetSrc(targetPath, assetPath);

        const resolvedTargetPath = targetPath || "index.html";
        const relevantElements = timelineElements.filter(
          (te) => (te.sourceFile || activeCompPath || "index.html") === resolvedTargetPath,
        );
        const hfId = `hf-${generateId()}`;
        const stacking = resolveTimelineAssetStacking(editableContent, relevantElements, {
          key: hfId,
          kind,
          start: normalizedStart,
          duration: normalizedDuration,
          track: placement.track,
          sourceFile: resolvedTargetPath,
        });

        const insertedContent = insertTimelineAssetIntoSource(
          stacking.content,
          buildTimelineAssetInsertHtml({
            id: newId,
            hfId,
            assetPath: resolvedAssetSrc,
            kind,
            start: normalizedStart,
            duration: normalizedDuration,
            track: placement.track,
            zIndex: stacking.zIndex,
            geometry: fitTimelineAssetGeometry(
              null,
              resolveTimelineAssetCompositionSize(editableContent),
            ),
          }),
        );
        const patchedContent = extendCompositionDurationIfNeeded(
          insertedContent,
          normalizedStart + normalizedDuration,
        );

        domEditSaveTimestampRef.current = Date.now();
        await saveProjectFilesWithHistory({
          projectId: pid,
          label: "Add timeline asset",
          kind: "timeline",
          files: { [targetPath]: patchedContent },
          // A recoverable missing container is structural repair, not part of
          // the media edit. Undo removes the new clip while keeping the editor
          // valid; optimistic concurrency still compares against disk's
          // pre-repair bytes.
          readFile: async () => editableContent,
          diskContent: { [targetPath]: originalContent },
          writeFile: writeProjectFile,
          recordEdit,
        });

        forceReloadSdkSession?.();
        reloadPreview();
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to drop asset onto timeline";
        showToast(message, "error");
      }
    },
    [
      projectIdRef,
      activeCompPath,
      recordEdit,
      showToast,
      timelineElements,
      writeProjectFile,
      domEditSaveTimestampRef,
      reloadPreview,
      isRecordingRef,
      forceReloadSdkSession,
      nativeProjectEditing,
      nativeDocumentRef,
      commitNativeAssets,
    ],
  );

  // fallow-ignore-next-line complexity
  const handleTimelineFileDrop = useCallback(
    // fallow-ignore-next-line complexity
    async (files: File[], placement?: Pick<TimelineElement, "start" | "track">) => {
      if (isRecordingRef?.current) {
        showToast("Cannot edit timeline while recording", "error");
        return;
      }
      const pid = projectIdRef.current;
      if (!pid) return;
      const targetPath = activeCompPath || "index.html";
      try {
        assertTimelineAssetTargetSource(await readFileContent(pid, targetPath));
      } catch (error) {
        showToast(
          error instanceof Error ? error.message : "This composition can't accept media.",
          "error",
        );
        return;
      }
      const uploaded = await uploadProjectFiles(files);
      if (uploaded.length === 0) return;
      const durations: number[] = [];
      for (const assetPath of uploaded) {
        const kind = getTimelineAssetKind(assetPath);
        const duration = kind ? await resolveDroppedAssetDuration(pid, assetPath, kind) : 0;
        durations.push(duration);
      }
      const nativeDropActive = Boolean(nativeProjectEditing && nativeDocumentRef?.current);
      const basePlacement = placement ?? { start: 0, track: 0 };
      const frameRate = nativeDropActive
        ? nativeDocumentRef?.current?.frameRate
        : usePlayerStore.getState().timelineFrameRate ?? undefined;
      const placements = buildTimelineFileDropPlacements(basePlacement, durations, frameRate);
      if (nativeDropActive) {
        const prepared: PreparedTimelineAsset[] = [];
        for (const [index, assetPath] of uploaded.entries()) {
          const kind = getTimelineAssetKind(assetPath);
          if (!kind) {
            showToast("Only image, video, and audio assets can be dropped onto the timeline.");
            return;
          }
          const nextPlacement = placements[index] ?? placements[0];
          if (!nextPlacement) return;
          prepared.push({
            assetPath,
            kind,
            start: nextPlacement.start,
            duration: durations[index]!,
            track: nextPlacement.track,
          });
        }
        try {
          await commitNativeAssets(prepared, targetPath);
        } catch (error) {
          showToast(
            error instanceof Error ? error.message : "Failed to drop media onto timeline",
            "error",
          );
        }
        return;
      }
      for (const [index, assetPath] of uploaded.entries()) {
        await handleTimelineAssetDrop(
          assetPath,
          placements[index] ?? placements[0],
          durations[index],
        );
      }
    },
    [
      activeCompPath,
      handleTimelineAssetDrop,
      projectIdRef,
      uploadProjectFiles,
      isRecordingRef,
      showToast,
      nativeProjectEditing,
      nativeDocumentRef,
      commitNativeAssets,
    ],
  );

  const handleTimelineCompositionDrop = useCallback(
    async (sourcePath: string, placement: Pick<TimelineElement, "start" | "track">) => {
      if (isRecordingRef?.current) {
        showToast("Cannot edit timeline while recording", "error");
        return;
      }
      const pid = projectIdRef.current;
      if (!pid) throw new Error("No active project");
      const targetPath = activeCompPath || "index.html";
      try {
        await commitTimelineCompositionInsertion({
          projectId: pid,
          targetPath,
          sourcePath,
          start: placement.start,
          track: placement.track,
          writeFile: writeProjectFile,
          recordEdit,
          observeVersion: observeProjectFileVersion,
          selectHost: (key) => usePlayerStore.getState().setSelectedElementId(key),
          resync: forceReloadSdkSession,
          refresh: reloadPreview,
        });
        domEditSaveTimestampRef.current = Date.now();
        showToast("Composition added to the timeline.", "info");
      } catch (error) {
        showToast(
          error instanceof Error ? error.message : "Failed to add composition to timeline",
          "error",
        );
      }
    },
    [
      activeCompPath,
      domEditSaveTimestampRef,
      forceReloadSdkSession,
      isRecordingRef,
      observeProjectFileVersion,
      projectIdRef,
      recordEdit,
      reloadPreview,
      showToast,
      writeProjectFile,
    ],
  );

  return { handleTimelineAssetDrop, handleTimelineFileDrop, handleTimelineCompositionDrop };
}
