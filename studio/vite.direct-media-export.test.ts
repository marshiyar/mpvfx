import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  tryDirectMediaExport,
  type DirectMediaProbe,
} from "./vite.direct-media-export";

const probe: DirectMediaProbe = {
  duration: 5,
  streams: [
    { codecType: "video", codecName: "h264", width: 1920, height: 1080, frameRate: 30 },
    { codecType: "audio", codecName: "aac" },
  ],
};

function source(overrides: {
  rootDuration?: string;
  videoDuration?: string;
  videoAttributes?: string;
  videoStyle?: string;
  rootContent?: string;
  headExtra?: string;
  bodyExtra?: string;
  src?: string;
  rootAttributes?: string;
  bodyAttributes?: string;
} = {}): string {
  const video = `<video id="clip" data-hf-id="clip" class="clip" src="${overrides.src ?? "assets/clip.mov"}" data-start="0" data-duration="${overrides.videoDuration ?? "5"}" data-track-index="0" playsinline style="${overrides.videoStyle ?? "position: absolute; left: 0px; top: 0px; width: 1920px; height: 1080px; object-fit: contain; z-index: 1"}" ${overrides.videoAttributes ?? ""}></video>`;
  return `<!doctype html><html><head><style>html, body { width: 1920px; height: 1080px; margin: 0; overflow: hidden; background: black; } #root { position: relative; width: 1920px; height: 1080px; overflow: hidden; }</style>${overrides.headExtra ?? '<script src="vendor/gsap.min.js"></script>'}</head><body ${overrides.bodyAttributes ?? ""}><div id="root" data-hf-id="hf-root" data-composition-id="main" data-start="0" data-duration="${overrides.rootDuration ?? "5"}" data-width="1920" data-height="1080" ${overrides.rootAttributes ?? ""}>${overrides.rootContent ?? video}</div>${overrides.bodyExtra ?? '<script>window.__timelines = window.__timelines || {}; window.__timelines["main"] = gsap.timeline({ paused: true });</script>'}</body></html>`;
}

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kills: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals) {
    this.kills.push(signal);
    return true;
  }
}

async function projectFile(): Promise<{ projectDir: string; outputPath: string }> {
  const projectDir = await mkdtemp(join(tmpdir(), "studio-direct-export-"));
  await mkdir(join(projectDir, "assets"));
  await writeFile(join(projectDir, "assets", "clip.mov"), "media");
  return { projectDir, outputPath: join(projectDir, "staging.mp4") };
}

function spawnThatCloses(child = new FakeChild()) {
  const spawnProcess = vi.fn(() => {
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  });
  return { child, spawnProcess };
}

describe("direct media export eligibility", () => {
  it("transcodes one exact full-canvas video directly with the selected quality", async () => {
    const paths = await projectFile();
    const { spawnProcess } = spawnThatCloses();
    const onProgress = vi.fn();

    await expect(
      tryDirectMediaExport(
        {
          ...paths,
          html: source(),
          format: "mp4",
          fps: 30,
          quality: "standard",
          dimensions: { width: 1920, height: 1080 },
          onProgress,
        },
        {
          findBinary: (name) => `/opt/${name}`,
          probeMedia: vi.fn(async () => probe),
          detectGpuEncoder: vi.fn(async () => "videotoolbox"),
          spawnProcess: spawnProcess as never,
        },
      ),
    ).resolves.toBe(true);

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnProcess.mock.calls[0]!;
    expect(command).toBe("/opt/ffmpeg");
    expect(args).toEqual(expect.arrayContaining([
      "-map", "0:v:0", "-map", "0:a:0?",
      "-c:v", "h264_videotoolbox", "-q:v", "64",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
      "-r", "30",
      "-fps_mode", "cfr",
    ]));
    expect(args).not.toContain("copy");
    expect(args.at(-1)).toBe(paths.outputPath);
    expect(options).toMatchObject({ shell: false, stdio: ["ignore", "ignore", "pipe"] });
    expect(onProgress).toHaveBeenNthCalledWith(1, 0);
    expect(onProgress).toHaveBeenLastCalledWith(100);
  });

  it.each([
    ["explicit zero playback offset and normal rate", 'data-playback-start="0" data-playback-rate="1"'],
    ["legacy explicit zero media offset", 'data-media-start="0"'],
  ])("accepts %s", async (_name, videoAttributes) => {
    const paths = await projectFile();
    const { spawnProcess } = spawnThatCloses();
    await expect(
      tryDirectMediaExport(
        { ...paths, html: source({ videoAttributes }), format: "mp4", fps: 30, dimensions: { width: 1920, height: 1080 } },
        {
          findBinary: () => "/opt/bin",
          probeMedia: vi.fn(async () => ({ ...probe, streams: [probe.streams[0]!] })),
          detectGpuEncoder: vi.fn(async () => null),
          spawnProcess: spawnProcess as never,
        },
      ),
    ).resolves.toBe(true);
  });

  it("accepts the app-generated marker for an unmuted video audio lane", async () => {
    const paths = await projectFile();
    const { spawnProcess } = spawnThatCloses();

    await expect(
      tryDirectMediaExport(
        {
          ...paths,
          html: source({ videoAttributes: 'data-has-audio="true"' }),
          format: "mp4",
          fps: 30,
          dimensions: { width: 1920, height: 1080 },
        },
        {
          findBinary: () => "/opt/bin",
          probeMedia: vi.fn(async () => probe),
          detectGpuEncoder: vi.fn(async () => null),
          spawnProcess: spawnProcess as never,
        },
      ),
    ).resolves.toBe(true);
  });

  it.each(["false", "1", "yes"]) (
    "does not direct-export an app audio-lane marker with value %s",
    async (hasAudio) => {
      const paths = await projectFile();
      const spawnProcess = vi.fn();

      await expect(
        tryDirectMediaExport(
          {
            ...paths,
            html: source({ videoAttributes: `data-has-audio="${hasAudio}"` }),
            format: "mp4",
            fps: 30,
            dimensions: { width: 1920, height: 1080 },
          },
          {
            findBinary: () => "/opt/bin",
            probeMedia: vi.fn(async () => probe),
            detectGpuEncoder: vi.fn(async () => null),
            spawnProcess: spawnProcess as never,
          },
        ),
      ).resolves.toBe(false);
      expect(spawnProcess).not.toHaveBeenCalled();
    },
  );

  it.each(["data-media-start", "data-playback-start"] as const)(
    "directly exports a single video trimmed with %s",
    async (trimAttribute) => {
      const paths = await projectFile();
      const { spawnProcess } = spawnThatCloses();

      await expect(
        tryDirectMediaExport(
          {
            ...paths,
            html: source({
              rootDuration: "4",
              videoDuration: "4",
              videoAttributes: `${trimAttribute}="1" data-has-audio="true"`,
            }),
            format: "mp4",
            fps: 30,
            dimensions: { width: 1920, height: 1080 },
          },
          {
            findBinary: () => "/opt/bin",
            probeMedia: vi.fn(async () => probe),
            detectGpuEncoder: vi.fn(async () => null),
            spawnProcess: spawnProcess as never,
          },
        ),
      ).resolves.toBe(true);

      const args = spawnProcess.mock.calls[0]![1];
      expect(args).toEqual(expect.arrayContaining(["-ss", "1", "-t", "4"]));
      expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    },
  );

  it("normalizes a same-aspect HEVC/VFR/Opus source instead of using browser capture", async () => {
    const paths = await projectFile();
    const { spawnProcess } = spawnThatCloses();

    await expect(
      tryDirectMediaExport(
        {
          ...paths,
          html: source(),
          format: "mp4",
          fps: 30,
          quality: "high",
          dimensions: { width: 1920, height: 1080 },
        },
        {
          findBinary: () => "/opt/bin",
          probeMedia: vi.fn(async () => ({
            duration: 5,
            streams: [
              {
                codecType: "video",
                codecName: "hevc",
                width: 1280,
                height: 720,
                frameRate: 24.87,
                pixelFormat: "yuv420p",
                colorTransfer: "bt709",
                colorPrimaries: "bt709",
                colorSpace: "bt709",
                colorRange: "tv",
              },
              { codecType: "audio", codecName: "opus" },
            ],
          })),
          detectGpuEncoder: vi.fn(async () => null),
          spawnProcess: spawnProcess as never,
        },
      ),
    ).resolves.toBe(true);

    const args = spawnProcess.mock.calls[0]![1];
    expect(args).toEqual(expect.arrayContaining([
      "-c:v", "libx264", "-crf", "15",
      "-r", "30", "-fps_mode", "cfr",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    ]));
  });

  it("encodes a custom MP4 target directly at final dimensions in one pass", async () => {
    const paths = await projectFile();
    const { spawnProcess } = spawnThatCloses();

    await expect(
      tryDirectMediaExport(
        {
          ...paths,
          html: source(),
          format: "mp4",
          fps: 30,
          quality: "standard",
          dimensions: { width: 1920, height: 1080 },
          outputDimensions: { width: 1080, height: 1350 },
        },
        {
          findBinary: () => "/opt/bin",
          probeMedia: vi.fn(async () => probe),
          detectGpuEncoder: vi.fn(async () => null),
          spawnProcess: spawnProcess as never,
        },
      ),
    ).resolves.toBe(true);

    const args = spawnProcess.mock.calls[0]![1];
    expect(args.join(" ")).toContain(
      "scale=1080:1350:force_original_aspect_ratio=decrease",
    );
    expect(args.join(" ")).not.toContain("scale=1920:1080");
    expect(spawnProcess).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["draft", "44"],
    ["standard", "64"],
    ["high", "70"],
  ] as const)("maps %s quality into VideoToolbox quality %s", async (quality, expected) => {
    const paths = await projectFile();
    const { spawnProcess } = spawnThatCloses();
    await expect(
      tryDirectMediaExport(
        { ...paths, html: source(), format: "mp4", fps: 30, quality, dimensions: { width: 1920, height: 1080 } },
        {
          findBinary: () => "/opt/bin",
          probeMedia: vi.fn(async () => probe),
          detectGpuEncoder: vi.fn(async () => "videotoolbox"),
          spawnProcess: spawnProcess as never,
        },
      ),
    ).resolves.toBe(true);
    expect(spawnProcess.mock.calls[0]![1]).toEqual(
      expect.arrayContaining(["-q:v", expected]),
    );
  });

  it("retries a failed VideoToolbox transcode with libx264 without browser capture", async () => {
    const paths = await projectFile();
    const accelerated = new FakeChild();
    const software = new FakeChild();
    const spawnProcess = vi
      .fn()
      .mockImplementationOnce(() => {
        queueMicrotask(() => accelerated.emit("close", 1, null));
        return accelerated;
      })
      .mockImplementationOnce(() => {
        queueMicrotask(() => software.emit("close", 0, null));
        return software;
      });

    await expect(
      tryDirectMediaExport(
        { ...paths, html: source(), format: "mp4", fps: 30, quality: "standard", dimensions: { width: 1920, height: 1080 } },
        {
          findBinary: () => "/opt/bin",
          probeMedia: vi.fn(async () => probe),
          detectGpuEncoder: vi.fn(async () => "videotoolbox"),
          spawnProcess: spawnProcess as never,
        },
      ),
    ).resolves.toBe(true);

    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(spawnProcess.mock.calls[0]![1]).toContain("h264_videotoolbox");
    expect(spawnProcess.mock.calls[1]![1]).toContain("libx264");
  });

  it("reports bounded one-decimal FFmpeg progress during the direct transcode", async () => {
    const paths = await projectFile();
    const child = new FakeChild();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => {
        child.stderr.emit("data", Buffer.from("out_time_us=2500000\nprogress=continue\n"));
        child.emit("close", 0, null);
      });
      return child;
    });
    const onProgress = vi.fn();

    await expect(
      tryDirectMediaExport(
        { ...paths, html: source(), format: "mp4", fps: 30, quality: "standard", dimensions: { width: 1920, height: 1080 }, onProgress },
        {
          findBinary: () => "/opt/bin",
          probeMedia: vi.fn(async () => probe),
          detectGpuEncoder: vi.fn(async () => null),
          spawnProcess: spawnProcess as never,
        },
      ),
    ).resolves.toBe(true);

    expect(onProgress).toHaveBeenCalledWith(50);
    expect(onProgress.mock.calls.every(([value]) => value >= 0 && value <= 100)).toBe(true);
  });

  it.each([
    ["non-MP4 output", { format: "webm" }],
    ["a second timed video", { rootContent: `${source().match(/<video[\s\S]*?<\/video>/)![0]}${source().match(/<video[\s\S]*?<\/video>/)![0].replace('id="clip"', 'id="clip-2"')}` }],
    ["an overlay", { rootContent: `${source().match(/<video[\s\S]*?<\/video>/)![0]}<div data-start="0" data-duration="5">title</div>` }],
    ["a non-zero timeline start", { rootContent: '<video id="clip" class="clip" src="assets/clip.mov" data-start="1" data-duration="5" style="position:absolute;left:0px;top:0px;width:1920px;height:1080px;object-fit:contain"></video>' }],
    ["a trim beyond the media duration", { videoAttributes: 'data-media-start="1"' }],
    ["conflicting trim offsets", { rootDuration: "4", videoDuration: "4", videoAttributes: 'data-media-start="1" data-playback-start="2"' }],
    ["a playback-rate edit", { videoAttributes: 'data-playback-rate="1.25"' }],
    ["a duration mismatch", { rootDuration: "6" }],
    ["partial-canvas geometry", { videoStyle: "position:absolute;left:20px;top:0px;width:1900px;height:1080px;object-fit:contain" }],
    ["a visual transform", { videoStyle: "position:absolute;left:0px;top:0px;width:1920px;height:1080px;object-fit:contain;transform:scale(.9)" }],
    ["color grading", { videoAttributes: 'data-color-grading="contrast(2)"' }],
    ["CSS targeting the clip", { headExtra: '<style>video { opacity: .5 }</style><script src="vendor/gsap.min.js"></script>' }],
    ["CSS hiding the composition root", { headExtra: '<style>#root { display: none }</style><script src="vendor/gsap.min.js"></script>' }],
    ["an external stylesheet", { headExtra: '<link rel="stylesheet" href="theme.css"><script src="vendor/gsap.min.js"></script>' }],
    ["a case-varied external stylesheet", { headExtra: '<link rel="StyleSheet" href="theme.css"><script src="vendor/gsap.min.js"></script>' }],
    ["a base URL that changes media resolution", { headExtra: '<base href="alternate/"><script src="vendor/gsap.min.js"></script>' }],
    ["a hidden composition root", { rootAttributes: "hidden" }],
    ["a runtime attribute on the composition root", { rootAttributes: 'data-color-grading="{}"' }],
    ["a hidden body", { bodyAttributes: "hidden" }],
    ["an element outside the composition root", { bodyExtra: '<div style="position:fixed">watermark</div><script>window.__timelines = window.__timelines || {}; window.__timelines["main"] = gsap.timeline({ paused: true });</script>' }],
    ["visible text outside the composition root", { bodyExtra: 'watermark<script>window.__timelines = window.__timelines || {}; window.__timelines["main"] = gsap.timeline({ paused: true });</script>' }],
    ["a root transform", { rootContent: '<video id="clip" class="clip" src="assets/clip.mov" data-start="0" data-duration="5" style="position:absolute;left:0px;top:0px;width:1920px;height:1080px;object-fit:contain"></video>', bodyExtra: '<script>window.__timelines = window.__timelines || {}; window.__timelines["main"] = gsap.timeline({ paused: true });</script><style>#root { transform: scale(.5) }</style>' }],
    ["a caption track child", { rootContent: '<video id="clip" class="clip" src="assets/clip.mov" data-start="0" data-duration="5" style="position:absolute;left:0px;top:0px;width:1920px;height:1080px;object-fit:contain"><track kind="captions" src="captions.vtt"></video>' }],
    ["animation targeting the clip", { bodyExtra: '<script>window.__timelines["main"].to("#clip", {x: 20});</script>' }],
    ["remote media", { src: "https://example.com/clip.mp4" }],
    ["data media", { src: "data:video/mp4;base64,AA==" }],
    ["blob media", { src: "blob:http://localhost/id" }],
  ])("fails closed for %s", async (_name, change) => {
    const paths = await projectFile();
    const { spawnProcess } = spawnThatCloses();
    const format = "format" in change ? change.format : "mp4";
    const htmlChange = { ...change } as Record<string, unknown>;
    delete htmlChange.format;

    await expect(
      tryDirectMediaExport(
        {
          ...paths,
          html: source(htmlChange),
          format: format as "mp4",
          fps: 30,
          dimensions: { width: 1920, height: 1080 },
        },
        {
          findBinary: () => "/opt/bin",
          probeMedia: vi.fn(async () => probe),
          spawnProcess: spawnProcess as never,
        },
      ),
    ).resolves.toBe(false);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong dimensions", { ...probe, streams: [{ ...probe.streams[0]!, width: 1280 }] }],
    ["media shorter than the requested range", { ...probe, duration: 4.8 }],
    ["multiple audio streams", { ...probe, streams: [probe.streams[0]!, probe.streams[1]!, probe.streams[1]!] }],
    ["an unknown stream type", { ...probe, streams: [probe.streams[0]!, { codecType: "subtitle", codecName: "mov_text" }] }],
    ["PQ HDR transfer", { ...probe, streams: [{ ...probe.streams[0]!, pixelFormat: "yuv420p10le", colorTransfer: "smpte2084", colorPrimaries: "bt2020", colorSpace: "bt2020nc" }] }],
    ["HLG HDR transfer", { ...probe, streams: [{ ...probe.streams[0]!, pixelFormat: "yuv420p10le", colorTransfer: "arib-std-b67", colorPrimaries: "bt2020", colorSpace: "bt2020nc" }] }],
    ["untagged 10-bit video", { ...probe, streams: [{ ...probe.streams[0]!, pixelFormat: "yuv420p10le" }] }],
    ["BT.2020 primaries", { ...probe, streams: [{ ...probe.streams[0]!, pixelFormat: "yuv420p", colorPrimaries: "bt2020" }] }],
    ["BT.2020 matrix", { ...probe, streams: [{ ...probe.streams[0]!, pixelFormat: "yuv420p", colorSpace: "bt2020nc" }] }],
    ["full-range video", { ...probe, streams: [{ ...probe.streams[0]!, pixelFormat: "yuv420p", colorRange: "pc" }] }],
    ["alpha-bearing RGBA video", { ...probe, streams: [{ ...probe.streams[0]!, pixelFormat: "rgba" }] }],
    ["implicitly full-range JPEG YUV", { ...probe, streams: [{ ...probe.streams[0]!, pixelFormat: "yuvj420p" }] }],
  ])("falls back after probing %s", async (_name, incompatibleProbe) => {
    const paths = await projectFile();
    const spawnProcess = vi.fn();
    await expect(
      tryDirectMediaExport(
        { ...paths, html: source(), format: "mp4", fps: 30, dimensions: { width: 1920, height: 1080 } },
        {
          findBinary: () => "/opt/bin",
          probeMedia: vi.fn(async () => incompatibleProbe),
          spawnProcess: spawnProcess as never,
        },
      ),
    ).resolves.toBe(false);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("rejects a resolved media path outside the project and missing media", async () => {
    const paths = await projectFile();
    const spawnProcess = vi.fn();
    const common = {
      findBinary: () => "/opt/bin",
      probeMedia: vi.fn(async () => probe),
      spawnProcess: spawnProcess as never,
    };
    await expect(
      tryDirectMediaExport(
        { ...paths, html: source({ src: "../outside.mov" }), format: "mp4", fps: 30, dimensions: { width: 1920, height: 1080 } },
        { ...common, resolveRealPath: vi.fn(async (path: string) => path.endsWith("outside.mov") ? join(paths.projectDir, "..", "outside.mov") : paths.projectDir) },
      ),
    ).resolves.toBe(false);
    await expect(
      tryDirectMediaExport(
        { ...paths, html: source({ src: "assets/missing.mov" }), format: "mp4", fps: 30, dimensions: { width: 1920, height: 1080 } },
        common,
      ),
    ).resolves.toBe(false);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("cancels FFmpeg with SIGTERM followed by SIGKILL after the grace period", async () => {
    const paths = await projectFile();
    const child = new FakeChild();
    child.kill = vi.fn((signal: NodeJS.Signals) => {
      child.kills.push(signal);
      if (signal === "SIGKILL") queueMicrotask(() => child.emit("close", null, "SIGKILL"));
      return true;
    });
    const controller = new AbortController();
    let signalSpawned!: () => void;
    const spawned = new Promise<void>((resolve) => {
      signalSpawned = resolve;
    });
    const pending = tryDirectMediaExport(
      { ...paths, html: source(), format: "mp4", fps: 30, dimensions: { width: 1920, height: 1080 }, signal: controller.signal },
      {
        findBinary: () => "/opt/bin",
        probeMedia: vi.fn(async () => probe),
        detectGpuEncoder: vi.fn(async () => null),
        spawnProcess: vi.fn(() => {
          signalSpawned();
          return child;
        }) as never,
        cancelGraceMs: 0,
      },
    );
    await spawned;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("force-kills a wedged default ffprobe after cancellation", async () => {
    const paths = await projectFile();
    const probeChild = new FakeChild();
    probeChild.kill = vi.fn((signal: NodeJS.Signals) => {
      probeChild.kills.push(signal);
      if (signal === "SIGKILL") {
        queueMicrotask(() => probeChild.emit("close", null, "SIGKILL"));
      }
      return true;
    });
    const controller = new AbortController();
    let signalSpawned!: () => void;
    const spawned = new Promise<void>((resolve) => {
      signalSpawned = resolve;
    });
    const pending = tryDirectMediaExport(
      {
        ...paths,
        html: source(),
        format: "mp4",
        fps: 30,
        dimensions: { width: 1920, height: 1080 },
        signal: controller.signal,
      },
      {
        findBinary: () => "/opt/bin",
        spawnProcess: vi.fn(() => {
          signalSpawned();
          return probeChild;
        }) as never,
        cancelGraceMs: 0,
      },
    );
    await spawned;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(probeChild.kills).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
