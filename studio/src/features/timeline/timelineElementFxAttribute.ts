/**
 * C1's clip-level FX write: persist one attribute directly on a specific
 * timeline clip, addressed by the clip itself rather than the current
 * selection — so applying a preset from the timeline FX popover doesn't
 * depend on that clip already being selected in the property panel.
 * Built on `persistElementAttribute` (`timelineEditingHelpers.ts`), the
 * shared core `setAudioGroupAttribute` also uses.
 */

import { useCallback } from "react";
import type { TimelineElement } from "../../player/index";
import {
  buildPatchTarget,
  findTimelineElementInIframe,
  persistElementAttribute,
} from "./timelineEditingHelpers";
import type {
  MutableRef,
  UseTimelineElementVisibilityEditingInput,
} from "./timelineTrackVisibility";
import { resolveNativeClipSelection } from "../../../shared/project/nativePropertyEditPlan";
import { NATIVE_PROJECT_DOCUMENT_PATH, parseNativeProjectDocument, type NativeProjectDocument } from "../../../shared/project/nativeProjectDocument";
import { commitNativeTimelineAudioAttribute } from "../project/nativeTimelineAudioAttributeTransaction";
import { NativeProjectRevisionConflictError } from "../project/nativeProjectPersistence";
import type { NativeTimelineEditingDependencies } from "./useTimelineEditingTypes";

function patchLiveElementAttribute(
  iframe: HTMLIFrameElement | null,
  element: TimelineElement,
  attr: string,
  value: string | null,
  activeCompPath: string | null,
): void {
  const target = findTimelineElementInIframe(iframe, element, activeCompPath);
  if (!target) return;
  if (value === null) target.removeAttribute(attr);
  else target.setAttribute(attr, value);
}

interface SetElementAttributeInput {
  projectId: string;
  activeCompPath: string | null;
  element: TimelineElement;
  attr: string;
  value: string | null;
  label: string;
  previewIframe: HTMLIFrameElement | null;
  writeProjectFile: (path: string, content: string) => Promise<void>;
  recordEdit: Parameters<typeof persistElementAttribute>[0]["recordEdit"];
  domEditSaveTimestampRef: MutableRef<number>;
  pendingTimelineEditPathRef: MutableRef<Set<string>>;
}

async function setElementAttribute({
  projectId,
  activeCompPath,
  element,
  attr,
  value,
  label,
  previewIframe,
  writeProjectFile,
  recordEdit,
  domEditSaveTimestampRef,
  pendingTimelineEditPathRef,
}: SetElementAttributeInput): Promise<string[]> {
  const targetPath = element.sourceFile || activeCompPath || "index.html";
  const patchTarget = buildPatchTarget(element);
  if (!patchTarget) return [];

  return persistElementAttribute({
    projectId,
    targetPath,
    patchTarget,
    attr,
    value,
    label,
    writeProjectFile,
    recordEdit,
    domEditSaveTimestampRef,
    pendingTimelineEditPathRef,
    patchLive: (v) => patchLiveElementAttribute(previewIframe, element, attr, v, activeCompPath),
  });
}

export function useSetElementAttribute({
  projectIdRef,
  activeCompPath,
  showToast,
  writeProjectFile,
  recordEdit,
  domEditSaveTimestampRef,
  previewIframeRef,
  pendingTimelineEditPathRef,
  isRecordingRef,
  nativeProjectEditing,
  nativeDocumentRef,
  editQueueRef,
  reloadPreview,
}: UseTimelineElementVisibilityEditingInput & {
  nativeProjectEditing?: NativeTimelineEditingDependencies;
  nativeDocumentRef?: MutableRef<NativeProjectDocument | null>;
  editQueueRef?: MutableRef<Promise<unknown>>;
  reloadPreview?: () => void;
}): {
  setLive: (element: TimelineElement, attr: string, value: string | null) => void;
  setQuiet: (
    element: TimelineElement,
    attr: string,
    value: string | null,
    label: string,
  ) => Promise<void>;
} {
  const setLive = useCallback(
    (element: TimelineElement, attr: string, value: string | null) => {
      patchLiveElementAttribute(previewIframeRef.current, element, attr, value, activeCompPath);
    },
    [previewIframeRef, activeCompPath],
  );
  const setQuiet = useCallback(
    async (element: TimelineElement, attr: string, value: string | null, label: string) => {
      if (isRecordingRef?.current) {
        showToast("Cannot edit timeline while recording", "error");
        return;
      }
      const pid = projectIdRef.current;
      if (!pid) return;
      const native = nativeDocumentRef?.current;
      const selection = {
        id: element.id, hfId: element.hfId, sourceFile: element.sourceFile,
        selector: element.selector, selectorIndex: element.selectorIndex,
      };
      const resolution = native ? resolveNativeClipSelection(native, selection) : null;
      const clip = resolution?.ok ? resolution.located.clip : null;
      const asset = clip ? native?.assets.find(candidate => candidate.id === clip.assetId) : null;
      const supported = ["muted", "data-volume", "data-fx-chain", "data-automation"];
      if (native && clip && (asset?.kind === "video" || asset?.kind === "audio") &&
          clip.binding?.sourceFile && supported.includes(attr) && nativeProjectEditing && editQueueRef) {
        const sourceFile = clip.binding.sourceFile;
        const previous = attr === "muted" ? (clip.muted ? "" : null)
          : attr === "data-volume" ? (clip.staticParameters?.["audio.volume"] == null ? null : String(clip.staticParameters["audio.volume"]))
          : attr === "data-fx-chain" ? clip.audioFxChain ?? null
          : clip.audioAutomation ?? null;
        const operation = editQueueRef.current.then(async () => {
          const commitAgainst = (document: NativeProjectDocument) => commitNativeTimelineAudioAttribute({
            expectedRevision: document.revision,
            target: { kind: "clip", selection, sourceFile }, attr, value, label,
            readOptionalProjectFile: nativeProjectEditing.readOptionalProjectFile,
            writeProjectFile, recordEdit,
            commitFileTransaction: nativeProjectEditing.commitFileTransaction,
            onCommitted: next => {
              nativeDocumentRef.current = next;
              nativeProjectEditing.onNativeDocumentCommitted(next);
            },
          });
          try { await commitAgainst(nativeDocumentRef.current ?? native); }
          catch (error) {
            if (!(error instanceof NativeProjectRevisionConflictError)) throw error;
            const content = await nativeProjectEditing.readOptionalProjectFile(NATIVE_PROJECT_DOCUMENT_PATH);
            if (!content) throw error;
            const latest = parseNativeProjectDocument(JSON.parse(content));
            nativeDocumentRef.current = latest;
            await commitAgainst(latest);
          }
        });
        editQueueRef.current = operation.catch(() => undefined);
        try {
          await operation;
          domEditSaveTimestampRef.current = Date.now();
          pendingTimelineEditPathRef.current.add(sourceFile);
          pendingTimelineEditPathRef.current.add(NATIVE_PROJECT_DOCUMENT_PATH);
          reloadPreview?.();
        } catch (error) {
          patchLiveElementAttribute(previewIframeRef.current, element, attr, previous, activeCompPath);
          showToast(error instanceof Error ? error.message : "Failed to update native audio", "error");
        }
        return;
      }
      try {
        await setElementAttribute({
          projectId: pid,
          activeCompPath,
          element,
          attr,
          value,
          label,
          previewIframe: previewIframeRef.current,
          writeProjectFile,
          recordEdit,
          domEditSaveTimestampRef,
          pendingTimelineEditPathRef,
        });
      } catch (error) {
        console.error("[Timeline] Failed to set element attribute", error);
        const message = error instanceof Error ? error.message : "Failed to update effect";
        showToast(message);
      }
    },
    [
      activeCompPath,
      previewIframeRef,
      writeProjectFile,
      recordEdit,
      domEditSaveTimestampRef,
      pendingTimelineEditPathRef,
      isRecordingRef,
      showToast,
      projectIdRef,
      nativeProjectEditing,
      nativeDocumentRef,
      editQueueRef,
      reloadPreview,
    ],
  );
  return { setLive, setQuiet };
}
