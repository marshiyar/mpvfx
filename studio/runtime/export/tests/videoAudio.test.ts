import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseAudioElements } from "@hyperframes/engine";
import { resolveInstalledMediaBinaryPaths } from "../../../desktop/installedMediaBinaries";
import { readProjectMediaMetadata } from "../../media/metadata";
import { createNativeProjectExportMaterialization } from "../nativeProject";
import { prepareExportVideoAudio } from "../videoAudio";
import { previewOriginForProject } from "../../../shared/desktopPreviewOrigin";

let root: string;
const binaries = resolveInstalledMediaBinaryPaths();
beforeAll(async () => {
  vi.stubEnv("HYPERFRAMES_FFPROBE_PATH", binaries.ffprobePath);
  vi.stubEnv("MPVFX_BUNDLED_MEDIA_ROOT", resolve("node_modules"));
  root = await mkdtemp(join(tmpdir(), "mpvfx-video-audio-"));
  await mkdir(join(root, "assets"));
  for (const extension of ["mp4", "mov", "m4v", "webm"]) {
    for (const audio of [false, true]) {
      execFileSync(binaries.ffmpegPath, ["-v", "error", "-f", "lavfi", "-i", "color=red:size=64x32:rate=10:duration=1",
        ...(audio ? ["-f", "lavfi", "-i", "sine=frequency=440:duration=1"] : []),
        "-c:v", extension === "webm" ? "libvpx-vp9" : "libx264", "-pix_fmt", "yuv420p",
        ...(audio ? ["-c:a", extension === "webm" ? "libopus" : "aac", "-shortest"] : []),
        join(root, `assets/${audio ? "sound" : "silent"}.${extension}`)]);
    }
  }
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });

async function scene(name: string, html: string) {
  const entryFile = `${name}.html`;
  await writeFile(join(root, entryFile), html);
  return { projectDir: root, entryFile };
}
const video = (id: string, src: string, extra = 'data-has-audio="true"') =>
  `<video id="${id}" src="${src}" data-start="0" data-duration="1" ${extra}></video>`;

describe("real media stream reconciliation", () => {
  it.each(["mp4", "mov", "m4v", "webm"])("keeps .%s pictures and genuine audio while removing only nonexistent video audio", async extension => {
    const html = `<html><body>${video("silent", `assets/silent.${extension}`)}${video("sound", `assets/sound.${extension}`)}</body></html>`;
    const input = await scene(extension, html);
    expect(await readProjectMediaMetadata(root, `assets/silent.${extension}`)).toMatchObject({ hasVideo: true, hasAudio: false });
    expect(await readProjectMediaMetadata(root, `assets/sound.${extension}`)).toMatchObject({ hasVideo: true, hasAudio: true });
    const overrides = await prepareExportVideoAudio(input);
    const staging = join(root, `staging-${extension}`);
    await mkdir(staging);
    const exported = createNativeProjectExportMaterialization(root, join(staging, "view"), staging, { htmlOverrides: overrides });
    const result = await readFile(join(exported, input.entryFile), "utf8");
    expect(parseAudioElements(result).map(element => element.src)).toEqual([`assets/sound.${extension}`]);
    expect((result.match(/<video /g) ?? [])).toHaveLength(2);
    expect(await readFile(join(root, input.entryFile), "utf8")).toBe(html);
  });

  it("preserves explicit video mute and explicit audio elements", async () => {
    const html = video("off", "assets/sound.mp4", 'data-has-audio="false"') +
      video("muted", "assets/sound.mov", 'data-has-audio="true" muted') +
      '<audio id="dialogue" src="assets/sound.mp4"></audio><audio id="invalid" src="assets/silent.mp4"></audio>';
    const input = await scene("mute", html);
    const overrides = await prepareExportVideoAudio(input);
    expect(parseAudioElements(overrides.get(input.entryFile)!).map(element => element.id)).toEqual(["dialogue", "invalid"]);
  });

  it("resolves nested compositions, source children, Unicode and URL escapes once per unique file", async () => {
    await mkdir(join(root, "compositions"));
    const name = "Khé¿ clip.mp4";
    await writeFile(join(root, "assets", name), await readFile(join(root, "assets/silent.mp4")));
    await writeFile(join(root, "compositions/child.html"),
      `<video id="nested"><source src="../assets/${encodeURIComponent(name)}?v=2#t=0"></video>`);
    const input = await scene("nested", '<div data-composition-src="compositions/child.html"></div>' +
      video("root", `/assets/${encodeURIComponent(name)}`));
    const probe = vi.fn(readProjectMediaMetadata);
    const overrides = await prepareExportVideoAudio({ ...input, probe });
    expect(overrides.size).toBe(2);
    expect(probe).toHaveBeenCalledTimes(1);
    for (const content of overrides.values()) expect(content).toContain('data-has-audio="false"');
  });

  it("does not scan unrelated compositions or rewrite genuine audio declarations", async () => {
    await writeFile(join(root, "unrelated.html"), video("missing", "assets/missing.mp4"));
    const input = await scene("audible", video("sound", "assets/sound.mp4"));
    expect((await prepareExportVideoAudio(input)).size).toBe(0);
  });

  it("resolves project-scoped preview URLs in disposable export materialization", async () => {
    const src = `${previewOriginForProject("demo")}/api/projects/demo/preview/assets/silent.mp4?revision=2`;
    const input = await scene("isolated-preview-source", video("silent", src));
    const overrides = await prepareExportVideoAudio(input);
    expect(overrides.get(input.entryFile)).toContain('data-has-audio="false"');
    expect(await readFile(join(root, input.entryFile), "utf8")).toContain(src);
  });

  it("does not guess missing or corrupt media is silent", async () => {
    const input = await scene("missing", video("missing", "assets/missing.mp4"));
    await expect(prepareExportVideoAudio(input)).rejects.toThrow("Export source is missing");
    await writeFile(join(root, "assets/broken.mp4"), "not a media file");
    const broken = await scene("broken", video("broken", "assets/broken.mp4"));
    await expect(prepareExportVideoAudio(broken)).rejects.toThrow();
  });

  it("rejects traversal, symlink escapes and cancellation", async () => {
    await expect(readProjectMediaMetadata(root, "../")).rejects.toThrow("inside this project");
    await symlink(process.execPath, join(root, "outside.mp4"));
    await expect(readProjectMediaMetadata(root, "outside.mp4")).rejects.toThrow("inside this project");
    const input = await scene("cancel", video("silent", "assets/silent.mp4"));
    await expect(prepareExportVideoAudio({ ...input, signal: AbortSignal.abort() })).rejects.toThrow();
  });
});
