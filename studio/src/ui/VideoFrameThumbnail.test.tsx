// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VideoFrameThumbnail } from "./VideoFrameThumbnail";
import { decodeVideoThumbnail } from "../player/lib/thumbnailVideoDecoder";

vi.mock("../player/lib/thumbnailVideoDecoder", () => ({ decodeVideoThumbnail: vi.fn() }));
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); root = createRoot(host);
  vi.mocked(decodeVideoThumbnail).mockReset();
});
afterEach(async () => { await act(async () => root.unmount()); });

describe("native asset poster lifecycle", () => {
  it("displays the native frame and duration and releases it on source changes", async () => {
    const dispose = vi.fn();
    const onDuration = vi.fn();
    vi.mocked(decodeVideoThumbnail).mockResolvedValue({ value: { kind: "image", url: "blob:poster", aspect: 2 }, weight: 100, duration: 2.5, dispose });
    await act(async () => root.render(<VideoFrameThumbnail src="mpvfx://editor/api/projects/p/preview/clip.mov" onDuration={onDuration} />));
    expect(host.querySelector("img")?.getAttribute("src")).toBe("blob:poster");
    expect(onDuration).toHaveBeenCalledWith(2.5);
    const signal = vi.mocked(decodeVideoThumbnail).mock.calls[0][1];
    vi.mocked(decodeVideoThumbnail).mockRejectedValue(new Error("bad media"));
    await act(async () => root.render(<VideoFrameThumbnail src="mpvfx://editor/api/projects/p/preview/missing.mov" onDuration={onDuration} />));
    expect(signal.aborted).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain("VIDEO");
  });

  it("releases late results after unmount without keeping a stale poster", async () => {
    let complete!: (value: Awaited<ReturnType<typeof decodeVideoThumbnail>>) => void;
    vi.mocked(decodeVideoThumbnail).mockReturnValue(new Promise(resolve => { complete = resolve; }));
    await act(async () => root.render(<VideoFrameThumbnail src="/api/projects/p/preview/clip.mov" />));
    await act(async () => root.render(null));
    const dispose = vi.fn();
    await act(async () => complete({ value: { kind: "image", url: "blob:late", aspect: 2 }, weight: 100, dispose }));
    expect(dispose).toHaveBeenCalledOnce();
    expect(host.querySelector("img")).toBeNull();
  });
});
