/**
 * Props for StudioRightPanel.
 *
 * Kept beside the component rather than inside it: the panel is at the file-size
 * cap, and this block is the part that changes least, so moving it keeps the
 * component's own diffs small and readable.
 */

import type { MutableRefObject } from "react";
import type { BlockParam } from "@hyperframes/core/registry";
import type { EditHistoryKind } from "../utils/editHistory";
import type { AddMediaOverlayHandler } from "./editor/propertyPanelTypes";
import type { ToggleHiddenHandler } from "../utils/studioHelpers";

export interface StudioRightPanelProps {
  designPanelActive: boolean;
  activeBlockParams?: {
    blockName: string;
    blockTitle: string;
    params: BlockParam[];
    compositionPath: string;
  } | null;
  onCloseBlockParams?: () => void;
  recordingState?: "idle" | "recording" | "preview";
  recordingDuration?: number;
  onToggleRecording?: () => void;
  reloadPreview: () => void;
  domEditSaveTimestampRef: MutableRefObject<number>;
  recordEdit: (entry: {
    label: string;
    kind: EditHistoryKind;
    files: Record<string, { before: string; after: string }>;
  }) => Promise<void>;
  onToggleElementHidden?: ToggleHiddenHandler;
  onAutoGroupCarveSources?: (clipIds: readonly string[], groupId: string) => Promise<void>;
  onAddMediaOverlay?: AddMediaOverlayHandler;
}
