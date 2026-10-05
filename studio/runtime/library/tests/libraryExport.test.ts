import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { LibraryService } from "../libraryService";
import { createStudioRuntime, type StudioRuntime } from "../../service";
import { resolveInstalledMediaBinaryPaths } from "../../../desktop/installedMediaBinaries";
let root: string, library: LibraryService, runtime: StudioRuntime;
afterEach(async () => {
  await runtime?.close();
  await library?.close();
  if (root) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
it("exports two real library projects from isolated revisions while their live media changes", async () => {
  const binaries = resolveInstalledMediaBinaryPaths();
  vi.stubEnv("HYPERFRAMES_FFMPEG_PATH", binaries.ffmpegPath);
  vi.stubEnv("HYPERFRAMES_FFPROBE_PATH", binaries.ffprobePath);
  vi.stubEnv("MPVFX_BUNDLED_MEDIA_ROOT", resolve("node_modules"));
  root = await mkdtemp(join(tmpdir(), "mpvfx-library-export-"));
  library = new LibraryService(
    join(root, "settings"),
    fileURLToPath(
      new URL(
        "../../../.build/native/library/mpvfx_library.node",
        import.meta.url,
      ),
    ),
  );
  const libraryId = await library.create(join(root, "Film.mpvfxlibrary")),
    eventId = (await library.views())[0]!.events[0]!.id;
  const first = await library.createProject(libraryId, eventId, "Main"),
    second = await library.createProject(libraryId, eventId, "Short");
  const source = join(root, "source.mp4");
  execFileSync(binaries.ffmpegPath, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=red:size=64x32:rate=10:duration=2",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    source,
  ]);
  const imported = await library.import(
    libraryId,
    eventId,
    [source],
    "managed",
  );
  expect(imported.invalid).toEqual([]);
  const assetId = imported.files[0]!;
  for (const projectId of [first, second]) {
    const path = await library.attach(libraryId, projectId, assetId),
      dir = library.resolveProject(projectId)!.dir;
    await mkdir(join(dir, ".studio"), { recursive: true });
    await writeFile(
      join(dir, ".studio/project.json"),
      JSON.stringify({
        schemaVersion: 1,
        mediaEngine: "ffmpeg",
        id: projectId,
        revision: 3,
        frameRate: { numerator: 10, denominator: 1 },
        canvas: { width: 64, height: 32, background: "#000000" },
        assets: [
          {
            id: assetId,
            kind: "video",
            name: "Source",
            source: path,
            durationFrames: 20,
          },
        ],
        sequence: {
          id: "main",
          name: "Main",
          tracks: [
            {
              id: "video",
              kind: "video",
              clips: [
                {
                  id: "clip",
                  assetId,
                  startFrame: 0,
                  durationFrames: projectId === first ? 10 : 5,
                  sourceInFrame: 0,
                  muted: false,
                  effects: [],
                  parameterTracks: [],
                },
              ],
            },
          ],
        },
      }),
    );
  }
  await mkdir(join(root, "legacy"), { recursive: true });
  runtime = createStudioRuntime({
    projectsDir: join(root, "legacy"),
    libraries: library,
    adapterHost: {
      studioDir: resolve("."),
      loadModule: async <T>(s: string) =>
        import(s.startsWith("/") ? pathToFileURL(s).href : s) as Promise<T>,
    },
  });
  const projects = await (
    await runtime.handle(new Request("mpvfx://editor/api/projects"))
  ).json();
  expect(projects.projects.map((p: { id: string }) => p.id)).toEqual(
    expect.arrayContaining([first, second, "MpVFX"]),
  );
  for (const projectId of [first, second]) {
    const response = await runtime.handle(
      new Request(`mpvfx://editor/api/projects/${projectId}/render`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ format: "mp4", fps: 30, quality: "draft" }),
      }),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await response.json()).persistent).toBe(true);
    const dir = library.resolveProject(projectId)!.dir,
      document = JSON.parse(
        await readFile(join(dir, ".studio/project.json"), "utf8"),
      );
    await writeFile(
      join(dir, document.assets[0].source),
      "changed after snapshot",
    );
    document.sequence.tracks[0].clips = [];
    await writeFile(
      join(dir, ".studio/project.json"),
      JSON.stringify(document),
    );
  }
  await vi.waitFor(
    async () => {
      const jobs = (await library.views())[0]!.jobs;
      expect(jobs).toHaveLength(2);
      expect(jobs.map((j) => ({ status: j.status, error: j.error }))).toEqual([
        { status: "complete", error: "" },
        { status: "complete", error: "" },
      ]);
    },
    { timeout: 20000, interval: 100 },
  );
  for (const job of (await library.views())[0]!.jobs) {
    const metadata = JSON.parse(
      execFileSync(binaries.ffprobePath, [
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_type,width,height",
        "-of",
        "json",
        job.output,
      ]).toString(),
    );
    expect(metadata.streams).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ codec_type: "video", width: 64, height: 32 }),
        expect.objectContaining({ codec_type: "audio" }),
      ]),
    );
    expect(Number(metadata.format.duration)).toBeCloseTo(
      job.projectId === first ? 1 : 0.5,
      1,
    );
    const pixel = [
      ...execFileSync(binaries.ffmpegPath, [
        "-v",
        "error",
        "-ss",
        "0.2",
        "-i",
        job.output,
        "-frames:v",
        "1",
        "-vf",
        "scale=1:1",
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        "pipe:1",
      ]),
    ];
    expect(pixel[0]).toBeGreaterThan(220);
    expect(pixel[1]).toBeLessThan(20);
  }
}, 30000);
