import { useCallback, type MutableRefObject } from "react";
import type { TimelineElement } from "../../player/index";
import { resolveMediaPreviewUrl } from "../../player/components/thumbnailUtils";
import { probeMediaUrl } from "../../player/lib/mediaProbe";
import { resolveNativeClipSelection } from "../../../shared/project/nativePropertyEditPlan";
import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  parseNativeProjectDocument,
  type NativeProjectDocument,
} from "../../../shared/project/nativeProjectDocument";
import { commitNativeTimelineAudio } from "../project/nativeTimelineAudioTransaction";
import { NativeProjectRevisionConflictError } from "../project/nativeProjectPersistence";
import type { NativeTimelineEditingDependencies, UseTimelineEditingOptions } from "./useTimelineEditingTypes";

interface NativeAudioActionOptions {
  projectIdRef: MutableRefObject<string | null>;
  nativeProjectEditing?: NativeTimelineEditingDependencies;
  nativeDocumentRef: MutableRefObject<NativeProjectDocument | null>;
  editQueueRef: MutableRefObject<Promise<unknown>>;
  writeProjectFile: UseTimelineEditingOptions["writeProjectFile"];
  recordEdit: UseTimelineEditingOptions["recordEdit"];
  showToast: UseTimelineEditingOptions["showToast"];
  domEditSaveTimestampRef: UseTimelineEditingOptions["domEditSaveTimestampRef"];
  pendingTimelineEditPathRef: UseTimelineEditingOptions["pendingTimelineEditPathRef"];
  reloadPreview: UseTimelineEditingOptions["reloadPreview"];
  forceReloadSdkSession?: UseTimelineEditingOptions["forceReloadSdkSession"];
  isRecordingRef?: UseTimelineEditingOptions["isRecordingRef"];
}

/** Save the native clip and its HTML mirror in the timeline's ordered edit queue. */
export function useNativeAudioActions(options: NativeAudioActionOptions) {
  const handleNativeAudioAction = useCallback(async (
    element: TimelineElement,
    action: "detach" | "reattach",
  ): Promise<void> => {
    const {
      projectIdRef, nativeProjectEditing, nativeDocumentRef, editQueueRef,
      writeProjectFile, recordEdit, showToast, domEditSaveTimestampRef,
      pendingTimelineEditPathRef, reloadPreview, forceReloadSdkSession, isRecordingRef,
    } = options;
    if (isRecordingRef?.current) {
      showToast("Cannot edit timeline while recording", "error");
      return;
    }
    const projectId = projectIdRef.current;
    if (!projectId || !nativeProjectEditing || !nativeDocumentRef.current) {
      showToast("Save this timeline as a native project before editing video audio", "error");
      return;
    }
    let hasAudioStream: boolean | undefined;
    if (action === "detach") {
      if (!element.src) {
        showToast("The video source is unavailable for audio inspection", "error");
        return;
      }
      const url = resolveMediaPreviewUrl(element.src, projectId, window.location.href);
      const result = await probeMediaUrl(url);
      if (!result?.hasAudio) {
        showToast(result ? "This video has no audio stream" : "Could not verify this video's audio stream", "error");
        return;
      }
      hasAudioStream = true;
    }
    const operation = editQueueRef.current.then(async () => {
      const commitAgainst = async (document: NativeProjectDocument) => {
        const resolution = resolveNativeClipSelection(document, {
          id: element.id, hfId: element.hfId, sourceFile: element.sourceFile,
          selector: element.selector, selectorIndex: element.selectorIndex,
        });
        if (!resolution.ok) throw new Error("The selected native clip is no longer available");
        const clip = resolution.located.clip;
        const asset = document.assets.find(candidate => candidate.id === clip.assetId);
        if (action === "detach" && asset?.kind !== "video") throw new Error("Select a video clip to detach audio");
        if (action === "reattach" && (asset?.kind !== "audio" || !clip.audioDetachedFrom)) {
          throw new Error("Select a detached audio clip to reattach");
        }
        const sourceFile = clip.binding?.sourceFile;
        const committed = await commitNativeTimelineAudio({
          expectedRevision: document.revision,
          action, clipId: clip.id, hasAudioStream,
          readOptionalProjectFile: nativeProjectEditing.readOptionalProjectFile,
          writeProjectFile, recordEdit,
          commitFileTransaction: nativeProjectEditing.commitFileTransaction,
          onCommitted: next => {
            nativeDocumentRef.current = next;
            nativeProjectEditing.onNativeDocumentCommitted(next);
          },
        });
        if (sourceFile) pendingTimelineEditPathRef.current.add(sourceFile);
        pendingTimelineEditPathRef.current.add(NATIVE_PROJECT_DOCUMENT_PATH);
        domEditSaveTimestampRef.current = Date.now();
        reloadPreview();
        forceReloadSdkSession?.();
        return committed;
      };
      try {
        await commitAgainst(nativeDocumentRef.current!);
      } catch (error) {
        if (!(error instanceof NativeProjectRevisionConflictError)) throw error;
        const latestContent = await nativeProjectEditing.readOptionalProjectFile(NATIVE_PROJECT_DOCUMENT_PATH);
        if (!latestContent) throw error;
        const latest = parseNativeProjectDocument(JSON.parse(latestContent));
        nativeDocumentRef.current = latest;
        await commitAgainst(latest);
      }
    });
    editQueueRef.current = operation.catch(() => undefined);
    try {
      await operation;
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Video audio edit failed", "error");
    }
  }, [options]);
  return { handleNativeAudioAction };
}
