import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveInstalledMediaBinaryPaths } from "./desktop/installedMediaBinaries";
import { tryDirectMediaExport } from "./vite.direct-media-export";

const { ffmpegPath: ffmpeg, ffprobePath: ffprobe } = resolveInstalledMediaBinaryPaths();
const findBinary = (name: "ffmpeg" | "ffprobe") =>
  name === "ffmpeg" ? ffmpeg : ffprobe;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.runIf(Boolean(ffmpeg && ffprobe))("direct media FFmpeg integration", () => {
  it("publishes a playable browser-free CFR transcode with normalized audio", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "studio-direct-media-"));
    roots.push(projectDir);
    mkdirSync(join(projectDir, "assets"));
    const sourcePath = join(projectDir, "assets", "clip.mp4");
    const outputPath = join(projectDir, "staging.mp4");
    execFileSync(
      ffmpeg!,
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=320x180:r=24:d=1",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=1",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        sourcePath,
      ],
      { stdio: "ignore" },
    );
    const sourceProbe = JSON.parse(
      execFileSync(ffprobe!, [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        sourcePath,
      ]).toString("utf8"),
    ) as { format: { duration: string } };
    const duration = Number(sourceProbe.format.duration);
    const html = `<!doctype html><html><body><div data-composition-id="main" data-start="0" data-duration="${duration}" data-width="320" data-height="180"><video id="clip" class="clip" src="assets/clip.mp4" data-start="0" data-duration="${duration}" data-track-index="0" playsinline style="position:absolute;left:0px;top:0px;width:320px;height:180px;object-fit:contain;z-index:1"></video></div></body></html>`;

    await expect(
      tryDirectMediaExport(
        {
          html,
          projectDir,
          outputPath,
          format: "mp4",
          fps: 30,
          quality: "standard",
          dimensions: { width: 320, height: 180 },
          outputDimensions: { width: 400, height: 400 },
        },
        { findBinary },
      ),
    ).resolves.toBe(true);

    expect(readFileSync(outputPath).byteLength).toBeGreaterThan(0);
    const outputProbe = JSON.parse(
      execFileSync(ffprobe!, [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,codec_name,width,height,avg_frame_rate,sample_rate,channels",
        "-of",
        "json",
        outputPath,
      ]).toString("utf8"),
    ) as { streams: Array<Record<string, unknown>> };
    expect(outputProbe.streams).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          codec_type: "video",
          codec_name: "h264",
          width: 400,
          height: 400,
          avg_frame_rate: "30/1",
        }),
        expect.objectContaining({
          codec_type: "audio",
          codec_name: "aac",
          sample_rate: "48000",
          channels: 2,
        }),
      ]),
    );
  }, 20_000);
});
