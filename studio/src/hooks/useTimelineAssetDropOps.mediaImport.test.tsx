// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/studioHelpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/studioHelpers")>();
  return {
    ...actual,
    resolveDroppedAssetDuration: vi.fn(async () => 4),
  };
});

import { useTimelineAssetDropOps } from "./useTimelineAssetDropOps";
import type { TimelineElement } from "../player";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function mountHarness(initialSource: string, timelineElements: TimelineElement[] = []) {
  let source = initialSource;
  const showToast = vi.fn();
  const writeProjectFile = vi.fn(async (_path: string, content: string) => {
    source = content;
  });
  const recordEdit = vi.fn(async () => {});
  const reloadPreview = vi.fn();
  const forceReloadSdkSession = vi.fn();
  const uploadProjectFiles = vi.fn(async () => ["assets/camera.mov"]);
  const captured: {
    current: ReturnType<typeof useTimelineAssetDropOps> | null;
  } = { current: null };

  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ content: source }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );

  function Probe() {
    captured.current = useTimelineAssetDropOps({
      projectIdRef: { current: "project" },
      activeCompPath: "index.html",
      timelineElements,
      showToast,
      writeProjectFile,
      recordEdit,
      domEditSaveTimestampRef: { current: 0 },
      reloadPreview,
      uploadProjectFiles,
      forceReloadSdkSession,
    });
    return null;
  }

  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  if (!captured.current) throw new Error("timeline asset-drop hook did not mount");
  return {
    hook: captured.current,
    root,
    getSource: () => source,
    showToast,
    writeProjectFile,
    recordEdit,
    reloadPreview,
    forceReloadSdkSession,
    uploadProjectFiles,
  };
}

describe("timeline OS-media import", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("preflights the composition root before uploading any dropped bytes", async () => {
    const harness = await mountHarness("<html><body><p>broken</p></body></html>");

    await act(async () => {
      await harness.hook.handleTimelineFileDrop([new File(["video"], "camera.mov")]);
    });

    expect(harness.uploadProjectFiles).not.toHaveBeenCalled();
    expect(harness.writeProjectFile).not.toHaveBeenCalled();
    expect(harness.recordEdit).not.toHaveBeenCalled();
    expect(harness.reloadPreview).not.toHaveBeenCalled();
    expect(harness.forceReloadSdkSession).not.toHaveBeenCalled();
    expect(harness.showToast).toHaveBeenCalledWith(
      expect.stringContaining("missing its root"),
      "error",
    );
    await act(async () => harness.root.unmount());
  });

  it("extends the composition when imported media lands beyond its current end", async () => {
    const harness = await mountHarness(
      '<div id="root" data-composition-id="main" data-duration="5" data-width="1920" data-height="1080"></div>',
    );

    await act(async () => {
      await harness.hook.handleTimelineFileDrop(
        [new File(["video"], "camera.mov", { type: "video/quicktime" })],
        { start: 6, track: 2 },
      );
    });

    expect(harness.getSource()).toContain('data-duration="10"');
    expect(harness.getSource()).toContain('<video id="camera"');
    expect(harness.getSource()).toContain('src="assets/camera.mov"');
    expect(harness.getSource()).toContain('data-start="6"');
    expect(harness.getSource()).toContain('data-duration="4"');
    expect(harness.getSource()).toContain('data-track-index="2"');
    expect(harness.getSource()).not.toMatch(/<video[^>]*\smuted(?:\s|=|>)/i);
    expect(harness.getSource()).not.toMatch(/<video[^>]*\sautoplay(?:\s|=|>)/i);
    expect(harness.getSource()).toMatch(/<video[^>]*\splaysinline(?:\s|=|>)/i);
    expect(harness.writeProjectFile).toHaveBeenCalledTimes(1);
    expect(harness.recordEdit).toHaveBeenCalledTimes(1);
    expect(harness.reloadPreview).toHaveBeenCalledTimes(1);
    expect(harness.forceReloadSdkSession).toHaveBeenCalledTimes(1);
    await act(async () => harness.root.unmount());
  });

  it("renders a photo dropped on a lower track behind the video above it", async () => {
    const harness = await mountHarness(
      '<div id="root" data-composition-id="main" data-duration="8">' +
        '<video id="video" class="clip" src="assets/video.mov" data-start="0" data-duration="8" data-track-index="0" style="position: absolute; z-index: 1"></video>' +
        '</div>',
      [{
        id: "video",
        domId: "video",
        tag: "video",
        kind: "video",
        start: 0,
        duration: 8,
        track: 0,
        zIndex: 1,
        sourceFile: "index.html",
      }],
    );
    harness.uploadProjectFiles.mockResolvedValueOnce(["assets/photo.png"]);

    await act(async () => {
      await harness.hook.handleTimelineFileDrop(
        [new File(["image"], "photo.png", { type: "image/png" })],
        { start: 0, track: 1 },
      );
    });

    expect(harness.getSource()).toMatch(/<video[^>]*z-index:\s*1/);
    expect(harness.getSource()).toMatch(
      /<img[^>]*data-track-index="1"[^>]*z-index:\s*0/,
    );
    await act(async () => harness.root.unmount());
  });

  it("uses the prepended DOM tie-break at the z-index floor without rewriting the upper clip", async () => {
    const harness = await mountHarness(
      '<div id="root" data-composition-id="main" data-duration="8">' +
        '<video id="video" class="clip" src="assets/video.mov" data-start="0" data-duration="8" data-track-index="0" style="position: absolute; z-index: 0"></video>' +
        '</div>',
      [{
        id: "video",
        domId: "video",
        tag: "video",
        kind: "video",
        start: 0,
        duration: 8,
        track: 0,
        zIndex: 0,
        sourceFile: "index.html",
      }],
    );
    harness.uploadProjectFiles.mockResolvedValueOnce(["assets/photo.png"]);

    await act(async () => {
      await harness.hook.handleTimelineFileDrop(
        [new File(["image"], "photo.png", { type: "image/png" })],
        { start: 0, track: 1 },
      );
    });

    expect(harness.getSource()).toMatch(/<video[^>]*z-index:\s*0/);
    expect(harness.getSource()).toMatch(/<img[^>]*z-index:\s*0/);
    await act(async () => harness.root.unmount());
  });

  it("sequences mixed image and audio imports and extends through the final clip", async () => {
    const harness = await mountHarness(
      '<div id="root" data-composition-id="main" data-duration="2"></div>',
    );
    harness.uploadProjectFiles.mockResolvedValueOnce(["assets/poster.avif", "assets/voice.aac"]);

    await act(async () => {
      await harness.hook.handleTimelineFileDrop(
        [
          new File(["image"], "poster.avif", { type: "image/avif" }),
          new File(["audio"], "voice.aac", { type: "audio/aac" }),
        ],
        { start: 1, track: 3 },
      );
    });

    expect(harness.getSource()).toContain('data-duration="9"');
    expect(harness.getSource()).toContain('<img id="poster"');
    expect(harness.getSource()).toContain('src="assets/poster.avif" data-start="1"');
    expect(harness.getSource()).toContain('<audio id="voice"');
    expect(harness.getSource()).toContain('src="assets/voice.aac" data-start="5"');
    expect(harness.getSource().match(/data-track-index="3"/g)).toHaveLength(2);
    expect(harness.writeProjectFile).toHaveBeenCalledTimes(2);
    expect(harness.recordEdit).toHaveBeenCalledTimes(2);
    expect(harness.reloadPreview).toHaveBeenCalledTimes(2);
    await act(async () => harness.root.unmount());
  });
});
