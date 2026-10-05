import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveInstalledMediaBinaryPaths } from "../../../desktop/installedMediaBinaries";
import { applyBundledMediaBinaryEnvironment } from "../../../desktop/runtimeBinaries";
import { analyzeProjectMediaSilence } from "../silenceAnalysis";

const { ffmpegPath: ffmpeg, ffprobePath: ffprobe } = resolveInstalledMediaBinaryPaths();
const previousEnvironment = {
  ffmpeg: process.env.HYPERFRAMES_FFMPEG_PATH,
  ffprobe: process.env.HYPERFRAMES_FFPROBE_PATH,
  root: process.env.MPVFX_BUNDLED_MEDIA_ROOT,
};
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "mpvfx-silence-"));
  applyBundledMediaBinaryEnvironment({ ffmpegPath: ffmpeg, ffprobePath: ffprobe });
  const rate = 16_000;
  const samples = Buffer.alloc(rate * 3 * 2);
  for (let index = 0; index < rate * 3; index++) {
    const active = index < rate || index >= rate * 2;
    samples.writeInt16LE(active ? Math.round(Math.sin(index * 2 * Math.PI * 440 / rate) * 12000) : 0, index * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + samples.length, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(samples.length, 40);
  await writeFile(join(root, "speech.wav"), Buffer.concat([header, samples]));
  execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=30:d=3",
    "-i", join(root, "speech.wav"), "-c:v", "mpeg4", "-c:a", "aac", "-shortest", join(root, "speech.mp4")]);
  execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=30:d=1",
    "-c:v", "mpeg4", join(root, "mute.mp4")]);
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  for (const [key, value] of [
    ["HYPERFRAMES_FFMPEG_PATH", previousEnvironment.ffmpeg],
    ["HYPERFRAMES_FFPROBE_PATH", previousEnvironment.ffprobe],
    ["MPVFX_BUNDLED_MEDIA_ROOT", previousEnvironment.root],
  ] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

describe("media silence analysis with bundled media binaries", () => {
  it("finds a real pause in an MP4 and keeps source-time offsets", async () => {
    const ranges = await analyzeProjectMediaSilence(root, {
      source: "speech.mp4", sourceStart: 0.5, sourceDuration: 2,
    }, new AbortController().signal);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]!.start).toBeGreaterThan(1.05);
    expect(ranges[0]!.start).toBeLessThan(1.25);
    expect(ranges[0]!.end).toBeGreaterThan(1.75);
    expect(ranges[0]!.end).toBeLessThan(1.95);
  });

  it("rejects a video without audio and project-escaping symlinks", async () => {
    const signal = new AbortController().signal;
    await expect(analyzeProjectMediaSilence(root, {
      source: "mute.mp4", sourceStart: 0, sourceDuration: 1,
    }, signal)).rejects.toThrow("no audio track");
    await symlink(ffmpeg, join(root, "escape.mp4"));
    await expect(analyzeProjectMediaSilence(root, {
      source: "escape.mp4", sourceStart: 0, sourceDuration: 1,
    }, signal)).rejects.toThrow("inside this project");
  });

  it("finds the same pause in an audio-only WAV and keeps source-time offsets", async () => {
    const ranges = await analyzeProjectMediaSilence(root, {
      source: "speech.wav", sourceStart: 0.5, sourceDuration: 2,
    }, new AbortController().signal);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]!.start).toBeGreaterThan(1.05);
    expect(ranges[0]!.start).toBeLessThan(1.25);
    expect(ranges[0]!.end).toBeGreaterThan(1.75);
    expect(ranges[0]!.end).toBeLessThan(1.95);
  });
});
