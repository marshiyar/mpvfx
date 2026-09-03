import type { resolveEditingSections } from "@hyperframes/core/editing";
import type { DomEditSelection } from "./domEditing";
import type { PropertyPanelProps } from "./propertyPanelHelpers";
import type { FlatLayoutSection } from "./propertyPanelFlatLayoutSection";

export type PropertyPanelFlatProps = Pick<
  PropertyPanelProps,
  | "projectId"
  | "projectDir"
  | "assets"
  | "previewIframeRef"
  | "onClearSelection"
  | "onUngroup"
  | "onSetStyle"
  | "onResetDesign"
  | "onPreviewStyle"
  | "onSetAttribute"
  | "onSetAttributes"
  | "onSetAttributeLive"
  | "onPreviewAttributeLive"
  | "onSetAttributeQuiet"
  | "onApplyColorGradingScope"
  | "onSetHtmlAttribute"
  | "onRemoveBackground"
  | "onSetText"
  | "onSetTextFieldStyle"
  | "onPreviewTextFieldStyle"
  | "onAddTextField"
  | "onRemoveTextField"
  | "onToggleElementHidden"
  | "onAutoGroupCarveSources"
  | "onImportAssets"
  | "onAddMediaOverlay"
  | "onImportFonts"
  | "fontAssets"
  | "gsapAnimations"
  | "nativeKeyframeTarget"
  | "onSetNativeKeyframesInterpolation"
  | "gsapMultipleTimelines"
  | "gsapUnsupportedTimelinePattern"
  | "onUpdateGsapProperty"
  | "onUpdateGsapMeta"
  | "onDeleteGsapAnimation"
  | "onAddGsapProperty"
  | "onRemoveGsapProperty"
  | "onUpdateGsapFromProperty"
  | "onAddGsapFromProperty"
  | "onRemoveGsapFromProperty"
  | "onAddGsapAnimation"
  | "onSetArcPath"
  | "onUpdateArcSegment"
  | "onUnroll"
  | "onUpdateKeyframeEase"
  | "onSetAllKeyframeEases"
  | "onUpdateSegmentEase"
  | "recordingState"
  | "recordingDuration"
  | "onToggleRecording"
> &
  Pick<
    Parameters<typeof FlatLayoutSection>[0],
    | "displayX"
    | "displayY"
    | "displayW"
    | "displayH"
    | "displayR"
    | "manualOffsetEditingDisabled"
    | "manualSizeEditingDisabled"
    | "manualRotationEditingDisabled"
    | "commitManualOffset"
    | "commitManualSize"
    | "commitManualRotation"
    | "gsapAnimId"
    | "keyframeTargetId"
    | "navKeyframes"
    | "currentFrame"
    | "animIdForProp"
    | "gsapRuntimeValues"
    | "elStart"
    | "elDuration"
    | "onCommitAnimatedProperty"
    | "onCommitAnimatedProperties"
    | "onCommitKeyframeProperty"
    | "onSeekToTime"
    | "onRemoveKeyframe"
    | "onConvertToKeyframes"
  > & {
    element: DomEditSelection;
    styles: Record<string, string>;
    sections: ReturnType<typeof resolveEditingSections>;
    sourceLabel: string;
    gsapBorderRadius: { tl: number; tr: number; br: number; bl: number } | null;
    showEditableSections: boolean;
    selectedElementHidden: boolean;
    selectedElementId: string | null;
    clipboardCopied: boolean;
    onCopyElementInfo: () => void;
    currentTime: number;
  };
