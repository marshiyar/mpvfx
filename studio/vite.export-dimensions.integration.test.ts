import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveInstalledMediaBinaryPaths } from "./desktop/installedMediaBinaries";
import { resizeStandaloneExport } from "./vite.export-dimensions";

const { ffmpegPath: ffmpeg, ffprobePath: ffprobe } = resolveInstalledMediaBinaryPaths();
const findBinary = (name: "ffmpeg" | "ffprobe") =>
  name === "ffmpeg" ? ffmpeg : ffprobe;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.runIf(Boolean(ffmpeg && ffprobe))("custom export FFmpeg integration", () => {
  it("creates a file with the requested dimensions instead of only accepting the setting", async () => {
    const root = mkdtempSync(join(tmpdir(), "studio-export-dimensions-"));
    roots.push(root);
    const inputPath = join(root, "native.mp4");
    const outputPath = join(root, "square.mp4");
    execFileSync(
      ffmpeg!,
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=320x180:r=1:d=1",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        inputPath,
      ],
      { stdio: "ignore" },
    );

    await resizeStandaloneExport(
      {
        format: "mp4",
        quality: "draft",
        inputPath,
        outputPath,
        dimensions: { width: 200, height: 200 },
      },
      { findBinary },
    );

    const probe = JSON.parse(
      execFileSync(ffprobe!, [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "json",
        outputPath,
      ]).toString("utf8"),
    ) as { streams?: Array<{ width?: number; height?: number }> };
    expect(probe.streams?.[0]).toMatchObject({ width: 200, height: 200 });
  }, 20_000);
});
