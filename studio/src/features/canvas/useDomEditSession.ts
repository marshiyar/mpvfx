import { deleteNativeCanvasSelection } from "./nativeCanvasDelete";
import { useCallback } from "react";
import type { SelectElementOptions, TimelineElement } from "../../player/index";
import type { ImportedFontAsset } from "../inspector/fontAssets";
import type { RightPanelTab } from "../../lib/studioHelpers";
import type { Composition } from "@hyperframes/sdk";
import { sdkCutoverPersist, sdkDeletePersist, type PublishSdkSession } from "../legacy/sdkCutover";
import { runResolverShadow, recordResolverParity } from "../legacy/sdkResolverShadow";
import { useDomSelection } from "./useDomSelection";
import { useRemoteSourceEdits } from "./useRemoteSourceEdits";
import { useDomEditGroupActions } from "./useDomEditGroupActions";
import { useNativeProjectEditActions } from "./useNativeProjectEditActions";
import { usePreviewInteraction } from "../preview/usePreviewInteraction";
import { useDomEditCommits } from "./useDomEditCommits";
import { commitNativeMediaAttributes } from "./nativeMediaAttributes";
import { useGroupCommits } from "./useGroupCommits";
import { useGsapScriptCommits } from "../animation/GSAP/useGsapScriptCommits";
import { useGsapCacheVersion } from "../animation/GSAP/useGsapTweenCache";
import { useDomEditWiring } from "./useDomEditWiring";
import { useGsapAwareEditing } from "../animation/GSAP/useGsapAwareEditing";
import { usePreviewSelectionRefresh } from "../preview/usePreviewSelectionRefresh";
import { useKeyframeEaseCommits } from "../animation/Keyframe/useKeyframeEaseCommits";
import type { DomEditSelection } from "./domEditingTypes";
import { membersForDelete } from "./domEditDeleteMembers";
import type { RecordEditInput } from "./domEditDeleteMembers";
import type { UseProjectAnimatedPropertyCommitOptions } from "../animation/useProjectAnimatedPropertyCommit";

export type { NativePositionPathChange } from "./useNativeProjectEditActions";
// Re-exported: the delete rule lives in its own module now, and callers (and its
// own test) have always imported it from here.
export { membersForDelete };

export interface UseDomEditSessionParams {
  projectId: string | null;
  activeCompPath: string | null;
  compIdToSrc: Map<string, string>;
  captionEditMode: boolean;
  compositionLoading: boolean;
  previewIframeRef: React.MutableRefObject<HTMLIFrameElement | null>;
  timelineElements: TimelineElement[];
  getTimelineSelectionSet: () => ReadonlySet<string>;
  setSelectedTimelineElementId: (id: string | null, options?: SelectElementOptions) => void;
  setTimelineSelectionSet: (ids: Set<string>) => void;
  setRightCollapsed: (collapsed: boolean) => void;
  setRightPanelTab: (tab: RightPanelTab) => void;
  showToast: (message: string, tone?: "error" | "info") => void;
  isRecordingRef?: React.RefObject<boolean>;
  refreshPreviewDocumentVersion: () => void;
  queueDomEditSave: <T>(save: () => Promise<T>) => Promise<T>;
  readProjectFile: (path: string) => Promise<string>;
  writeProjectFile: (path: string, content: string, expectedContent?: string) => Promise<void>;
  updateEditingFileContent: (path: string, content: string) => void;
  domEditSaveTimestampRef: React.MutableRefObject<number>;
  editHistory: { recordEdit: (entry: RecordEditInput) => Promise<void> };
  fileTree: string[];
  importedFontAssetsRef: React.MutableRefObject<ImportedFontAsset[]>;
  projectDir: string | null;
  projectIdRef: React.MutableRefObject<string | null>;
  previewIframe: HTMLIFrameElement | null;
  refreshKey: number;
  previewDocumentVersion: number;
  applyStudioManualEditsToPreviewRef: React.MutableRefObject<
    (iframe: HTMLIFrameElement) => Promise<void>
  >;
  syncPreviewHotkeys: (iframe: HTMLIFrameElement | null) => void;
  reloadPreview: () => void;
  setRefreshKey: React.Dispatch<React.SetStateAction<number>>;
  sdkSession?: Composition | null;
  publishSdkSession?: PublishSdkSession;
  forceReloadSdkSession?: () => void;
  nativeProjectEditing?: Omit<
    UseProjectAnimatedPropertyCommitOptions,
    "legacyCommitProperties"
  >;
}

export function useDomEditSession({
  projectId,
  activeCompPath,
  compIdToSrc,
  captionEditMode,
  compositionLoading,
  previewIframeRef,
  timelineElements,
  getTimelineSelectionSet,
  setSelectedTimelineElementId,
  setTimelineSelectionSet,
  setRightCollapsed,
  setRightPanelTab,
  showToast,
  isRecordingRef,
  refreshPreviewDocumentVersion,
  queueDomEditSave,
  readProjectFile,
  writeProjectFile,
  updateEditingFileContent,
  domEditSaveTimestampRef,
  editHistory,
  fileTree,
  importedFontAssetsRef,
  projectDir,
  projectIdRef,
  previewIframe,
  refreshKey,
  previewDocumentVersion,
  applyStudioManualEditsToPreviewRef,
  syncPreviewHotkeys,
  reloadPreview,
  setRefreshKey: _setRefreshKey,
  sdkSession,
  publishSdkSession,
  forceReloadSdkSession,
  nativeProjectEditing,
}: UseDomEditSessionParams) {
  const isMasterView = !activeCompPath || activeCompPath === "index.html";
  void _setRefreshKey;
  const {
    domEditSelection,
    remoteSelection,
    domEditGroupSelections,
    domEditHoverSelection,
    activeGroupElement,
    domEditSelectionRef,
    domEditGroupSelectionsRef,
    setActiveGroupElement,
    applyDomSelection,
    clearDomSelection,
    buildDomSelectionFromTarget,
    resolveDomSelectionFromPreviewPoint,
    resolveAllDomSelectionsFromPreviewPoint,
    updateDomEditHoverSelection,
    buildDomSelectionForTimelineElement,
    handleTimelineElementSelect,
    refreshDomEditSelectionFromPreview,
    refreshDomEditGroupSelectionsFromPreview,
    applyMarqueeSelection,
  } = useDomSelection({
    projectId,
    activeCompPath,
    isMasterView,
    compIdToSrc,
    captionEditMode,
    previewIframeRef,
    timelineElements,
    getTimelineSelectionSet,
    setSelectedTimelineElementId,
    setTimelineSelectionSet,
    setRightCollapsed,
    setRightPanelTab,
    previewIframe,
    refreshKey,
  });

  usePreviewSelectionRefresh({
    projectId,
    domEditSelectionRef,
    refreshKey,
    previewDocumentVersion,
    refreshDomEditSelectionFromPreview,
  });
  // ── GSAP cache (hoisted so both useGsapScriptCommits and useDomEditWiring share the same instance) ──

  const { version: gsapCacheVersion, bump: bumpGsapCache } = useGsapCacheVersion();

  // ── GSAP script commits ──

  const {
    commitMutation: gsapCommitMutation,
    updateGsapProperty,
    updateGsapMeta,
    deleteGsapAnimation,
    deleteAllForSelector,
    addGsapAnimation,
    addGsapProperty,
    removeGsapProperty,
    updateGsapFromProperty,
    addGsapFromProperty,
    removeGsapFromProperty,
    addKeyframe,
    addKeyframeBatch,
    removeKeyframe,
    removeKeyframes,
    moveKeyframe,
    moveKeyframes,
    resizeKeyframedTween,
    convertToKeyframes,
    removeAllKeyframes,
    removeAllKeyframesBatch,
    setArcPath,
    updateArcSegment,
  } = useGsapScriptCommits({
    projectIdRef,
    activeCompPath,
    previewIframeRef,
    editHistory,
    domEditSaveTimestampRef,
    reloadPreview,
    onCacheInvalidate: bumpGsapCache,
    onFileContentChanged: updateEditingFileContent,
    showToast,
    sdkSession,
    publishSdkSession,
    writeProjectFile,
    forceReloadSdkSession,
  });

  // ── DOM commit handlers ──

  const {
    resolveImportedFontAsset,
    handleDomStyleCommit,
    handleDomStylePreview,
    handleDomDesignReset,
    handleDomAttributeCommit,
    handleDomAttributeLiveCommit,
    handleDomAttributeQuietCommit,
    handleDomHtmlAttributeCommit,
    handleDomAttributesCommit,
    handleDomTextCommit,
    handleDomRichTextCommit,
    handleDomTextFieldStyleCommit,
    handleDomAddTextField,
    handleDomRemoveTextField,
    handleDomBoxSizeCommit,
    handleDomManualEditsReset,
    handleDomEditElementsDelete,
    handleDomZIndexReorderCommit,
  } = useDomEditCommits({
    activeCompPath,
    previewIframeRef,
    showToast,
    queueDomEditSave,
    writeProjectFile,
    domEditSaveTimestampRef,
    editHistory,
    fileTree,
    importedFontAssetsRef,
    projectId,
    projectIdRef,
    reloadPreview,
    domEditSelection,
    applyDomSelection,
    clearDomSelection,
    refreshDomEditSelectionFromPreview,
    buildDomSelectionFromTarget,
    forceReloadSdkSession,
    onTrySdkPersist: sdkSession
      ? (selection, operations, originalContent, targetPath, options) => {
          // Resolver shadow runs regardless of the cutover flag — decoupled tripwire.
          // Pass originalContent so the runtime-node filter can suppress hf-ids
          // absent from source (script-created nodes the SDK can't model), and
          // the paths so cross-file edits (session models only the active comp)
          // skip instead of emitting structural element_not_found noise.
          runResolverShadow(sdkSession, selection.hfId, operations, originalContent, {
            targetPath,
            compositionPath: activeCompPath,
          });
          return sdkCutoverPersist(
            selection,
            operations,
            originalContent,
            targetPath,
            sdkSession,
            {
              editHistory,
              writeProjectFile,
              reloadPreview,
              domEditSaveTimestampRef,
              compositionPath: activeCompPath,
              readProjectFile,
              publishSession: publishSdkSession,
            },
            options,
          );
        }
      : undefined,
    onTryNativeDelete: selections => deleteNativeCanvasSelection(selections, nativeProjectEditing, editHistory.recordEdit),
    onTryNativePersist: (selection, operations, targetPath, options) => commitNativeMediaAttributes(selection, operations, targetPath, nativeProjectEditing, editHistory.recordEdit, options),
    onTrySdkDelete: sdkSession
      ? (hfId, originalContent, targetPath) =>
          sdkDeletePersist(hfId, originalContent, targetPath, sdkSession, {
            editHistory,
            writeProjectFile,
            reloadPreview,
            domEditSaveTimestampRef,
            compositionPath: activeCompPath,
            readProjectFile,
            publishSession: publishSdkSession,
          })
      : undefined,
    // Resolver shadow for the z-index reorder edit: it takes the server path (no
    // SDK persist), but the tripwire is decoupled from cutover — record whether
    // the SDK resolves each reordered element (the reorderElements op's targets).
    onReorderShadow: sdkSession
      ? (targets: string[]) => {
          // Single-flight: every target in one reorder batch shares the same file, so
          // memoize the read instead of firing one fetch per unresolved target.
          let reorderSrcPromise: Promise<string> | undefined;
          const reorderSrc = activeCompPath
            ? () => (reorderSrcPromise ??= readProjectFile(activeCompPath))
            : undefined;
          for (const target of targets)
            void recordResolverParity(sdkSession, target, "reorderElements", reorderSrc);
        }
      : undefined,
  });

  // ── Element groups (wrap selected elements in a data-hf-group div) ──

  const { groupSelection, ungroupSelection } = useGroupCommits({
    activeCompPath,
    showToast,
    writeProjectFile,
    domEditSaveTimestampRef,
    editHistory,
    projectIdRef,
    reloadPreview,
    clearDomSelection,
    forceReloadSdkSession,
  });

  const handleDomEditElementDelete = useCallback(
    async (selection: DomEditSelection, options?: { expandGroup?: boolean }) => {
      // Same structural edit the timeline delete refuses mid-recording, so it
      // refuses here too — this is now the path a Delete press takes whenever
      // the canvas holds a selection.
      if (isRecordingRef?.current) {
        showToast("Cannot edit timeline while recording", "error");
        return;
      }
      const members = membersForDelete(selection, domEditGroupSelectionsRef.current, options);
      await handleDomEditElementsDelete(members);
    },
    [domEditGroupSelectionsRef, handleDomEditElementsDelete, isRecordingRef, showToast],
  );

  const { handleGroupSelection, handleUngroupSelection } = useDomEditGroupActions({
    domEditGroupSelectionsRef, domEditSelectionRef, groupSelection, ungroupSelection,
    setActiveGroupElement, showToast,
  });

  // ── Wiring: selection sync, GSAP cache, preview sync, selection handlers ──

  const {
    selectedGsapAnimations,
    gsapMultipleTimelines,
    gsapUnsupportedTimelinePattern,
    trackGsapInteractionFailure,
    makeFetchFallback,
    handleGsapUpdateProperty,
    handleGsapUpdateMeta,
    handleGsapDeleteAnimation,
    handleGsapDeleteAllForElement,
    handleGsapAddAnimation,
    handleGsapAddProperty,
    handleGsapRemoveProperty,
    handleGsapUpdateFromProperty,
    handleGsapAddFromProperty,
    handleGsapRemoveFromProperty,
    handleGsapAddKeyframe,
    handleGsapAddKeyframeBatch,
    handleGsapRemoveKeyframe,
    handleGsapRemoveKeyframes,
    handleGsapMoveKeyframeToPlayhead,
    handleGsapMoveKeyframe,
    handleGsapMoveKeyframes,
    handleGsapResizeKeyframedTween,
    handleGsapConvertToKeyframes,
    handleGsapRemoveAllKeyframes,
    handleResetSelectedElementKeyframes,
  } = useDomEditWiring({
    // fallow-ignore-next-line code-duplication
    projectId,
    activeCompPath,
    domEditSelection,
    domEditSelectionRef,
    domEditGroupSelectionsRef,
    refreshDomEditGroupSelectionsFromPreview,
    previewIframeRef,
    previewIframe,
    captionEditMode,
    refreshKey,
    gsapCacheVersion,
    bumpGsapCache,
    showToast,
    refreshPreviewDocumentVersion,
    syncPreviewHotkeys,
    applyStudioManualEditsToPreviewRef,
    applyDomSelection,
    buildDomSelectionFromTarget,
    updateGsapProperty,
    updateGsapMeta,
    deleteGsapAnimation,
    deleteAllForSelector,
    addGsapAnimation,
    addGsapProperty,
    removeGsapProperty,
    updateGsapFromProperty,
    addGsapFromProperty,
    removeGsapFromProperty,
    addKeyframe,
    addKeyframeBatch,
    removeKeyframe,
    removeKeyframes,
    moveKeyframe,
    moveKeyframes,
    resizeKeyframedTween,
    convertToKeyframes,
    removeAllKeyframes,
    removeAllKeyframesBatch,
    handleDomManualEditsReset,
  });
  const {
    handlePreviewCanvasMouseDown,
    handlePreviewCanvasPointerMove,
    handlePreviewCanvasPointerLeave,
    handleBlockedDomMove,
    handleDomManualDragStart,
  } = usePreviewInteraction({
    captionEditMode,
    compositionLoading,
    previewIframeRef,
    showToast,
    applyDomSelection,
    resolveDomSelectionFromPreviewPoint,
    resolveAllDomSelectionsFromPreviewPoint,
    updateDomEditHoverSelection,
    setActiveGroupElement,
  });
  const {
    handleGsapAwarePathOffsetCommit,
    handleGsapAwareGroupPathOffsetCommit,
    handleGsapAwareBoxSizeCommit,
    handleGsapAwareRotationCommit,
    commitAnimatedProperty,
    commitAnimatedProperties,
    commitKeyframeProperty,
    commitKeyframeProperties,
    isNativeSelection,
    handleSetArcPath,
    handleUpdateArcSegment,
    handleUnroll,
    commitMutation,
  } = useGsapAwareEditing({
    domEditSelection,
    selectedGsapAnimations,
    gsapCommitMutation,
    previewIframeRef,
    showToast,
    bumpGsapCache,
    makeFetchFallback,
    trackGsapInteractionFailure,
    handleDomBoxSizeCommit,
    addGsapAnimation,
    convertToKeyframes,
    setArcPath,
    updateArcSegment,
    nativeProjectEditing,
  });
  const { handleUpdateSegmentEase, handleUpdateKeyframeEase, handleSetAllKeyframeEases } =
    useKeyframeEaseCommits({ gsapCommitMutation, domEditSelectionRef });
  const { nativeKeyframeCommands, commitNativeProject, setNativePositionPath } =
    useNativeProjectEditActions({ nativeProjectEditing, showToast });
  const { commitRemoteInspectorEdit, commitRemoteStackingPatches,
    loadRemoteGsapAnimations, commitRemoteGsapProperty } = useRemoteSourceEdits({
    projectId, activeCompPath, previewIframeRef, nativeProjectEditing,
    readProjectFile, writeProjectFile, editHistory, domEditSaveTimestampRef,
    reloadPreview, showToast,
  });
  return {
    // State
    domEditSelection,
    remoteSelection,
    domEditGroupSelections,
    domEditHoverSelection,
    activeGroupElement,
    // Refs
    domEditSelectionRef,
    // Callbacks
    handleTimelineElementSelect,
    handlePreviewCanvasMouseDown,
    handlePreviewCanvasPointerMove,
    handlePreviewCanvasPointerLeave,
    applyDomSelection,
    clearDomSelection,
    handleDomStyleCommit,
    handleDomStylePreview,
    handleDomDesignReset,
    handleDomAttributeCommit,
    handleDomAttributeLiveCommit,
    handleDomAttributeQuietCommit,
    handleDomHtmlAttributeCommit,
    handleDomAttributesCommit,
    handleDomPathOffsetCommit: handleGsapAwarePathOffsetCommit,
    handleDomGroupPathOffsetCommit: handleGsapAwareGroupPathOffsetCommit,
    handleDomZIndexReorderCommit,
    handleDomBoxSizeCommit: handleGsapAwareBoxSizeCommit,
    handleDomRotationCommit: handleGsapAwareRotationCommit,
    handleDomManualEditsReset,
    handleDomTextCommit,
    handleDomRichTextCommit,
    handleDomTextFieldStyleCommit,
    handleDomAddTextField,
    handleDomRemoveTextField,
    handleBlockedDomMove,
    handleDomManualDragStart,
    handleDomEditElementDelete,
    handleGroupSelection,
    handleUngroupSelection,
    setActiveGroupElement,
    buildDomSelectionFromTarget,
    buildDomSelectionForTimelineElement,
    updateDomEditHoverSelection,
    applyMarqueeSelection,
    resolveImportedFontAsset,

    // GSAP script editing
    selectedGsapAnimations,
    gsapMultipleTimelines,
    gsapUnsupportedTimelinePattern,
    handleGsapUpdateProperty,
    handleGsapUpdateMeta,
    handleGsapDeleteAnimation,
    handleGsapDeleteAllForElement,
    handleGsapAddAnimation,
    handleGsapAddProperty,
    handleGsapRemoveProperty,
    handleGsapUpdateFromProperty,
    handleGsapAddFromProperty,
    handleGsapRemoveFromProperty,
    handleGsapAddKeyframe,
    handleGsapAddKeyframeBatch,
    handleGsapRemoveKeyframe,
    handleGsapRemoveKeyframes,
    handleGsapMoveKeyframeToPlayhead,
    handleGsapMoveKeyframe,
    handleGsapMoveKeyframes,
    handleGsapResizeKeyframedTween,
    handleGsapConvertToKeyframes,
    handleGsapRemoveAllKeyframes,
    handleResetSelectedElementKeyframes,
    handleUpdateKeyframeEase,
    handleUpdateSegmentEase,
    handleSetAllKeyframeEases,
    commitAnimatedProperty,
    commitAnimatedProperties,
    commitKeyframeProperty,
    commitKeyframeProperties,
    isNativeSelection,
    nativeProjectDocument:
      nativeProjectEditing?.nativeDocument ?? nativeProjectEditing?.nativeBootstrapDocument ?? null,
    deleteNativeKeyframe: nativeKeyframeCommands.deleteKeyframe,
    deleteNativeKeyframes: nativeKeyframeCommands.deleteKeyframes,
    deleteAllNativeKeyframes: nativeKeyframeCommands.deleteAllKeyframes,
    moveNativeKeyframe: nativeKeyframeCommands.moveKeyframe,
    moveNativeKeyframes: nativeKeyframeCommands.moveKeyframes,
    setNativeKeyframeInterpolation: nativeKeyframeCommands.setKeyframeInterpolation,
    setNativeKeyframesInterpolation: nativeKeyframeCommands.setKeyframesInterpolation,
    setNativePositionPath,
    nativeDocument: nativeProjectEditing?.nativeDocument ?? null,
    commitNativeProject,
    commitRemoteInspectorEdit,
    commitRemoteStackingPatches,
    loadRemoteGsapAnimations,
    commitRemoteGsapProperty,
    handleSetArcPath,
    handleUpdateArcSegment,
    handleUnroll,
    invalidateGsapCache: bumpGsapCache,
    previewIframeRef,
    commitMutation,
  };
}
