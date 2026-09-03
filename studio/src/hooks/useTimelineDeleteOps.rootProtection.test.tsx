// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildStandaloneRootTimelineElement } from "../player/lib/timelineDOM";
import { useTimelineDeleteOps } from "./useTimelineDeleteOps";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("timeline composition-root deletion protection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("never sends a mutation for the structural composition row", async () => {
    const structuralRoot = buildStandaloneRootTimelineElement({
      compositionId: "main",
      tagName: "div",
      rootDuration: 5,
      iframeSrc: "http://localhost/api/projects/my-video/preview/index.html",
      selector: '[data-composition-id="main"]',
    });
    if (!structuralRoot) throw new Error("structural timeline row was not created");
    const fetchMock = vi.fn();
    const showToast = vi.fn();
    const writeProjectFile = vi.fn(async () => {});
    const recordEdit = vi.fn(async () => {});
    const reloadPreview = vi.fn();
    const forceReloadSdkSession = vi.fn();
    let api: ReturnType<typeof useTimelineDeleteOps> | null = null;
    vi.stubGlobal("fetch", fetchMock);

    function Probe(): null {
      api = useTimelineDeleteOps({
        projectIdRef: { current: "my-video" },
        activeCompPath: null,
        timelineElements: [structuralRoot!],
        showToast,
        writeProjectFile,
        recordEdit,
        domEditSaveTimestampRef: { current: 0 },
        reloadPreview,
        forceReloadSdkSession,
        previewIframeRef: { current: null },
      });
      return null;
    }

    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Probe />));
    await act(async () => api?.handleTimelineElementDelete(structuralRoot));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(writeProjectFile).not.toHaveBeenCalled();
    expect(recordEdit).not.toHaveBeenCalled();
    expect(reloadPreview).not.toHaveBeenCalled();
    expect(forceReloadSdkSession).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      "The composition container cannot be deleted.",
      "info",
    );

    await act(async () => root.unmount());
  });
});
