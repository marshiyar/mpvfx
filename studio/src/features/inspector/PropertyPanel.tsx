import {
  resolveElementKeyframeCacheEntry,
  scopedElementKey,
} from "../animation/GSAP/gsapKeyframeCacheHelpers";
import { memo, useMemo, useRef, useState } from "react";
import { InspectorHeaderActions } from "./InspectorHeaderActions";
import { useStudioShellContext } from "../../app/StudioContext";
import { readStudioBoxSize, readStudioPathOffset, readStudioRotation } from "../canvas/manualEdits";
import {
  buildElementInfoText,
  EMPTY_STYLES,
  parsePxMetricValue,
  readGsapRuntimeValuesForPanel,
  readGsapBorderRadiusForPanel,
  isSelectedElementHidden,
  selectionIdentityKey,
} from "./propertyPanelHelpers";
import { resetDesignWithAnimatedLayout } from "./propertyPanelDesignReset";
import { createTransformCommitHandlers } from "./propertyPanelTransformCommit";
import { resolveAnimIdForProperty } from "../../player/components/TimelinePropertyLanes";
import { resolveEditingSections } from "@hyperframes/core/editing";
import { MediaSection } from "./propertyPanelMediaSection";
import { ColorGradingSection } from "./propertyPanelColorGradingSection";
import { domEditSelectionToFacts } from "../canvas/domEditingLayers";
import { TextSection, StyleSections } from "./propertyPanelSections";
import { GsapAnimationSection } from "../animation/GSAP/GsapAnimationSection";
import { STUDIO_FLAT_INSPECTOR_ENABLED } from "../canvas/manualEditingAvailability";
import { PropertyPanelFlat } from "./PropertyPanelFlat";
import { usePlayerStore } from "../../player/index";
import { useLivePlayheadTime } from "../preview/useLivePlayheadTime";
import { TimingSection } from "./propertyPanelTimingSection";
import { type PropertyPanelProps } from "./propertyPanelHelpers";
import { GestureRecordPanelButton } from "../canvas/GestureRecordControl";
import { PropertyPanelEmptyState } from "./PropertyPanelEmptyState";
import { DesignPanelInputProvider } from "./DesignPanelInputContext";
import { isAudioDomElement } from "../timeline/timelineInspector";
import { projectNativeKeyframeUi } from "../../../shared/project/nativeKeyframeUiProjection";
import { useDomEditActionsContextOptional, useDomEditSelectionContextOptional } from "../canvas/DomEditContext";
import { RemoteInspectorPanel } from "./RemoteInspectorPanel";
import { PropertyPanelClassicLayout } from "./PropertyPanelClassicLayout";

// Re-export helpers that external consumers import from this module
export {
  buildInsetClipPathSides,
  buildStrokeStyleUpdates,
  buildStrokeWidthStyleUpdates,
  getCssFilterFunctionPx,
  getClipPathInsetPx,
  inferBoxShadowPreset,
  inferClipPathPreset,
  normalizePanelPxValue,
  parseInsetClipPathSides,
  setCssFilterFunctionPx,
} from "./propertyPanelHelpers";

// fallow-ignore-next-line complexity
export const PropertyPanel = memo(function PropertyPanel(props: PropertyPanelProps) {
  const remoteSelection = useDomEditSelectionContextOptional()?.remoteSelection ?? null;
  const remoteActions = useDomEditActionsContextOptional();
  const remoteCommit = remoteActions?.nativeDocument ? remoteActions.commitRemoteInspectorEdit : undefined;
  const loadRemoteGsapAnimations = remoteActions?.loadRemoteGsapAnimations;
  const commitRemoteGsapProperty = remoteActions?.commitRemoteGsapProperty;
  const {
    projectId,
    projectDir,
    assets,
    element,
    multiSelectCount = 0,
    multiSelectedElements,
    onGroupSelection,
    onHideAllSelected,
    onClearSelection,
    onUngroup,
    onSetStyle,
    onSetAttribute,
    onSetAttributeLive,
    onApplyColorGradingScope,
    onSetHtmlAttribute,
    onSetManualOffset,
    onSetManualSize,
    onSetManualRotation,
    onSetText,
    onSetTextFieldStyle,
    onAddTextField,
    onRemoveTextField,
    onToggleElementHidden,
    onImportAssets,
    fontAssets = [],
    onImportFonts,
    previewIframeRef,
    gsapAnimations = [],
    nativeKeyframeTarget = false,
    nativeProjectDocument = null,
    gsapMultipleTimelines,
    gsapUnsupportedTimelinePattern,
    onUpdateGsapProperty,
    onUpdateGsapMeta,
    onDeleteGsapAnimation,
    onAddGsapProperty,
    onRemoveGsapProperty,
    onUpdateGsapFromProperty,
    onAddGsapFromProperty,
    onRemoveGsapFromProperty,
    onAddGsapAnimation,
    onSetArcPath,
    onUpdateArcSegment,
    onUnroll,
    onUpdateKeyframeEase,
    onUpdateSegmentEase,
    onSetAllKeyframeEases,
    onAddKeyframe,
    onRemoveKeyframe,
    onConvertToKeyframes,
    onCommitAnimatedProperty,
    onCommitAnimatedProperties,
    onCommitKeyframeProperty,
    onCommitKeyframeProperties,
    onRemoveNativeKeyframe,
    onRemoveNativeKeyframes,
    onSeekToTime,
    recordingState,
    recordingDuration,
    onToggleRecording,
  } = props;
  const styles = element?.computedStyles ?? EMPTY_STYLES;
  const { showToast } = useStudioShellContext();
  const [clipboardCopied, setClipboardCopied] = useState(false);
  const clipboardTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const timelineElements = usePlayerStore((s) => s.elements);
  const selectedElementId = usePlayerStore((s) => s.selectedElementId);
  const selectedElementHidden = isSelectedElementHidden(timelineElements, selectedElementId);
  const visibilityToggleLabel = selectedElementHidden ? "Show element" : "Hide element";
  /**
   * An audio element gets no hide control here.
   *
   * On an audio track "hidden" and "muted" are not similar operations, they are
   * the SAME operation with two names (groups doc §2.1) — which is why the
   * timeline's eye became the mute rather than growing a sibling. A second copy
   * in the panel, still called "Hide element", is precisely the thing that step
   * removed: "Two controls that silence a track, sitting next to each other,
   * differing only in a distinction the author cannot see." An
   * `<hf-audio-group>` has no visual to hide at all, and its mute lives on its
   * own row.
   */
  const audioSelection = isAudioDomElement(element?.element);
  // Live during playback, the store's when paused — see the hook. Shared with the
  // audio FX panel, which follows the playhead for the same reason: a value the
  // timeline drives has to be shown moving, not frozen at what the attribute says.
  const currentTime = useLivePlayheadTime();
  const nativeProjectionResult = useMemo(
    () =>
      nativeProjectDocument && element
        ? projectNativeKeyframeUi(nativeProjectDocument, {
            selectedElement: {
              id: element.id ?? element.element.id ?? null,
              hfId: element.hfId ?? element.element.getAttribute("data-hf-id"),
              sourceFile: element.sourceFile,
              selector: element.selector ?? null,
              selectorIndex: element.selectorIndex ?? null,
              attributes: {
                "data-studio-clip-id": element.element.getAttribute("data-studio-clip-id"),
              },
              dataset: { studioClipId: element.element.dataset.studioClipId ?? null },
            },
            playheadSeconds: currentTime,
          })
        : null,
    [currentTime, element, nativeProjectDocument],
  );
  const nativeProjection = nativeProjectionResult?.ok ? nativeProjectionResult : null;
  const cacheEntry = usePlayerStore((state) =>
    element ? resolveElementKeyframeCacheEntry(state.keyframeCache, element) : undefined,
  );

  const iframeRef = previewIframeRef ?? { current: null };
  const gsapAnimIdForMemo = element
    ? (gsapAnimations?.find((a: { keyframes?: unknown }) => a.keyframes)?.id ??
      gsapAnimations?.[0]?.id ??
      null)
    : null;
  const gsapRuntimeValues = useMemo(
    () =>
      element
        ? readGsapRuntimeValuesForPanel(gsapAnimIdForMemo, gsapAnimations, element, iframeRef)
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- iframeRef is stable; currentTime drives re-reads during playback
    [gsapAnimIdForMemo, gsapAnimations, element, currentTime],
  );
  const gsapBorderRadius = useMemo(
    () =>
      element
        ? readGsapBorderRadiusForPanel(gsapRuntimeValues, gsapAnimations, element, iframeRef)
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gsapRuntimeValues, gsapAnimations, element, currentTime],
  );
  // The 3D Transform panel should be reachable on ANY element, not only ones GSAP is
  // already animating — otherwise you can't add depth/rotation to a fresh static
  // element (the panel never appears, the classic chicken-and-egg). Default to
  // identity when there are no runtime values yet; the first edit creates the
  // gsap.set via commitStaticSet, after which real runtime values flow in.
  const gsap3dValues: Record<string, number> = {
    rotationX: 0, rotationY: 0, rotationZ: 0, z: 0, scale: 1, transformPerspective: 0,
    ...gsapRuntimeValues,
    ...nativeProjection?.currentValues,
  };

  if (!element) {
    if (remoteSelection && (remoteCommit || loadRemoteGsapAnimations)) return <RemoteInspectorPanel selection={remoteSelection}
      commit={remoteCommit} loadGsap={loadRemoteGsapAnimations} commitGsap={commitRemoteGsapProperty} />;
    return (
      <PropertyPanelEmptyState
        flat={STUDIO_FLAT_INSPECTOR_ENABLED}
        multiSelectCount={multiSelectCount}
        multiSelectedElements={multiSelectedElements}
        onGroupSelection={onGroupSelection}
        onHideAllSelected={onHideAllSelected}
        onClearSelection={onClearSelection}
      />
    );
  }

  const manualOffsetEditingDisabled = !element.capabilities.canApplyManualOffset;
  const manualSizeEditingDisabled = !element.capabilities.canApplyManualSize;
  const manualRotationEditingDisabled = !element.capabilities.canApplyManualRotation;
  const sourceLabel = element.id ? `#${element.id}` : (element.selector ?? "");
  // Capabilities are already resolved on the selection; recompute only sections,
  // feeding the live GSAP tween count (arrives on the gsapAnimations prop, not the
  // selection) so the Timing section shows for pure-GSAP elements with no data-start.
  const sections = resolveEditingSections(domEditSelectionToFacts(element, gsapAnimations.length));
  const showEditableSections = element.capabilities.canEditStyles && sections.style;
  const manualOffset = readStudioPathOffset(element.element);
  const manualSize = readStudioBoxSize(element.element);
  const resolvedWidth =
    manualSize.width > 0
      ? manualSize.width
      : (parsePxMetricValue(styles.width ?? "") ?? element.boundingBox.width);
  const resolvedHeight =
    manualSize.height > 0
      ? manualSize.height
      : (parsePxMetricValue(styles.height ?? "") ?? element.boundingBox.height);

  const manualRotation = readStudioRotation(element.element);

  const elStart =
    nativeProjection?.clipStartSeconds ??
    (Number.parseFloat(element?.dataAttributes?.start ?? "0") || 0);
  const elDuration =
    nativeProjection?.clipDurationSeconds ??
    (Number.parseFloat(element?.dataAttributes?.duration ?? "1") || 0);
  const currentPct = elDuration > 0 ? ((currentTime - elStart) / elDuration) * 100 : 0;

  const gsapKfAnim = gsapAnimations?.find((a) => a.keyframes) ?? null;
  const gsapKeyframes = gsapKfAnim?.keyframes?.keyframes ?? null;
  const gsapAnimId = gsapKfAnim?.id ?? gsapAnimations?.[0]?.id ?? null;
  const hasGsapAnimation = !!(gsapAnimId || gsapAnimations.length > 0);
  const hasAnimatedPropertyTarget = nativeKeyframeTarget || hasGsapAnimation;
  const { commitManualOffset, commitManualSize, commitManualRotation } =
    createTransformCommitHandlers({
      element,
      styles,
      hasGsapAnimation: hasAnimatedPropertyTarget,
      gsapAnimId,
      gsapKeyframes,
      currentPct,
      runtimeValues: nativeProjection
        ? {
            ...(gsapRuntimeValues ?? {}),
            x: nativeProjection.currentValues.x ?? manualOffset.x,
            y: nativeProjection.currentValues.y ?? manualOffset.y,
          }
        : (gsapRuntimeValues ?? undefined),
      onCommitAnimatedProperty,
      onAddKeyframe,
      onSetManualOffset,
      onSetManualSize,
      onSetManualRotation,
      showToast,
    });
  const nativeNavigationRows = nativeProjection?.keyframeRows.map((row) => ({
    ...row,
    properties: { ...row.properties },
  }));
  const navKeyframes = nativeNavigationRows ?? cacheEntry?.keyframes ?? gsapKeyframes;
  const seekFromKfPct = (pct: number) => onSeekToTime?.(elStart + (pct / 100) * elDuration);

  const nativeNavigationId = nativeProjection ? `native:${nativeProjection.clipId}` : null;
  const keyframeNavigationId = nativeNavigationId ?? gsapAnimId;
  const animIdForProp = (prop: string): string => {
    const nativeRow = nativeProjection?.keyframeRows.find((row) => prop in row.properties);
    return nativeRow?.animationId ?? nativeNavigationId ??
      resolveAnimIdForProperty(prop, gsapAnimations, gsapAnimId);
  };

  const handleRemoveKeyframe = (animationId: string, percentage: number) => {
    if (nativeProjection && onRemoveNativeKeyframe) {
      const row = nativeProjection.keyframeRows.find(
        (candidate) =>
          candidate.animationId === animationId &&
          Math.abs(candidate.percentage - percentage) < 1e-7,
      );
      if (!row) return;
      void onRemoveNativeKeyframe({
        sequenceId: nativeProjection.sequenceId,
        trackId: nativeProjection.trackId,
        clipId: nativeProjection.clipId,
        parameterId: row.parameterId,
        frame: row.nativeFrame,
      });
      return;
    }
    onRemoveKeyframe?.(animationId, percentage);
  };
  const handleConvertOrAddKeyframe = (property: string, value: number) => {
    if (nativeProjection) {
      void (onCommitKeyframeProperty ?? onCommitAnimatedProperty)?.(element, property, value);
      return;
    }
    onConvertToKeyframes?.(animIdForProp(property));
  };

  const displayX = nativeProjection?.currentValues.x ?? gsapRuntimeValues?.x ?? manualOffset.x;
  const displayY = nativeProjection?.currentValues.y ?? gsapRuntimeValues?.y ?? manualOffset.y;
  const displayW = nativeProjection?.currentValues.width ?? gsapRuntimeValues?.width ?? resolvedWidth;
  const displayH = nativeProjection?.currentValues.height ?? gsapRuntimeValues?.height ?? resolvedHeight;
  const displayR = nativeProjection?.currentValues.rotation ?? gsapRuntimeValues?.rotation ?? manualRotation.angle;
  const resetAllDesign = props.onResetDesign
    ? () =>
        resetDesignWithAnimatedLayout({
          selection: element,
          runtimeValues: gsap3dValues,
          resetDom: props.onResetDesign!,
          resetAnimated: onCommitAnimatedProperties,
        })
    : undefined;

  const handleCopyElementInfo = () => {
    const text = buildElementInfoText(element, sourceLabel, gsapAnimations, previewIframeRef);
    // Claim the copy only once the write actually lands — a denied clipboard
    // permission otherwise reports a copy that never happened.
    navigator.clipboard
      .writeText(text)
      .then(() => {
        showToast(`Copied element details for ${element.label}`, "info");
        setClipboardCopied(true);
        clearTimeout(clipboardTimerRef.current);
        clipboardTimerRef.current = setTimeout(() => setClipboardCopied(false), 1500);
      })
      .catch(() => {
        showToast("Couldn't copy to the clipboard — check browser permissions", "error");
      });
  };

  if (STUDIO_FLAT_INSPECTOR_ENABLED) {
    // Forward the raw props (handlers, ids, assets, recording, fonts, etc.) and
    // the values the legacy path already computed above (so they aren't derived
    // twice). PropertyPanelFlat owns the one-open group state.
    return (
      <PropertyPanelFlat
        {...props}
        onResetDesign={resetAllDesign}
        key={selectionIdentityKey(element)}
        element={element}
        styles={styles}
        sections={sections}
        sourceLabel={sourceLabel}
        gsapBorderRadius={gsapBorderRadius}
        showEditableSections={showEditableSections}
        selectedElementHidden={selectedElementHidden}
        selectedElementId={selectedElementId}
        clipboardCopied={clipboardCopied}
        onCopyElementInfo={handleCopyElementInfo}
        displayX={displayX}
        displayY={displayY}
        displayW={displayW}
        displayH={displayH}
        displayR={displayR}
        manualOffsetEditingDisabled={manualOffsetEditingDisabled}
        manualSizeEditingDisabled={manualSizeEditingDisabled}
        manualRotationEditingDisabled={manualRotationEditingDisabled}
        commitManualOffset={commitManualOffset}
        commitManualSize={commitManualSize}
        commitManualRotation={commitManualRotation}
        gsapAnimId={gsapAnimId}
        keyframeTargetId={keyframeNavigationId}
        navKeyframes={navKeyframes}
        currentTime={currentTime}
        currentFrame={nativeProjection?.clipLocalFrame}
        nativePositionPath={
          nativeProjection?.positionPath && nativeProjection.positionPath.frames.length >= 2
            ? {
                clip: {
                  sequenceId: nativeProjection.sequenceId,
                  trackId: nativeProjection.trackId,
                  clipId: nativeProjection.clipId,
                },
                state: nativeProjection.positionPath,
              }
            : null
        }
        animIdForProp={animIdForProp}
        gsapRuntimeValues={gsap3dValues}
        elStart={elStart}
        elDuration={elDuration}
        onRemoveKeyframe={handleRemoveKeyframe}
        onRemoveKeyframeGroup={nativeProjection && onRemoveNativeKeyframes ? (properties, percentage) => {
          const rows = nativeProjection.keyframeRows.filter(row =>
            row.percentage === percentage && properties.some(property => property in row.properties));
          if (rows.length) void onRemoveNativeKeyframes(rows.map(row => ({
            sequenceId: nativeProjection.sequenceId, trackId: nativeProjection.trackId,
            clipId: nativeProjection.clipId, parameterId: row.parameterId, frame: row.nativeFrame,
          })));
        } : undefined}
      />
    );
  }

  const classicPanel = (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-panel-bg text-panel-text-1">
      <DesignPanelInputProvider section="header">
        <div className="px-4 py-3">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold text-neutral-100">
                {element.label}
              </div>
              <div className="mt-0.5 truncate text-[11px] text-neutral-500">{sourceLabel}</div>
            </div>
            <InspectorHeaderActions
              element={element}
              copied={clipboardCopied}
              onCopy={handleCopyElementInfo}
              onClear={onClearSelection}
              onUngroup={onUngroup}
              selectedElementId={selectedElementId}
              selectedElementHidden={selectedElementHidden}
              visibilityLabel={visibilityToggleLabel}
              onToggleHidden={audioSelection ? undefined : onToggleElementHidden}
            />
          </div>
        </div>
      </DesignPanelInputProvider>
      <div className="flex-1 overflow-y-auto">
        {onToggleRecording && (
          <DesignPanelInputProvider section="footer">
            <GestureRecordPanelButton
              recordingState={recordingState}
              recordingDuration={recordingDuration}
              onToggleRecording={onToggleRecording}
            />
          </DesignPanelInputProvider>
        )}

        <TextSection
          element={element}
          styles={styles}
          fontAssets={fontAssets}
          onImportFonts={onImportFonts}
          onSetText={onSetText}
          onSetTextFieldStyle={onSetTextFieldStyle}
          onAddTextField={onAddTextField}
          onRemoveTextField={onRemoveTextField}
        />

        {sections.timing && (
          // Render whenever there's an authored clip range OR animations to infer
          // one from — a pure-GSAP element with no data-start still gets a Timing
          // range (TimingSection derives it from its tweens).
          <TimingSection
            element={element}
            animations={gsapAnimations}
            onSetAttribute={onSetAttribute}
          />
        )}
        {sections.colorGrading && (
          <ColorGradingSection
            key={selectionIdentityKey(element)}
            projectId={projectId}
            element={element}
            assets={assets}
            previewIframeRef={previewIframeRef}
            onImportAssets={onImportAssets}
            onSetAttributeLive={onSetAttributeLive}
            onApplyScope={onApplyColorGradingScope}
          />
        )}

        {sections.media && (
          <MediaSection
            projectDir={projectDir}
            element={element}
            styles={styles}
            onSetStyle={onSetStyle}
            onSetAttribute={onSetAttribute}
            onSetHtmlAttribute={onSetHtmlAttribute}
          />
        )}

        {sections.layout && <PropertyPanelClassicLayout
          element={element} styles={styles}
          manualOffsetEditingDisabled={manualOffsetEditingDisabled}
          manualSizeEditingDisabled={manualSizeEditingDisabled}
          manualRotationEditingDisabled={manualRotationEditingDisabled}
          displayX={displayX} displayY={displayY} displayW={displayW} displayH={displayH} displayR={displayR}
          commitManualOffset={commitManualOffset} commitManualSize={commitManualSize}
          commitManualRotation={commitManualRotation} keyframeNavigationId={keyframeNavigationId}
          navKeyframes={navKeyframes} currentPct={currentPct} currentFrame={nativeProjection?.clipLocalFrame}
          elDuration={elDuration} elStart={elStart} seekFromKfPct={seekFromKfPct}
          handleRemoveKeyframe={handleRemoveKeyframe} animIdForProp={animIdForProp}
          handleConvertOrAddKeyframe={handleConvertOrAddKeyframe}
          onCommitKeyframeProperty={onCommitKeyframeProperty} onCommitAnimatedProperty={onCommitAnimatedProperty}
          transform3dProps={{
            gsapRuntimeValues: gsap3dValues, gsapAnimId, resolveAnimIdForProp: animIdForProp,
            gsapKeyframes: navKeyframes, currentPct, currentFrame: nativeProjection?.clipLocalFrame,
            elStart, elDuration, element, onCommitAnimatedProperty, onCommitAnimatedProperties,
            onSeekToTime, onRemoveKeyframe, onConvertToKeyframes,
          }} iframeRef={iframeRef} onSetStyle={onSetStyle} />}

        {!nativeKeyframeTarget &&
          onUpdateGsapProperty &&
          onUpdateGsapMeta &&
          onDeleteGsapAnimation &&
          onAddGsapProperty &&
          onAddGsapAnimation && (
            <GsapAnimationSection
              elementId={scopedElementKey(element)}
              animations={gsapAnimations}
              multipleTimelines={gsapMultipleTimelines}
              unsupportedTimelinePattern={gsapUnsupportedTimelinePattern}
              onUpdateProperty={onUpdateGsapProperty}
              onUpdateMeta={onUpdateGsapMeta}
              onDeleteAnimation={onDeleteGsapAnimation}
              onAddProperty={onAddGsapProperty}
              onRemoveProperty={onRemoveGsapProperty ?? (() => {})}
              onUpdateFromProperty={onUpdateGsapFromProperty}
              onAddFromProperty={onAddGsapFromProperty}
              onRemoveFromProperty={onRemoveGsapFromProperty}
              onAddAnimation={onAddGsapAnimation}
              onSetArcPath={onSetArcPath}
              onUpdateArcSegment={onUpdateArcSegment}
              onUnroll={onUnroll}
              onUpdateKeyframeEase={onUpdateKeyframeEase}
              onUpdateSegmentEase={onUpdateSegmentEase}
              onSetAllKeyframeEases={onSetAllKeyframeEases}
            />
          )}

        {showEditableSections && (
          <StyleSections
            projectId={projectId}
            element={element}
            styles={styles}
            assets={assets}
            onSetStyle={onSetStyle}
            onImportAssets={onImportAssets}
            gsapBorderRadius={gsapBorderRadius}
          />
        )}
      </div>
    </div>
  );
  return <DesignPanelInputProvider ui="classic">{classicPanel}</DesignPanelInputProvider>;
});
