import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeNativeVideoFrames } from "../videoFrames";
import { resolveInstalledMediaBinaryPaths } from "../../../desktop/installedMediaBinaries";

const { ffmpegPath: ffmpeg, ffprobePath: ffprobe } = resolveInstalledMediaBinaryPaths();
const binary = (name: "ffmpeg" | "ffprobe") => name === "ffmpeg" ? ffmpeg : ffprobe;
let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "native-frames-"));
  execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x32:rate=10:duration=1",
    "-c:v", "mpeg4", join(root, "clip.mp4")]);
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("bundled native video frame decoding", () => {
  it("decodes real media frames without an HTML document or browser", async () => {
    const result = await decodeNativeVideoFrames(root, {
      source: "clip.mp4", sourceStart: 0, sourceRangeDuration: 1, frameCount: 2, width: 120, height: 80,
    }, new AbortController().signal, binary);
    expect(result).toMatchObject({ aspect: 2, width: 120, height: 60 });
    expect(result.frames).toHaveLength(2);
    for (const frame of result.frames) expect(Buffer.from(frame, "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(result.frames[0]).not.toBe(result.frames[1]);
  });
  it("blocks media paths outside the owning project", async () => {
    await symlink(ffmpeg, join(root, "outside.mp4"));
    await expect(decodeNativeVideoFrames(root, {
      source: "outside.mp4", frameCount: 1, width: 120, height: 80,
    }, new AbortController().signal, binary)).rejects.toThrow("inside this project");
  });
  it("cancels before starting the native process", async () => {
    const abort = new AbortController(); abort.abort();
    await expect(decodeNativeVideoFrames(root, {
      source: "clip.mp4", frameCount: 1, width: 120, height: 80,
    }, abort.signal, binary)).rejects.toMatchObject({ name: "AbortError" });
  });
});
