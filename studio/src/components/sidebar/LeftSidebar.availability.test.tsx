// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const catalog = vi.hoisted(() => ({ blocks: [] as Array<Record<string, unknown>> }));
vi.mock("../../hooks/useBlockCatalog", () => ({
  useBlockCatalog: () => ({
    blocks: catalog.blocks,
    loading: false,
    error: null,
    search: "",
    setSearch: vi.fn(),
    category: null,
    setCategory: vi.fn(),
    filteredBlocks: catalog.blocks,
  }),
}));
vi.mock("../../utils/studioTelemetry", () => ({ trackStudioEvent: vi.fn() }));

import { getSidebarTabs, LeftSidebar } from "./LeftSidebar";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
});

afterEach(() => {
  catalog.blocks = [];
  vi.unstubAllGlobals();
  localStorage.clear();
  document.body.innerHTML = "";
});

function mount(
  compositions: string[],
  onToggleCollapse?: () => void,
  onImportFiles?: (files: FileList) => void | Promise<void>,
) {
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => {
    root.render(
      <LeftSidebar
        projectId="demo"
        compositions={compositions}
        masterComposition="index.html"
        assets={[]}
        activeComposition={null}
        onSelectComposition={vi.fn()}
        onToggleCollapse={onToggleCollapse}
        onImportFiles={onImportFiles}
      />,
    );
  });
  return { host, root };
}

describe("sidebar feature availability", () => {
  it("shows only Media when the project has no reusable scenes or elements", () => {
    expect(getSidebarTabs({ hasScenes: false, hasElements: false }).map((tab) => tab.label)).toEqual([
      "Media",
    ]);
    const { host, root } = mount(["index.html"]);

    expect(host.querySelector('[role="tablist"]')).toBeNull();
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(host.textContent).not.toContain("Scenes");
    expect(host.textContent).not.toContain("Elements");
    act(() => root.unmount());
  });

  it("does not render a giant Media selector when Media is the only panel", () => {
    const { host, root } = mount(["index.html"], vi.fn());

    expect(host.querySelector('[role="tablist"]')).toBeNull();
    expect(Array.from(host.querySelectorAll("button"), (button) => button.textContent?.trim())).not
      .toContain("Media");
    expect(host.querySelector('button[aria-label="Hide sidebar"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it("places Import media immediately left of Hide sidebar in the media header", () => {
    const { host, root } = mount(["index.html"], vi.fn(), vi.fn());
    const hideSidebar = host.querySelector<HTMLButtonElement>('button[aria-label="Hide sidebar"]');
    const importMedia = host.querySelector<HTMLButtonElement>('button[aria-label="Import media"]');

    expect(importMedia).not.toBeNull();
    expect(hideSidebar?.previousElementSibling).toBe(importMedia);
    expect(host.querySelectorAll('button[aria-label="Import media"]')).toHaveLength(1);
    expect(importMedia?.className).toContain("bg-panel-input");
    expect(importMedia?.className).toContain("text-panel-text-3");
    expect(importMedia?.className).toContain("text-[11px]");

    act(() => root.unmount());
  });

  it("shows the header import as busy while a media-pane drop is pending", async () => {
    let resolveImport: (() => void) | undefined;
    const pendingImport = new Promise<void>((resolve) => {
      resolveImport = resolve;
    });
    const onImportFiles = vi.fn(() => pendingImport);
    const { host, root } = mount(["index.html"], vi.fn(), onImportFiles);
    const importMedia = host.querySelector<HTMLButtonElement>('button[aria-label="Import media"]');
    const mediaPane = host.querySelector<HTMLElement>('#sidebar-panel-assets > div');
    const droppedFiles = [new File(["video"], "clip.mp4", { type: "video/mp4" })];
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { files: droppedFiles } });

    act(() => mediaPane?.dispatchEvent(drop));

    expect(onImportFiles).toHaveBeenCalledExactlyOnceWith(droppedFiles);
    expect(importMedia?.disabled).toBe(true);
    expect(importMedia?.getAttribute("aria-busy")).toBe("true");

    await act(async () => resolveImport?.());
    expect(importMedia?.disabled).toBe(false);
    expect(importMedia?.getAttribute("aria-busy")).toBe("false");
    act(() => root.unmount());
  });

  it("shows Scenes when a reusable scene actually exists", () => {
    const { host, root } = mount(["index.html", "compositions/intro.html"]);
    expect(
      Array.from(host.querySelectorAll('[role="tab"]')).map((tab) => tab.textContent),
    ).toEqual(["Media", "Scenes"]);
    act(() => root.unmount());
  });
});
