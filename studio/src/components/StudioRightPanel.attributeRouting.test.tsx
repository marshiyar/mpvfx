// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routing = vi.hoisted(() => ({
  propertyPanelProps: null as Record<string, unknown> | null,
  handleDomAttributeLiveCommit: vi.fn(),
}));

vi.mock("./editor/PropertyPanel", () => ({
  PropertyPanel: (props: Record<string, unknown>) => {
    routing.propertyPanelProps = props;
    return <div data-testid="property-panel" />;
  },
}));

vi.mock("../captions/components/CaptionPropertyPanel", () => ({
  CaptionPropertyPanel: () => null,
}));
vi.mock("./editor/BlockParamsPanel", () => ({ BlockParamsPanel: () => null }));
vi.mock("./renders/RenderQueuePanel", () => ({ RenderQueuePanel: () => null }));
vi.mock("./StudioRightSidebarChrome", () => ({ StudioRightPanelTabs: () => null }));

vi.mock("../contexts/StudioContext", () => ({
  useStudioPlaybackContext: () => ({ captionEditMode: false }),
  useStudioShellContext: () => ({
    previewIframeRef: { current: null },
    projectId: "routing-test",
    activeCompPath: "index.html",
    showToast: vi.fn(),
    waitForPendingDomEditSaves: vi.fn(),
    renderQueue: { jobs: [] },
  }),
}));

vi.mock("../contexts/PanelLayoutContext", () => ({
  usePanelLayoutContext: () => ({
    rightWidth: 360,
    adjustPanelWidth: vi.fn(),
    setRightCollapsed: vi.fn(),
    rightPanelTab: "design",
    setRightPanelTab: vi.fn(),
    handlePanelResizeStart: vi.fn(),
    handlePanelResizeMove: vi.fn(),
    handlePanelResizeEnd: vi.fn(),
  }),
}));

vi.mock("../contexts/FileManagerContext", () => ({
  useFileManagerContext: () => ({
    assets: [],
    fontAssets: [],
    projectDir: "/tmp/routing-test",
    handleImportFiles: vi.fn(),
    handleImportFonts: vi.fn(),
    refreshFileTree: vi.fn(),
    readProjectFile: vi.fn(),
    writeProjectFile: vi.fn(),
    fileTree: [],
  }),
}));

vi.mock("../contexts/DomEditContext", () => ({
  useDomEditContext: () => ({
    domEditSelection: null,
    domEditGroupSelections: [],
    clearDomSelection: vi.fn(),
    handleUngroupSelection: vi.fn(),
    handleGroupSelection: vi.fn(),
    handleDomStyleCommit: vi.fn(),
    handleDomDesignReset: vi.fn(),
    handleDomAttributeCommit: vi.fn(),
    handleDomAttributeLiveCommit: routing.handleDomAttributeLiveCommit,
    handleDomAttributeQuietCommit: vi.fn(),
    handleDomHtmlAttributeCommit: vi.fn(),
    handleDomAttributesCommit: vi.fn(),
    handleDomPathOffsetCommit: vi.fn(),
    handleDomBoxSizeCommit: vi.fn(),
    handleDomRotationCommit: vi.fn(),
    handleDomTextCommit: vi.fn(),
    handleDomTextFieldStyleCommit: vi.fn(),
    handleDomAddTextField: vi.fn(),
    handleDomRemoveTextField: vi.fn(),
    selectedGsapAnimations: [],
    gsapMultipleTimelines: false,
    gsapUnsupportedTimelinePattern: false,
    handleGsapUpdateProperty: vi.fn(),
    handleGsapUpdateMeta: vi.fn(),
    handleGsapDeleteAnimation: vi.fn(),
    handleGsapAddAnimation: vi.fn(),
    handleGsapAddProperty: vi.fn(),
    handleGsapRemoveProperty: vi.fn(),
    handleGsapUpdateFromProperty: vi.fn(),
    handleGsapAddFromProperty: vi.fn(),
    handleGsapRemoveFromProperty: vi.fn(),
    commitAnimatedProperty: vi.fn(),
    commitAnimatedProperties: vi.fn(),
    handleSetArcPath: vi.fn(),
    handleUpdateArcSegment: vi.fn(),
    handleUnroll: vi.fn(),
    handleUpdateKeyframeEase: vi.fn(),
    handleUpdateSegmentEase: vi.fn(),
    handleSetAllKeyframeEases: vi.fn(),
    handleGsapAddKeyframe: vi.fn(),
    handleGsapRemoveKeyframe: vi.fn(),
    handleGsapConvertToKeyframes: vi.fn(),
  }),
}));

vi.mock("../hooks/useRemoveBackground", () => ({
  useRemoveBackground: () => vi.fn(),
}));

import { StudioRightPanel } from "./StudioRightPanel";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  routing.propertyPanelProps = null;
  routing.handleDomAttributeLiveCommit.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);

  act(() => {
    root.render(
      <StudioRightPanel
        designPanelActive
        reloadPreview={vi.fn()}
        domEditSaveTimestampRef={{ current: 0 }}
        recordEdit={vi.fn()}
      />,
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("StudioRightPanel attribute routing", () => {
  it("routes durable color and effect changes through the live commit without preview-only mode", async () => {
    const onSetAttributeLive = routing.propertyPanelProps?.onSetAttributeLive;
    const onSettled = vi.fn();

    expect(onSetAttributeLive).toEqual(expect.any(Function));
    await act(async () => {
      await (onSetAttributeLive as (
        attr: string,
        value: string,
        onSettled: (ok: boolean) => void,
      ) => Promise<void>)(
        "data-grade-exposure",
        "0.3",
        onSettled,
      );
    });

    expect(routing.handleDomAttributeLiveCommit.mock.calls[0]).toEqual([
      "data-grade-exposure",
      "0.3",
      onSettled,
    ]);
  });

  it("keeps continuous pointer previews on an explicit preview-only callback", async () => {
    const onPreviewAttributeLive = routing.propertyPanelProps?.onPreviewAttributeLive;

    expect(onPreviewAttributeLive).toEqual(expect.any(Function));
    await act(async () => {
      await (onPreviewAttributeLive as (attr: string, value: string) => Promise<void>)(
        "data-grade-exposure",
        "0.35",
      );
    });

    expect(routing.handleDomAttributeLiveCommit).toHaveBeenCalledWith(
      "data-grade-exposure",
      "0.35",
      undefined,
      { previewOnly: true },
    );
  });
});
