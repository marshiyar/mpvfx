// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DomEditSelection } from "../canvas/domEditing";
import { usePreviewSelectionRefresh } from "./usePreviewSelectionRefresh";

type Options = Parameters<typeof usePreviewSelectionRefresh>[0];
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let host: HTMLDivElement;
let options: Options;

function Probe({ value }: { value: Options }) {
  usePreviewSelectionRefresh(value);
  return null;
}

function render(patch: Partial<Options> = {}) {
  options = { ...options, ...patch };
  act(() => root.render(<Probe value={options} />));
}

function selection(id: string): DomEditSelection {
  // A detached preview node is expected between navigation and the next load.
  return {
    id,
    element: document.createElement("video"),
    label: id,
    tagName: "video",
    sourceFile: "index.html",
    compositionPath: "index.html",
    isCompositionHost: false,
    isInsideLockedComposition: false,
    boundingBox: { x: 0, y: 0, width: 1920, height: 1080 },
    textContent: null,
    dataAttributes: {},
    inlineStyles: {},
    computedStyles: {},
    textFields: [],
    capabilities: {
      canSelect: true,
      canEditStyles: true,
      canCrop: true,
      canMove: true,
      canResize: true,
      canApplyManualOffset: true,
      canApplyManualSize: true,
      canApplyManualRotation: true,
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  options = {
    projectId: "project-a",
    domEditSelectionRef: { current: selection("clip-a") },
    refreshKey: 0,
    previewDocumentVersion: 0,
    refreshDomEditSelectionFromPreview: vi.fn().mockResolvedValue(undefined),
  };
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("preview selection refresh", () => {
  it("keeps selection local when mounted, reloaded, or leaving a project", () => {
    render();
    render({ refreshKey: 1 });
    render({ previewDocumentVersion: 1 });
    render({ projectId: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("re-resolves selection once after a reload, ignoring later settling ticks", () => {
    render();
    expect(options.refreshDomEditSelectionFromPreview).not.toHaveBeenCalled();
    render({ refreshKey: 1 });
    expect(options.refreshDomEditSelectionFromPreview).not.toHaveBeenCalled();
    render({ previewDocumentVersion: 1 });
    expect(options.refreshDomEditSelectionFromPreview).toHaveBeenCalledExactlyOnceWith(
      options.domEditSelectionRef.current,
    );
    render({ previewDocumentVersion: 2 });
    render({ previewDocumentVersion: 3 });
    expect(options.refreshDomEditSelectionFromPreview).toHaveBeenCalledTimes(1);
    render({ refreshKey: 2 });
    render({ previewDocumentVersion: 4 });
    expect(options.refreshDomEditSelectionFromPreview).toHaveBeenCalledTimes(2);
  });

  it("does not restore a selection the user cleared while the preview was loading", () => {
    render();
    render({ refreshKey: 1 });
    options.domEditSelectionRef.current = null;
    render({ previewDocumentVersion: 1 });
    expect(options.refreshDomEditSelectionFromPreview).not.toHaveBeenCalled();
  });

  it("handles a reload and document load delivered in the same render", () => {
    render();
    render({ refreshKey: 1, previewDocumentVersion: 1 });
    expect(options.refreshDomEditSelectionFromPreview).toHaveBeenCalledExactlyOnceWith(
      options.domEditSelectionRef.current,
    );
  });

  it("waits for document load even if the refresh callback changes", () => {
    render();
    render({ refreshKey: 1 });
    render({ refreshDomEditSelectionFromPreview: vi.fn().mockResolvedValue(undefined) });
    expect(options.refreshDomEditSelectionFromPreview).not.toHaveBeenCalled();
    render({ previewDocumentVersion: 1 });
    expect(options.refreshDomEditSelectionFromPreview).toHaveBeenCalledTimes(1);
  });

  it("does not carry a pending refresh into another project", () => {
    render();
    render({ refreshKey: 1 });
    options.domEditSelectionRef.current = selection("clip-b");
    render({ projectId: "project-b", previewDocumentVersion: 1 });
    expect(options.refreshDomEditSelectionFromPreview).not.toHaveBeenCalled();
  });
});
