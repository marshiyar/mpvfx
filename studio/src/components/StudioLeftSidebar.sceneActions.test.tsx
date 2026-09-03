// @vitest-environment happy-dom

import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activeCompPath: null as string | null,
  setActiveCompPath: vi.fn(),
  handleDeleteComposition: vi.fn(async () => true),
  leftSidebarProps: null as Record<string, unknown> | null,
  startRender: vi.fn(),
}));

vi.mock("./sidebar/LeftSidebar", () => ({
  LeftSidebar: (props: Record<string, unknown>) => {
    mocks.leftSidebarProps = props;
    return <div data-left-sidebar-stub="" />;
  },
}));

vi.mock("../contexts/PanelLayoutContext", () => ({
  usePanelLayoutContext: () => ({
    effectiveLeftCollapsed: false,
    leftWidth: 260,
    adjustPanelWidth: vi.fn(),
    toggleLeftSidebar: vi.fn(),
    handlePanelResizeStart: vi.fn(),
    handlePanelResizeMove: vi.fn(),
    handlePanelResizeEnd: vi.fn(),
    setRightPanelTab: vi.fn(),
    setRightCollapsed: vi.fn(),
  }),
}));

vi.mock("../contexts/StudioContext", () => ({
  useStudioShellContext: () => ({
    projectId: "demo",
    activeCompPath: mocks.activeCompPath,
    setActiveCompPath: mocks.setActiveCompPath,
    waitForPendingDomEditSaves: vi.fn(),
    renderQueue: {
      ffmpegMissing: false,
      isRendering: false,
      startRender: mocks.startRender,
    },
  }),
}));

vi.mock("../contexts/FileManagerContext", () => ({
  useFileManagerContext: () => ({
    compositions: ["index.html", "compositions/intro.html"],
    assets: [],
    editingFile: { path: "compositions/intro.html", content: "scene" },
    handleDeleteFile: vi.fn(),
    handleDeleteComposition: mocks.handleDeleteComposition,
    handleRenameFile: vi.fn(),
    handleImportFiles: vi.fn(),
  }),
}));

import { StudioLeftSidebar } from "./StudioLeftSidebar";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.innerHTML = "";
  mocks.activeCompPath = null;
  mocks.leftSidebarProps = null;
  mocks.setActiveCompPath.mockReset();
  mocks.handleDeleteComposition.mockReset();
  mocks.handleDeleteComposition.mockResolvedValue(true);
  mocks.startRender.mockReset();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("Studio reusable-scene action wiring", () => {
  it("forwards persisted exact export dimensions when rendering a scene card", async () => {
    localStorage.setItem(
      "hf-studio-render-settings",
      JSON.stringify({
        format: "webm",
        quality: "high",
        fps: 60,
        resolution: "social-4-5",
      }),
    );
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <StudioLeftSidebar
          leftSidebarRef={{ current: null }}
          masterComposition="index.html"
          onSelectComposition={vi.fn()}
          onAddBlock={vi.fn()}
        />,
      );
    });

    const onRender = mocks.leftSidebarProps?.onRenderComposition as
      | ((path: string) => Promise<void>)
      | undefined;
    if (!onRender) throw new Error("scene render callback was not wired");
    await act(async () => onRender("compositions/intro.html"));

    expect(mocks.startRender).toHaveBeenCalledWith({
      composition: "compositions/intro.html",
      format: "webm",
      quality: "high",
      fps: 60,
      dimensions: { width: 1080, height: 1350 },
    });
    act(() => root.unmount());
  });

  it("reads a legacy scene's canvas before migrating its saved 4K scale", async () => {
    localStorage.setItem(
      "hf-studio-render-settings",
      JSON.stringify({ format: "mp4", quality: "standard", fps: 30, resolution: "4k" }),
    );
    const fetchMock = vi.fn(async (url: string) => {
      const portrait = url.includes("intro");
      return new Response(
        JSON.stringify({
          content: portrait
            ? '<main data-composition-id="intro" data-width="1080" data-height="1920"></main>'
            : '<main data-composition-id="outro" data-width="1920" data-height="1080"></main>',
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <StudioLeftSidebar
          leftSidebarRef={{ current: null }}
          masterComposition="index.html"
          onSelectComposition={vi.fn()}
          onAddBlock={vi.fn()}
        />,
      );
    });

    const onRender = mocks.leftSidebarProps?.onRenderComposition as
      | ((path: string) => Promise<void>)
      | undefined;
    if (!onRender) throw new Error("scene render callback was not wired");
    await act(async () => onRender("compositions/intro.html"));
    await act(async () => onRender("compositions/outro.html"));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/demo/files/compositions%2Fintro.html",
    );
    expect(mocks.startRender).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ dimensions: { width: 2160, height: 3840 } }),
    );
    expect(mocks.startRender).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ dimensions: { width: 3840, height: 2160 } }),
    );
    expect(JSON.parse(localStorage.getItem("hf-studio-render-settings") ?? "{}").resolution).toBe(
      "4k",
    );
    act(() => root.unmount());
  });

  it("does not treat stale source-editor state as the active preview scene", () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => {
      root.render(
        <StudioLeftSidebar
          leftSidebarRef={{ current: null }}
          masterComposition="index.html"
          onSelectComposition={vi.fn()}
          onAddBlock={vi.fn()}
        />,
      );
    });

    expect(mocks.leftSidebarProps?.activeComposition).toBeNull();
    act(() => root.unmount());
  });

  it("returns to the master timeline after deleting the active reusable scene", async () => {
    mocks.activeCompPath = "compositions/intro.html";
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <StudioLeftSidebar
          leftSidebarRef={{ current: null }}
          masterComposition="index.html"
          onSelectComposition={vi.fn()}
          onAddBlock={vi.fn()}
        />,
      );
    });

    const onDelete = mocks.leftSidebarProps?.onDeleteComposition as
      | ((path: string) => Promise<void>)
      | undefined;
    if (!onDelete) throw new Error("scene delete callback was not wired");
    await act(async () => onDelete("compositions/intro.html"));

    expect(mocks.handleDeleteComposition).toHaveBeenCalledWith("compositions/intro.html");
    expect(mocks.setActiveCompPath).toHaveBeenCalledWith(null);
    act(() => root.unmount());
  });

  it("does not close a different scene selected while deletion is pending", async () => {
    let finishDelete: ((deleted: boolean) => void) | undefined;
    mocks.handleDeleteComposition.mockImplementation(
      () => new Promise<boolean>((resolve) => {
        finishDelete = resolve;
      }),
    );
    mocks.activeCompPath = "compositions/intro.html";
    const host = document.createElement("div");
    const root = createRoot(host);
    const render = () => (
      <StudioLeftSidebar
        leftSidebarRef={{ current: null }}
        masterComposition="index.html"
        onSelectComposition={vi.fn()}
        onAddBlock={vi.fn()}
      />
    );
    await act(async () => root.render(render()));

    const onDelete = mocks.leftSidebarProps?.onDeleteComposition as
      | ((path: string) => Promise<void>)
      | undefined;
    if (!onDelete) throw new Error("scene delete callback was not wired");
    const pendingDelete = onDelete("compositions/intro.html");

    mocks.activeCompPath = "compositions/outro.html";
    await act(async () => root.render(render()));
    await act(async () => {
      finishDelete?.(true);
      await pendingDelete;
    });

    expect(mocks.setActiveCompPath).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("returns to the master after active-scene deletion under Strict Mode effect replay", async () => {
    mocks.activeCompPath = "compositions/intro.html";
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <StrictMode>
          <StudioLeftSidebar
            leftSidebarRef={{ current: null }}
            masterComposition="index.html"
            onSelectComposition={vi.fn()}
            onAddBlock={vi.fn()}
          />
        </StrictMode>,
      );
    });

    const onDelete = mocks.leftSidebarProps?.onDeleteComposition as
      | ((path: string) => Promise<void>)
      | undefined;
    if (!onDelete) throw new Error("scene delete callback was not wired");
    await act(async () => onDelete("compositions/intro.html"));

    expect(mocks.setActiveCompPath).toHaveBeenCalledWith(null);
    act(() => root.unmount());
  });
});
