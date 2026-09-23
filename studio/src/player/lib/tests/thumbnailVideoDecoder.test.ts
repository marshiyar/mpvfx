// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeVideoThumbnail } from "../thumbnailVideoDecoder";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../../../lib/desktopClient", () => ({ desktopRequest: request }));
const source = "mpvfx://editor/api/projects/demo/preview/assets/clip%20one.mov";
beforeEach(() => {
  request.mockReset().mockResolvedValue(Response.json({ frames: ["ZnJhbWU="], aspect: 2, width: 240, height: 120 }));
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:frame");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("native video thumbnails", () => {
  it("sends a media path to the native decoder and releases returned images", async () => {
    const signal = new AbortController().signal;
    const result = await decodeVideoThumbnail({ source, frameCount: 1, sourceStart: 2 }, signal);
    expect(request).toHaveBeenCalledWith("/api/projects/demo/media/frames", expect.objectContaining({ method: "POST", signal }));
    expect(JSON.parse(request.mock.calls[0][1].body)).toMatchObject({ source: "assets/clip one.mov", frameCount: 1, sourceStart: 2 });
    expect(result.value).toEqual({ kind: "image", url: "blob:frame", aspect: 2 });
    result.dispose?.(); result.dispose?.();
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
  });
  it("returns a filmstrip without creating a browser video decoder", async () => {
    request.mockResolvedValue(Response.json({ frames: ["YQ==", "Yg=="], aspect: 2, width: 240, height: 120 }));
    const result = await decodeVideoThumbnail({ source, frameCount: 2 }, new AbortController().signal);
    expect(result.value).toMatchObject({ kind: "filmstrip", urls: ["blob:frame", "blob:frame"] });
    result.dispose?.();
  });
  it("does not dispatch cancelled work", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(decodeVideoThumbnail({ source, frameCount: 1 }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(request).not.toHaveBeenCalled();
  });
  it("rejects a media address from a different project", async () => {
    await expect(decodeVideoThumbnail({ source, projectId: "other", frameCount: 1 }, new AbortController().signal)).rejects.toThrow("different project");
    expect(request).not.toHaveBeenCalled();
  });
  it("surfaces native decoder failures", async () => {
    request.mockResolvedValue(new Response(null, { status: 500 }));
    await expect(decodeVideoThumbnail({ source, frameCount: 1 }, new AbortController().signal)).rejects.toThrow("Native frame decoding failed");
  });
  it("decodes completed exports through the native render directory", async () => {
    await decodeVideoThumbnail({ source: "/api/projects/demo/renders/file/output.mp4", frameCount: 1 }, new AbortController().signal);
    expect(JSON.parse(request.mock.calls[0][1].body)).toMatchObject({ source: "output.mp4", location: "render" });
  });
});
