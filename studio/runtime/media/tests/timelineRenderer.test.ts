import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveInstalledMediaBinaryPaths } from "../../../desktop/installedMediaBinaries";
import { parseNativeProjectDocument, type NativeProjectDocument } from "../../../shared/project/nativeProjectDocument";
import { renderNativeTimeline } from "../timelineRenderer";
import { createStandaloneAdapter, createProjectSignatureCache } from "../../adapter";

const { ffmpegPath: ffmpeg, ffprobePath: ffprobe } = resolveInstalledMediaBinaryPaths();
const binary = (name: "ffmpeg" | "ffprobe") => name === "ffmpeg" ? ffmpeg : ffprobe;
let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "native-timeline-"));
  for (const [color, frequency] of [["red", 440], ["blue", 880]] as const) {
    const picture = color === "red"
      ? "color=c=red:size=64x32:rate=10:duration=1[r];color=c=yellow:size=64x32:rate=10:duration=1[y];[r][y]concat=n=2:v=1:a=0"
      : "color=c=blue:size=64x32:rate=10:duration=2";
    execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", picture,
      "-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=48000:duration=2`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(root, `${color}.mp4`)]);
  }
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

function project(): NativeProjectDocument {
  return parseNativeProjectDocument({
    schemaVersion: 1, mediaEngine: "ffmpeg", id: "test", revision: 0,
    frameRate: { numerator: 10, denominator: 1 },
    canvas: { width: 64, height: 32, background: "#000000" },
    assets: ["red", "blue"].map(name => ({ id: name, kind: "video", name, source: `${name}.mp4`, durationFrames: 20 })),
    sequence: { id: "sequence", name: "Sequence", tracks: [{ id: "video", kind: "video", clips: [
      { id: "red", assetId: "red", startFrame: 0, durationFrames: 5, sourceInFrame: 5, playbackRate: { numerator: 2, denominator: 1 }, muted: false, effects: [], parameterTracks: [] },
      { id: "blue", assetId: "blue", startFrame: 10, durationFrames: 5, sourceInFrame: 0, muted: true, effects: [], parameterTracks: [] },
    ] }] },
  });
}
function frame(path: string, seconds: number): number[] {
  return [...execFileSync(ffmpeg, ["-v", "error", "-ss", String(seconds), "-i", path,
    "-frames:v", "1", "-vf", "scale=1:1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"])];
}
function rms(path: string, seconds: number): number {
  const bytes = execFileSync(ffmpeg, ["-v", "error", "-ss", String(seconds), "-i", path, "-t", "0.1", "-vn", "-ac", "1", "-f", "f32le", "pipe:1"]);
  let sum = 0;
  for (let index = 0; index < bytes.length; index += 4) sum += bytes.readFloatLE(index) ** 2;
  return Math.sqrt(sum / (bytes.length / 4));
}

describe("native timeline rendering from project data", () => {
  it("exports cuts, source trims, speed, gaps, and mute with no HTML file", async () => {
    const outputPath = join(root, "cuts.mp4");
    await renderNativeTimeline({ project: project(), projectDir: root, outputPath, format: "mp4" }, binary);
    expect(frame(outputPath, 0.2)[0]).toBeGreaterThan(220);
    expect(frame(outputPath, 0.2)[1]).toBeLessThan(12);
    expect(frame(outputPath, 0.4)[1]).toBeGreaterThan(220); // Source trim + 2x speed crosses into yellow at timeline frame 3.
    expect(frame(outputPath, 0.7).every(channel => channel < 8)).toBe(true);
    expect(frame(outputPath, 1.2)[2]).toBeGreaterThan(220);
    expect(rms(outputPath, 0.2)).toBeGreaterThan(0.01);
    expect(rms(outputPath, 0.7)).toBeLessThan(0.001);
    expect(rms(outputPath, 1.2)).toBeLessThan(0.001);
    const metadata = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-show_entries", "format=duration:stream=nb_frames,avg_frame_rate,width,height", "-of", "json", outputPath]).toString());
    expect(metadata.streams[0]).toMatchObject({ width: 64, height: 32, nb_frames: "15", avg_frame_rate: "10/1" });
    expect(Number(metadata.format.duration)).toBeCloseTo(1.5, 1);
  });

  it("runs through the application's export coordinator with only media and JSON", async () => {
    await mkdir(join(root, ".studio"));
    await writeFile(join(root, ".studio", "project.json"), JSON.stringify(project()));
    vi.stubEnv("HYPERFRAMES_FFMPEG_PATH", ffmpeg);
    vi.stubEnv("HYPERFRAMES_FFPROBE_PATH", ffprobe);
    vi.stubEnv("MPVFX_BUNDLED_MEDIA_ROOT", resolve("node_modules"));
    let close: (() => void) | undefined;
    try {
      const adapter = createStandaloneAdapter(root, {
        studioDir: resolve("."),
        loadModule: async () => { throw new Error("A media export must not load an HTML compiler"); },
        onClose: listener => { close = listener; },
      }, createProjectSignatureCache());
      const outputPath = join(root, "coordinator.mp4");
      const job = adapter.startRender({ project: { id: "test", dir: root }, outputPath, format: "mp4", fps: { num: 30, den: 1 }, quality: "draft", jobId: "native-export" });
      await vi.waitFor(() => expect(job.status).not.toBe("rendering"), { timeout: 5000 });
      expect(job.error).toBeUndefined();
      expect(job.status).toBe("complete");
      expect(frame(outputPath, 1.2)[2]).toBeGreaterThan(220);
    } finally { close?.(); vi.unstubAllEnvs(); }
  });

  it("composites layers with opacity and outputs the requested dimensions", async () => {
    const document = project();
    document.sequence.tracks[0].clips = [{ ...document.sequence.tracks[0].clips[0], durationFrames: 10, sourceInFrame: 0, playbackRate: { numerator: 1, denominator: 1 }, muted: true }];
    document.sequence.tracks.push({ id: "overlay", kind: "video", lane: { authoredTrack: 1, displayTrack: 1 }, clips: [
      { ...document.sequence.tracks[0].clips[0], id: "overlay", assetId: "blue", staticParameters: { "visual.opacity": 0.5 } },
    ] });
    const outputPath = join(root, "layers.mp4");
    await renderNativeTimeline({ project: document, projectDir: root, outputPath, format: "mp4", outputDimensions: { width: 128, height: 64 } }, binary);
    const color = frame(outputPath, 0.4);
    expect(color[0]).toBeGreaterThan(110); expect(color[0]).toBeLessThan(145);
    expect(color[2]).toBeGreaterThan(110); expect(color[2]).toBeLessThan(145);
    expect(color[1]).toBeLessThan(12);
  });

  it("does not omit an unsupported effect", async () => {
    const document = project();
    document.sequence.tracks[0].clips[0].effects.push({ id: "grade", effectId: "legacy-grade", enabled: true });
    await expect(renderNativeTimeline({ project: document, projectDir: root, outputPath: join(root, "unsupported.mp4"), format: "mp4" }, binary)).rejects.toThrow("effects that have not been migrated");
  });

  it("does not overwrite an existing output", async () => {
    const outputPath = join(root, "existing.mp4");
    await writeFile(outputPath, "keep");
    await expect(renderNativeTimeline({ project: project(), projectDir: root, outputPath, format: "mp4" }, binary)).rejects.toThrow();
    expect(await readFile(outputPath, "utf8")).toBe("keep");
  });

  it("rejects a media symlink escaping the project", async () => {
    await symlink(ffmpeg, join(root, "escape.mp4"));
    const document = project(); document.assets[0].source = "escape.mp4";
    await expect(renderNativeTimeline({ project: document, projectDir: root, outputPath: join(root, "escape-output.mp4"), format: "mp4" }, binary)).rejects.toThrow("inside its project");
  });

  it("honors cancellation before starting any render", async () => {
    const abort = new AbortController(); abort.abort();
    await expect(renderNativeTimeline({ project: project(), projectDir: root, outputPath: join(root, "cancelled.mp4"), format: "mp4", signal: abort.signal }, binary)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("stops an active native encode when its owning job is cancelled", async () => {
    const document = project();
    document.sequence.tracks = [];
    document.canvas = { width: 1920, height: 1080, background: "#000000" };
    document.sequence.durationFrames = 100_000;
    const abort = new AbortController();
    await expect(renderNativeTimeline({
      project: document, projectDir: root, outputPath: join(root, "cancelled-active.mp4"),
      format: "mp4", signal: abort.signal, onProgress: () => abort.abort(),
    }, binary)).rejects.toMatchObject({ name: "AbortError" });
  }, 10_000);

  it("refuses source ranges longer than the actual media", async () => {
    const document = project();
    document.assets[0].durationFrames = 100;
    document.sequence.tracks[0].clips[0].sourceInFrame = 50;
    await expect(renderNativeTimeline({ project: document, projectDir: root, outputPath: join(root, "short-media.mp4"), format: "mp4" }, binary)).rejects.toThrow("extends beyond its media file");
  });

  it.each(["webm", "mov"] as const)("encodes a native timeline as %s", async format => {
    const document = project();
    const outputPath = join(root, `format.${format}`);
    await renderNativeTimeline({ project: document, projectDir: root, outputPath, format, quality: "draft" }, binary);
    expect(frame(outputPath, 1.2)[2]).toBeGreaterThan(220);
    expect(rms(outputPath, 1.2)).toBeLessThan(0.001);
  });
});
