// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecordEditInput } from "../utils/studioFileHistory";

vi.mock("../utils/studioHelpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/studioHelpers")>();
  return { ...actual, resolveDroppedAssetDuration: vi.fn(async () => 4) };
});

import { useTimelineAssetDropOps } from "./useTimelineAssetDropOps";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("Media library asset drop", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("repairs the recoverable root, inserts the existing media, and reports no error", async () => {
    const damagedSource = `<!doctype html><html><head>
      <meta name="viewport" content="width=1920, height=1080">
    </head><body>
      <script>
        window.__timelines = window.__timelines || {};
        window.__timelines["main"] = gsap.timeline({ paused: true });
      </script>
    </body></html>`;
    let source = damagedSource;
    const showToast = vi.fn();
    const writeProjectFile = vi.fn(async (_path: string, content: string, _expected?: string) => {
      source = content;
    });
    const recordEdit = vi.fn(async (_input: RecordEditInput) => {});
    const reloadPreview = vi.fn();
    const forceReloadSdkSession = vi.fn();
    const captured: { current: ReturnType<typeof useTimelineAssetDropOps> | null } = {
      current: null,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ content: source })),
    );

    function Probe(): null {
      captured.current = useTimelineAssetDropOps({
        projectIdRef: { current: "MpVFX" },
        activeCompPath: "index.html",
        timelineElements: [],
        showToast,
        writeProjectFile,
        recordEdit,
        domEditSaveTimestampRef: { current: 0 },
        reloadPreview,
        uploadProjectFiles: vi.fn(async () => []),
        forceReloadSdkSession,
      });
      return null;
    }

    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Probe />));
    if (!captured.current) throw new Error("timeline media-drop hook did not mount");

    await act(async () => {
      await captured.current?.handleTimelineAssetDrop("vid8.m4v", { start: 6, track: 2 });
    });

    expect(source).toContain('data-composition-id="main"');
    expect(source).toContain('<video id="vid8"');
    expect(source).toContain('src="vid8.m4v"');
    expect(source).toContain('data-start="6"');
    expect(source).toContain('data-duration="10"');
    expect(writeProjectFile).toHaveBeenCalledTimes(1);
    expect(recordEdit).toHaveBeenCalledTimes(1);
    const historyEntry = recordEdit.mock.calls[0]?.[0];
    expect(historyEntry?.files["index.html"].before).toContain(
      'data-composition-id="main"',
    );
    expect(historyEntry?.files["index.html"].before).not.toContain(
      '<video id="vid8"',
    );
    expect(writeProjectFile.mock.calls[0]?.[2]).toBe(damagedSource);
    expect(reloadPreview).toHaveBeenCalledTimes(1);
    expect(forceReloadSdkSession).toHaveBeenCalledTimes(1);
    expect(showToast).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });
});
