import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAudioElements } from "@hyperframes/engine";
import { parseNativeProjectDocument, serializeNativeProjectDocument } from "../../../shared/project/nativeProjectDocument";
import { resolveInstalledMediaBinaryPaths } from "../../../desktop/installedMediaBinaries";
import { createProjectSignatureCache, createStandaloneAdapter } from "../../adapter";
import { mediaTimelineForExport } from "../mediaTimeline";

const producer = vi.hoisted(() => ({
  exports: [] as Array<{ html: string; audio: ReturnType<typeof parseAudioElements> }>,
}));
vi.mock("@hyperframes/producer", () => ({
  createRenderJob: () => ({}),
  executeRenderJob: async (_job: unknown, projectDir: string, outputPath: string) => {
    const html = readFileSync(join(projectDir, "index.html"), "utf8");
    producer.exports.push({ html, audio: parseAudioElements(html) });
    writeFileSync(outputPath, "producer completed");
  },
}));

const binaries = resolveInstalledMediaBinaryPaths();
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  producer.exports.length = 0;
  vi.unstubAllEnvs();
});

describe.runIf(Boolean(binaries.ffmpegPath && binaries.ffprobePath))("grouped video export dispatch", () => {
  it("keeps the legacy scene on Producer and routes its video sound through the native bus", async () => {
    const root = mkdtempSync(join(tmpdir(), "mpvfx-group-dispatch-"));
    roots.push(root);
    mkdirSync(join(root, ".studio"));
    mkdirSync(join(root, "assets"));
    execFileSync(binaries.ffmpegPath!, ["-v", "error", "-f", "lavfi", "-i", "color=red:size=64x32:rate=10:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", join(root, "assets", "clip.mp4")]);
    const html = '<html><body><div data-composition-id="main" data-width="64" data-height="32" data-duration="1"><p>Keep this title</p><video id="camera" src="assets/clip.mp4" data-start="0" data-duration="1" data-has-audio="true" data-audio-group="bus"></video></div><hf-audio-group id="bus" data-volume="0.933254"></hf-audio-group></body></html>';
    writeFileSync(join(root, "index.html"), html);
    const project = parseNativeProjectDocument({
      schemaVersion: 1, id: "group-export", revision: 1,
      frameRate: { numerator: 10, denominator: 1 }, canvas: { width: 64, height: 32, background: "#000000" },
      assets: [{ id: "asset", kind: "video", name: "clip.mp4", source: "assets/clip.mp4", durationFrames: 10 }],
      sequence: { id: "sequence", name: "Sequence", audioGroups: [{ id: "bus", volume: 0.933254 }], tracks: [
        { id: "video", kind: "video", clips: [{ id: "clip", assetId: "asset", binding: { sourceFile: "index.html", domId: "camera" },
          startFrame: 0, durationFrames: 10, sourceInFrame: 0, muted: false, audioGroupId: "bus", effects: [], parameterTracks: [] }] },
      ] },
    });
    writeFileSync(join(root, ".studio", "project.json"), serializeNativeProjectDocument(project));
    expect(mediaTimelineForExport(project, html)).toBeNull();
    vi.stubEnv("HYPERFRAMES_FFPROBE_PATH", binaries.ffprobePath!);
    vi.stubEnv("HYPERFRAMES_FFMPEG_PATH", binaries.ffmpegPath!);
    vi.stubEnv("MPVFX_BUNDLED_MEDIA_ROOT", resolve("node_modules"));
    const adapter = createStandaloneAdapter(root, {
      studioDir: resolve("."), loadModule: async () => { throw new Error("Unexpected compiler load"); },
    }, createProjectSignatureCache());
    const outputPath = join(root, "render.mp4");
    const job = adapter.startRender({ project: { id: "group-export", dir: root }, outputPath,
      format: "mp4", fps: { num: 10, den: 1 }, quality: "draft", jobId: "group-dispatch" });
    await vi.waitFor(() => expect(job.status).not.toBe("rendering"), { timeout: 10_000 });
    expect(job.error).toBeUndefined();
    expect(job.status).toBe("complete");
    expect(producer.exports).toHaveLength(1);
    expect(producer.exports[0]!.html).toContain("<p>Keep this title</p>");
    expect(producer.exports[0]!.html).toContain('id="camera"');
    expect(producer.exports[0]!.html).toContain('data-has-audio="false"');
    expect(producer.exports[0]!.audio).toHaveLength(1);
    expect(producer.exports[0]!.audio[0]).toMatchObject({
      type: "audio", groupId: "bus", groupVolume: 0.933254, src: "assets/clip.mp4", start: 0, end: 1,
    });
    expect(readFileSync(join(root, "index.html"), "utf8")).toBe(html);

    const native = parseNativeProjectDocument(project);
    native.mediaEngine = "ffmpeg";
    delete native.sequence.tracks[0]!.clips[0]!.binding;
    writeFileSync(join(root, ".studio", "project.json"), serializeNativeProjectDocument(native));
    const nativeOutput = join(root, "native.mp4");
    const nativeJob = adapter.startRender({ project: { id: "group-export", dir: root }, outputPath: nativeOutput,
      format: "mp4", fps: { num: 10, den: 1 }, quality: "draft", jobId: "native-dispatch" });
    await vi.waitFor(() => expect(nativeJob.status).not.toBe("rendering"), { timeout: 10_000 });
    expect(nativeJob.error).toBeUndefined();
    expect(nativeJob.status).toBe("complete");
    expect(readFileSync(nativeOutput).byteLength).toBeGreaterThan(0);
    expect(producer.exports).toHaveLength(1);
  });
});
