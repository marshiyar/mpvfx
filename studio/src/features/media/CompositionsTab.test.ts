import { describe, expect, it, vi } from "vitest";
import {
  resolveCompositionPreviewScale,
  resolveThumbnailSeekTime,
  syncIframePlayback,
} from "./CompositionsTab";

describe("resolveCompositionPreviewScale", () => {
  it("scales a 16:9 stage to fit the composition card", () => {
    expect(
      resolveCompositionPreviewScale({
        cardWidth: 80,
        cardHeight: 45,
        stageWidth: 1920,
        stageHeight: 1080,
      }),
    ).toBeCloseTo(80 / 1920);
  });

  it("scales non-16:9 stages against their actual dimensions", () => {
    expect(
      resolveCompositionPreviewScale({
        cardWidth: 80,
        cardHeight: 45,
        stageWidth: 1280,
        stageHeight: 720,
      }),
    ).toBeCloseTo(80 / 1280);
  });

  it("falls back to the default stage when dimensions are invalid", () => {
    expect(
      resolveCompositionPreviewScale({
        cardWidth: 80,
        cardHeight: 45,
        stageWidth: 0,
        stageHeight: Number.NaN,
      }),
    ).toBeCloseTo(80 / 1920);
  });
});

describe("resolveThumbnailSeekTime", () => {
  it("uses the default 3s frame for compositions longer than 3s", () => {
    expect(resolveThumbnailSeekTime(6)).toBe(3);
  });

  it("uses the midpoint for compositions shorter than 3s", () => {
    expect(resolveThumbnailSeekTime(2)).toBe(1);
  });

  it("falls back to the default 3s frame when duration is unknown", () => {
    expect(resolveThumbnailSeekTime(null)).toBe(3);
    expect(resolveThumbnailSeekTime(Number.NaN)).toBe(3);
  });
});

describe("syncIframePlayback", () => {
  it("mutes a composition-card preview before playing it", () => {
    const calls: string[] = [];
    const postMessage = vi.fn((message: { action: string }) => calls.push(message.action));
    const iframe = {
      src: "https://studio.test/api/projects/p/preview/comp/a.html",
      contentWindow: { postMessage },
      getRootNode: () => ({}),
    } as unknown as HTMLIFrameElement;

    expect(syncIframePlayback(iframe, true)).toBe(true);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ action: "set-muted", muted: true }),
      "https://studio.test",
    );
    expect(calls).toEqual(["set-muted", "play"]);
  });

  it("uses exact-origin controls for isolated composition hover", () => {
    const postMessage = vi.fn();
    const iframe = {
      src: "mpvfx://70.preview/api/projects/p/preview/comp/a.html",
      contentWindow: { postMessage },
      getRootNode: () => ({}),
    } as unknown as HTMLIFrameElement;

    expect(syncIframePlayback(iframe, true)).toBe(true);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ action: "set-muted", muted: true }),
      "mpvfx://70.preview",
    );
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ action: "play" }),
      "mpvfx://70.preview",
    );
    expect(syncIframePlayback(iframe, false, 2)).toBe(true);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ action: "seek", timeSeconds: 1 }),
      "mpvfx://70.preview",
    );
  });
});
