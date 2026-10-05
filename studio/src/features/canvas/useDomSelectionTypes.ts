import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { DomEditSelection } from "./domEditing";
import type { SelectElementOptions, TimelineElement } from "../../player/index";
import type { RightPanelTab } from "../../lib/studioHelpers";
import type { PreviewElementState } from "../../../shared/preview/agentProtocol";

export interface ApplyDomSelectionOptions {
  revealPanel?: boolean;
  additive?: boolean;
  preserveGroup?: boolean;
  // A selection coming FROM the timeline must not be echoed back; the preview
  // can resolve after a newer click or temporarily lack the matching DOM node.
  announce?: boolean;
}

export interface ResolveDomSelectionOptions {
  preferClipAncestor?: boolean;
  skipSourceProbe?: boolean;
  activeGroupElement?: HTMLElement | null;
}

export interface UseDomSelectionParams {
  projectId: string | null;
  activeCompPath: string | null;
  isMasterView: boolean;
  compIdToSrc: Map<string, string>;
  captionEditMode: boolean;
  previewIframeRef: MutableRefObject<HTMLIFrameElement | null>;
  timelineElements: TimelineElement[];
  getTimelineSelectionSet: () => ReadonlySet<string>;
  setSelectedTimelineElementId: (id: string | null, options?: SelectElementOptions) => void;
  /** Publishes a whole multi-selection to the timeline; the anchor is set separately. */
  setTimelineSelectionSet: (ids: Set<string>) => void;
  setRightCollapsed: (collapsed: boolean) => void;
  setRightPanelTab: (tab: RightPanelTab) => void;
  previewIframe: HTMLIFrameElement | null;
  refreshKey: number;
}

export interface UseDomSelectionReturn {
  // State
  domEditSelection: DomEditSelection | null;
  /** Data returned by the isolated preview agent, never a parent-owned DOM node. */
  remoteSelection: PreviewElementState | null;
  domEditGroupSelections: DomEditSelection[];
  domEditHoverSelection: DomEditSelection | null;
  activeGroupElement: HTMLElement | null;
  // Refs
  domEditSelectionRef: MutableRefObject<DomEditSelection | null>;
  domEditGroupSelectionsRef: MutableRefObject<DomEditSelection[]>;
  domEditHoverSelectionRef: MutableRefObject<DomEditSelection | null>;
  activeGroupElementRef: MutableRefObject<HTMLElement | null>;
  // State setters used by the edit-session reset and synchronization flows.
  setDomEditSelection: Dispatch<SetStateAction<DomEditSelection | null>>;
  setDomEditGroupSelections: Dispatch<SetStateAction<DomEditSelection[]>>;
  setActiveGroupElement: (el: HTMLElement | null) => void;
  // Callbacks
  applyDomSelection: (
    selection: DomEditSelection | null,
    options?: ApplyDomSelectionOptions,
  ) => void;
  clearDomSelection: () => void;
  buildDomSelectionFromTarget: (
    target: HTMLElement,
    options?: ResolveDomSelectionOptions,
  ) => Promise<DomEditSelection | null>;
  resolveDomSelectionFromPreviewPoint: (
    clientX: number,
    clientY: number,
    options?: ResolveDomSelectionOptions,
  ) => Promise<DomEditSelection | null>;
  resolveAllDomSelectionsFromPreviewPoint: (
    clientX: number,
    clientY: number,
  ) => Promise<DomEditSelection[]>;
  updateDomEditHoverSelection: (selection: DomEditSelection | null) => void;
  buildDomSelectionForTimelineElement: (
    element: TimelineElement,
  ) => Promise<DomEditSelection | null>;
  handleTimelineElementSelect: (element: TimelineElement | null) => Promise<void>;
  refreshDomEditSelectionFromPreview: (selection: DomEditSelection) => Promise<void>;
  refreshDomEditGroupSelectionsFromPreview: (selections: DomEditSelection[]) => Promise<void>;
  applyMarqueeSelection: (
    selections: DomEditSelection[], additive: boolean, options?: { announce?: boolean },
  ) => void;
}
