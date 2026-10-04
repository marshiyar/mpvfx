import type { RefObject } from "react";
import type { DomEditSelection } from "./domEditing";
import type { PreviewMouseDownOptions } from "../preview/usePreviewInteraction";
import type { DomEditGroupPathOffsetCommit } from "./domEditOverlayGestures";
import type { GestureRecordingState } from "./GestureRecordControl";
import type { CropLinkState } from "./domEditOverlayCrop";
import type { ClipPathInsetSides } from "../inspector/clipPathHelpers";
import type { ZOrderAction, ZOrderPatch } from "./canvasContextMenuZOrder";

export interface DomEditOverlayProps {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  activeCompositionPath: string | null;
  selection: DomEditSelection | null;
  groupSelections?: DomEditSelection[];
  hoverSelection: DomEditSelection | null;
  allowCanvasMovement?: boolean;
  cropActive?: boolean;
  cropDisabled?: boolean;
  cropLinks?: CropLinkState;
  cropInsets?: ClipPathInsetSides;
  onCropInsetsPreview?: (insets: ClipPathInsetSides) => void;
  onCanvasMouseDown: (
    event: React.MouseEvent<HTMLDivElement>,
    options?: PreviewMouseDownOptions,
  ) => void;
  onCanvasPointerMove: (
    event: React.PointerEvent<HTMLDivElement>,
    options?: { preferClipAncestor?: boolean },
  ) => Promise<DomEditSelection | null>;
  onCanvasPointerLeave: () => void;
  onSelectionChange: (
    selection: DomEditSelection,
    options?: { revealPanel?: boolean; additive?: boolean },
  ) => void;
  onBlockedMove: (selection: DomEditSelection) => void;
  onManualDragStart?: () => void;
  onPathOffsetCommit: (
    selection: DomEditSelection,
    next: { x: number; y: number },
    modifiers?: { altKey?: boolean },
  ) => Promise<void> | void;
  onGroupPathOffsetCommit: (updates: DomEditGroupPathOffsetCommit[]) => Promise<void> | void;
  onBoxSizeCommit: (
    selection: DomEditSelection,
    next: { width: number; height: number },
    offset?: { x: number; y: number },
    restore?: () => void,
  ) => Promise<void> | void;
  onRotationCommit: (
    selection: DomEditSelection,
    next: { angle: number },
    offset?: { x: number; y: number },
  ) => Promise<void> | void;
  gridVisible?: boolean;
  gridSpacing?: number;
  recordingState?: GestureRecordingState;
  onToggleRecording?: () => void;
  onMarqueeSelect?: (selections: DomEditSelection[], additive: boolean) => void;
  /** Delete the selected canvas element, as the hotkey does. */
  onDeleteSelection?: (selection: DomEditSelection) => void;
  /** Commit a z-order patch with the crossed sibling for timeline mirroring. */
  onApplyZIndex?: (
    selection: DomEditSelection,
    patches: ZOrderPatch[],
    action: ZOrderAction,
    crossed: HTMLElement | null,
  ) => void;
}

type FrameRect = { left: number; top: number; width: number; height: number };

export function resolveProgramFrameClipPath(rect: FrameRect): string | undefined {
  if (rect.width <= 0 || rect.height <= 0) return undefined;
  const right = rect.left + rect.width;
  const bottom = rect.top + rect.height;
  return `polygon(${rect.left}px ${rect.top}px, ${right}px ${rect.top}px, ${right}px ${bottom}px, ${rect.left}px ${bottom}px)`;
}

export function eventIsInsideProgramFrame(
  event: { clientX: number; clientY: number },
  overlay: HTMLElement | null,
  rect: FrameRect,
): boolean {
  if (!overlay || rect.width <= 0 || rect.height <= 0) return false;
  const overlayRect = overlay.getBoundingClientRect();
  const x = event.clientX - overlayRect.left;
  const y = event.clientY - overlayRect.top;
  return x >= rect.left && x <= rect.left + rect.width &&
    y >= rect.top && y <= rect.top + rect.height;
}
