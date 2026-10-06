import { describe, expect, it } from "vitest";
import { nativeMediaSource } from "./nativeMediaSource";

describe("portable native media paths", () => {
  it("removes the editor transport without keeping its project ID or URL encoding", () => {
    expect(nativeMediaSource("mpvfx://editor/api/projects/demo/preview/assets/clip%20one.mov?revision=3", "demo")).toBe("assets/clip one.mov");
  });
  it("retains plain filenames, including literal percent signs", () => {
    expect(nativeMediaSource("./assets/100% final.mov", "demo")).toBe("assets/100% final.mov");
  });
  it("normalizes path aliases without folding case or decoding literal path characters", () => {
    expect(nativeMediaSource("./assets//./camera.mov", "demo")).toBe("assets/camera.mov");
    expect(nativeMediaSource("assets\\camera.mov", "demo")).toBe("assets/camera.mov");
    expect(nativeMediaSource("assets/Camera%20A.mov", "demo")).toBe("assets/Camera%20A.mov");
    expect(nativeMediaSource("assets/Camera A.mov", "demo")).toBe("assets/Camera A.mov");
  });
  it.each([".", "././", "assets/", "assets/.", "./../clip.mov"])("rejects non-file paths: %s", source => {
    expect(nativeMediaSource(source, "demo")).toBeNull();
  });
  it.each(["../outside.mov", "/outside.mov", "C:\\outside.mov", "https://example.com/clip.mov", "mpvfx://editor/api/projects/other/preview/clip.mov", "mpvfx://editor/api/projects/demo/preview/%2e%2e/outside.mov"])("rejects sources outside the owning project: %s", source => {
    expect(nativeMediaSource(source, "demo")).toBeNull();
  });
});
