// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../feedback/projectProvenance", () => ({
  captureProjectProvenance: vi.fn(),
}));

import { useFileManager } from "./useFileManager";
import { useColorGradingController } from "../inspector/useColorGradingController";
import { createColorGradingActions } from "../inspector/propertyPanelColorGradingControls";
import { useDomEditAttributeCommits } from "../canvas/useDomEditAttributeCommits";
import type { DomEditSelection } from "../canvas/domEditing";
import type { PersistDomEditOperations } from "../canvas/domEditCommitTypes";
import { normalizeHfColorGrading } from "@hyperframes/core/color-grading";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("media library refresh after import", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("keeps an imported LUT in the live source and after reselection while its save settles", async () => {
    vi.useFakeTimers();
    const oldPath = "assets/luts/identity.cube";
    const newPath = "assets/luts/inverted.cube";
    let disk = `<div data-composition-id="main"><video id="clip" data-color-grading='{"lut":{"src":"${oldPath}","intensity":1}}'></video><audio id="other"></audio></div>`;
    let uploaded = false;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        uploaded = true;
        return Response.json({ files: [newPath] }, { status: 201 });
      }
      return Response.json({
        files: ["index.html", oldPath, ...(uploaded ? [newPath] : [])],
        compositions: ["index.html"], dir: "/projects/p1",
      });
    }));
    const iframe = document.body.appendChild(document.createElement("iframe"));
    const doc = iframe.contentDocument!;
    doc.body.innerHTML = disk;
    const previewIframeRef = { current: iframe };
    const readSelection = (id: string): DomEditSelection => {
      const element = doc.getElementById(id)!;
      const rawGrade = element.getAttribute("data-color-grading");
      return {
        element, id, selector: `#${id}`, selectorIndex: 0, label: id,
        tagName: element.tagName.toLowerCase(), sourceFile: "index.html", compositionPath: "index.html",
        isCompositionHost: false, isInsideLockedComposition: false,
        boundingBox: { x: 0, y: 0, width: 640, height: 360 }, textContent: "",
        dataAttributes: rawGrade ? { "color-grading": rawGrade } : {},
        inlineStyles: {}, computedStyles: {}, textFields: [],
        capabilities: {
          canSelect: true, canEditStyles: true, canCrop: true, canMove: true,
          canResize: true, canApplyManualOffset: true, canApplyManualSize: true,
          canApplyManualRotation: true,
        },
      };
    };
    let finishReload: (() => void) | undefined;
    const reload = vi.fn(() => {
      // Navigation starts at import completion, before its caller applies the LUT.
      const requestedSource = disk;
      finishReload = () => {
        doc.body.innerHTML = requestedSource;
        iframe.dispatchEvent(new Event("load"));
      };
    });
    let finishSave!: () => void;
    const persist = vi.fn<PersistDomEditOperations>((selection, operations) => new Promise<void>((resolve) => {
      finishSave = () => {
        const source = document.implementation.createHTMLDocument();
        source.body.innerHTML = disk;
        for (const operation of operations) {
          if (operation.type !== "attribute") throw new Error("Expected grading attribute commit");
          const element = source.getElementById(selection.id!)!;
          if (operation.value == null) element.removeAttribute(`data-${operation.property}`);
          else element.setAttribute(`data-${operation.property}`, operation.value);
        }
        disk = source.body.innerHTML;
        resolve();
      };
    }));
    const showToast = vi.fn();
    const refreshSelection = vi.fn();
    let manager!: ReturnType<typeof useFileManager>;
    let controller!: ReturnType<typeof useColorGradingController>;
    let select!: (id: string) => void;
    function Harness() {
      const [selection, setSelection] = useState(() => readSelection("clip"));
      select = (id) => setSelection(readSelection(id));
      manager = useFileManager({ projectId: "p1", showToast, setRefreshKey: reload });
      const attributes = useDomEditAttributeCommits({
        activeCompPath: "index.html", previewIframeRef, domEditSelection: selection,
        showToast, refreshDomEditSelectionFromPreview: refreshSelection,
        persistDomEditOperations: persist,
      });
      controller = useColorGradingController({
        projectId: "p1", element: selection, previewIframeRef,
        onSetAttributeLive: attributes.handleDomAttributeLiveCommit,
      });
      return null;
    }
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    try {
      await act(async () => root.render(<Harness />));
      const transfer = new DataTransfer();
      transfer.items.add(new File(["LUT_3D_SIZE 2"], "inverted.cube"));
      await act(async () => {
        await createColorGradingActions(controller.grading, controller.commitColorGrading)
          .importLut(transfer.files, manager.handleImportFiles, () => {});
      });
      expect(manager.assets).toContain(newPath);
      expect(controller.grading.lut?.src).toBe(newPath);
      await act(async () => vi.advanceTimersByTimeAsync(400));
      expect(persist).toHaveBeenCalledOnce();
      await act(async () => {
        finishReload?.();
        finishSave();
      });
      expect(disk).toContain(newPath);
      const liveGrade = doc.getElementById("clip")!.getAttribute("data-color-grading");
      expect.soft(normalizeHfColorGrading(liveGrade)?.lut?.src).toBe(newPath);
      act(() => select("other"));
      act(() => select("clip"));
      expect.soft(controller.grading.lut?.src).toBe(newPath);
      expect(reload).not.toHaveBeenCalled();
      expect(persist).toHaveBeenCalledOnce();
    } finally {
      act(() => root.unmount());
    }
  });

  it("adds the uploaded media to the assets exposed to the Media section", async () => {
    let uploaded = false;
    const listingUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          uploaded = true;
          return Response.json({ files: ["camera.mp4"] }, { status: 201 });
        }
        listingUrls.push(String(input));
        return Response.json({
          files: uploaded ? ["index.html", "camera.mp4"] : ["index.html"],
          compositions: ["index.html"],
          dir: "/projects/my-video",
        });
      }),
    );

    const captured: { current: ReturnType<typeof useFileManager> | null } = { current: null };
    function Probe(): null {
      captured.current = useFileManager({
        projectId: "project/a",
        showToast: vi.fn(),
        setRefreshKey: vi.fn(),
      });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Probe />));
    await vi.waitFor(() => expect(captured.current?.fileTreeLoaded).toBe(true));

    await act(async () => {
      await captured.current?.uploadProjectFiles([
        new File(["video"], "camera.mp4", { type: "video/mp4" }),
      ]);
    });

    expect(captured.current?.assets).toContain("camera.mp4");
    expect(listingUrls).toEqual([
      "/api/projects/project%2Fa",
      "/api/projects/project%2Fa",
    ]);
    await act(async () => root.unmount());
  });
});
