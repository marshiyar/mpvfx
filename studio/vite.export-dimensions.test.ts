import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  assertAuthoredExportWithinLimit,
  buildExportResizeArgs,
  createExportStagingPaths,
  injectStandaloneExportDimensions,
  readAuthoredExportDimensions,
  resizeStandaloneExport,
  takeStandaloneExportDimensions,
} from "./vite.export-dimensions";

function createSuccessfulFfmpegProcess() {
  const process = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  process.stderr = new EventEmitter();
  process.kill = vi.fn(() => true);
  queueMicrotask(() => process.emit("close", 0, null));
  return process;
}

describe("standalone custom export bridge", () => {
  it("reads canvas dimensions from the composition root regardless of attribute order", () => {
    expect(
      readAuthoredExportDimensions(
        '<main data-height="1920" class="canvas" data-composition-id="main" data-width="1080">',
      ),
    ).toEqual({ width: 1080, height: 1920 });
  });

  it("rejects an authored canvas outside the 8K envelope before rendering starts", () => {
    expect(() =>
      assertAuthoredExportWithinLimit(
        '<main data-composition-id="main" data-width="7682" data-height="4320">',
      ),
    ).toThrow(/8K/i);
    expect(() =>
      assertAuthoredExportWithinLimit(
        '<main data-composition-id="main" data-width="4320" data-height="7680">',
      ),
    ).not.toThrow();
  });

  it("ignores fake composition tags in comments, scripts, and inert templates", () => {
    const html = `
      <!-- <main data-composition-id="comment" data-width="1920" data-height="1080"> -->
      <script>const fake = '<main data-composition-id="script" data-width="1920" data-height="1080">';</script>
      <template><main data-composition-id="template" data-width="1920" data-height="1080"></main></template>
      <main data-composition-id="real" data-width="10000" data-height="10000"></main>
    `;
    expect(readAuthoredExportDimensions(html)).toEqual({ width: 10000, height: 10000 });
    expect(() => assertAuthoredExportWithinLimit(html)).toThrow(/8K/i);
  });

  it("stages native and resized files below a hidden directory until atomic publication", () => {
    expect(createExportStagingPaths("/renders/demo_1.mp4", "demo_1")).toEqual({
      directory: "/renders/.studio-render-tmp/demo_1",
      nativeOutputPath: "/renders/.studio-render-tmp/demo_1/native.mp4",
      encodedOutputPath: "/renders/.studio-render-tmp/demo_1/encoded.mp4",
    });
  });

  it("carries validated dimensions through the shared server's variables channel", () => {
    const bridged = injectStandaloneExportDimensions(
      Buffer.from(JSON.stringify({ format: "mp4", dimensions: { width: 7680, height: 4320 } })),
    );
    const parsed = JSON.parse(bridged.toString("utf8"));
    expect(parsed).not.toHaveProperty("dimensions");
    expect(takeStandaloneExportDimensions(parsed.variables)).toEqual({
      dimensions: { width: 7680, height: 4320 },
      variables: undefined,
    });
  });

  it("preserves real composition variables while stripping the private bridge value", () => {
    const bridged = injectStandaloneExportDimensions(
      Buffer.from(
        JSON.stringify({
          dimensions: { width: 1080, height: 1350 },
          variables: { title: "Launch" },
        }),
      ),
    );
    const parsed = JSON.parse(bridged.toString("utf8"));
    expect(takeStandaloneExportDimensions(parsed.variables)).toEqual({
      dimensions: { width: 1080, height: 1350 },
      variables: { title: "Launch" },
    });
  });

  it.each([
    ["mp4", ["-c:v", "libx264", "-pix_fmt", "yuv420p"]],
    ["webm", ["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p"]],
    ["mov", ["-c:v", "prores_ks", "-pix_fmt", "yuva444p10le"]],
  ] as const)("builds a fit-and-pad resize command that preserves %s output semantics", (format, codecArgs) => {
    const args = buildExportResizeArgs({
      format,
      quality: "high",
      inputPath: "/tmp/native.mov",
      outputPath: "/tmp/output.mov",
      dimensions: { width: 1080, height: 1350 },
    });
    expect(args.join(" ")).toContain("scale=1080:1350:force_original_aspect_ratio=decrease");
    expect(args.join(" ")).toContain("pad=1080:1350:(ow-iw)/2:(oh-ih)/2");
    for (let index = 0; index < codecArgs.length; index += 2) {
      expect(args).toContain(codecArgs[index]);
      expect(args).toContain(codecArgs[index + 1]);
    }
  });

  it("selects the alpha-capable VP9 decoder before opening a WebM input", () => {
    const args = buildExportResizeArgs({
      format: "webm",
      quality: "standard",
      inputPath: "/tmp/native.webm",
      outputPath: "/tmp/output.webm",
      dimensions: { width: 1080, height: 1080 },
    });
    const inputIndex = args.indexOf("-i");
    expect(args.slice(0, inputIndex)).toEqual(
      expect.arrayContaining(["-c:v", "libvpx-vp9"]),
    );
    expect(args.slice(inputIndex + 1)).toEqual(
      expect.arrayContaining(["-c:v", "libvpx-vp9"]),
    );
  });

  it("uses VideoToolbox automatically for an MP4 resize when the backend probe selected it", () => {
    const args = buildExportResizeArgs({
      format: "mp4",
      quality: "standard",
      inputPath: "/tmp/native.mp4",
      outputPath: "/tmp/output.mp4",
      dimensions: { width: 1920, height: 1080 },
      gpuEncoder: "videotoolbox",
    });

    expect(args).toEqual(expect.arrayContaining(["-c:v", "h264_videotoolbox", "-allow_sw", "1"]));
    expect(args).not.toContain("libx264");
  });

  it("probes and automatically applies VideoToolbox to an MP4 resize", async () => {
    const detectGpuEncoder = vi.fn(async () => "videotoolbox" as const);
    const spawnProcess = vi.fn(() => createSuccessfulFfmpegProcess());

    await resizeStandaloneExport(
      {
        format: "mp4",
        quality: "standard",
        inputPath: "/tmp/native.mp4",
        outputPath: "/tmp/output.mp4",
        dimensions: { width: 1920, height: 1080 },
      },
      {
        findBinary: () => "/usr/bin/ffmpeg",
        detectGpuEncoder,
        spawnProcess: spawnProcess as never,
      },
    );

    expect(detectGpuEncoder).toHaveBeenCalledOnce();
    expect(spawnProcess.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(["-c:v", "h264_videotoolbox", "-allow_sw", "1"]),
    );
  });

  it("retries once with libx264 when VideoToolbox becomes unavailable after probing", async () => {
    const failedHardwareProcess = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    failedHardwareProcess.stderr = new EventEmitter();
    failedHardwareProcess.kill = vi.fn(() => true);
    const spawnProcess = vi
      .fn()
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          failedHardwareProcess.stderr.emit(
            "data",
            Buffer.from("VideoToolbox became unavailable"),
          );
          failedHardwareProcess.emit("close", 1, null);
        });
        return failedHardwareProcess;
      })
      .mockImplementationOnce(() => createSuccessfulFfmpegProcess());

    await resizeStandaloneExport(
      {
        format: "mp4",
        quality: "standard",
        inputPath: "/tmp/native.mp4",
        outputPath: "/tmp/output.mp4",
        dimensions: { width: 1920, height: 1080 },
      },
      {
        findBinary: () => "/usr/bin/ffmpeg",
        detectGpuEncoder: vi.fn(async () => "videotoolbox" as const),
        spawnProcess: spawnProcess as never,
      },
    );

    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(spawnProcess.mock.calls[0]?.[1]).toContain("h264_videotoolbox");
    expect(spawnProcess.mock.calls[1]?.[1]).toContain("libx264");
  });

  it("falls back to libx264 when the hardware probe is unavailable", async () => {
    const detectGpuEncoder = vi.fn(async () => null);
    const spawnProcess = vi.fn(() => createSuccessfulFfmpegProcess());

    await resizeStandaloneExport(
      {
        format: "mp4",
        quality: "standard",
        inputPath: "/tmp/native.mp4",
        outputPath: "/tmp/output.mp4",
        dimensions: { width: 1920, height: 1080 },
      },
      {
        findBinary: () => "/usr/bin/ffmpeg",
        detectGpuEncoder,
        spawnProcess: spawnProcess as never,
      },
    );

    expect(detectGpuEncoder).toHaveBeenCalledOnce();
    expect(spawnProcess.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(["-c:v", "libx264"]),
    );
  });

  it.each(["webm", "mov"] as const)(
    "does not run the MP4 hardware probe for %s resize",
    async (format) => {
      const detectGpuEncoder = vi.fn(async () => "videotoolbox" as const);
      const spawnProcess = vi.fn(() => createSuccessfulFfmpegProcess());

      await resizeStandaloneExport(
        {
          format,
          quality: "standard",
          inputPath: `/tmp/native.${format}`,
          outputPath: `/tmp/output.${format}`,
          dimensions: { width: 1920, height: 1080 },
        },
        {
          findBinary: () => "/usr/bin/ffmpeg",
          detectGpuEncoder,
          spawnProcess: spawnProcess as never,
        },
      );

      expect(detectGpuEncoder).not.toHaveBeenCalled();
    },
  );

  it("does not start FFmpeg when cancellation lands during hardware detection", async () => {
    let finishDetection: ((encoder: "videotoolbox") => void) | undefined;
    const detectGpuEncoder = vi.fn(
      () =>
        new Promise<"videotoolbox">((resolve) => {
          finishDetection = resolve;
        }),
    );
    const spawnProcess = vi.fn(() => createSuccessfulFfmpegProcess());
    const controller = new AbortController();

    const resizing = resizeStandaloneExport(
      {
        format: "mp4",
        quality: "standard",
        inputPath: "/tmp/native.mp4",
        outputPath: "/tmp/output.mp4",
        dimensions: { width: 1920, height: 1080 },
        signal: controller.signal,
      },
      {
        findBinary: () => "/usr/bin/ffmpeg",
        detectGpuEncoder,
        spawnProcess: spawnProcess as never,
      },
    );
    controller.abort();
    finishDetection?.("videotoolbox");

    await expect(resizing).rejects.toMatchObject({ name: "AbortError" });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("terminates the FFmpeg resize child when the export is cancelled", async () => {
    const process = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    process.stderr = new EventEmitter();
    process.kill = vi.fn(() => {
      queueMicrotask(() => process.emit("close", null, "SIGTERM"));
      return true;
    });
    let markSpawned: (() => void) | undefined;
    const spawned = new Promise<void>((resolve) => {
      markSpawned = resolve;
    });
    const spawnProcess = vi.fn(() => {
      markSpawned?.();
      return process;
    });
    const controller = new AbortController();

    const resizing = resizeStandaloneExport(
      {
        format: "mp4",
        quality: "standard",
        inputPath: "/tmp/native.mp4",
        outputPath: "/tmp/output.mp4",
        dimensions: { width: 1920, height: 1080 },
        signal: controller.signal,
      },
      {
        findBinary: () => "/usr/bin/ffmpeg",
        detectGpuEncoder: vi.fn(async () => null),
        spawnProcess: spawnProcess as never,
      },
    );
    await spawned;
    controller.abort();

    await expect(resizing).rejects.toMatchObject({ name: "AbortError" });
    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(process.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("does not start a software retry after cancellation stops VideoToolbox", async () => {
    const process = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    process.stderr = new EventEmitter();
    process.kill = vi.fn(() => {
      queueMicrotask(() => process.emit("close", null, "SIGTERM"));
      return true;
    });
    let markSpawned: (() => void) | undefined;
    const spawned = new Promise<void>((resolve) => {
      markSpawned = resolve;
    });
    const spawnProcess = vi.fn(() => {
      markSpawned?.();
      return process;
    });
    const controller = new AbortController();

    const resizing = resizeStandaloneExport(
      {
        format: "mp4",
        quality: "standard",
        inputPath: "/tmp/native.mp4",
        outputPath: "/tmp/output.mp4",
        dimensions: { width: 1920, height: 1080 },
        signal: controller.signal,
      },
      {
        findBinary: () => "/usr/bin/ffmpeg",
        detectGpuEncoder: vi.fn(async () => "videotoolbox" as const),
        spawnProcess: spawnProcess as never,
      },
    );
    await spawned;
    controller.abort();

    await expect(resizing).rejects.toMatchObject({ name: "AbortError" });
    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(process.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("force-kills FFmpeg when it ignores graceful cancellation", async () => {
    vi.useFakeTimers();
    const process = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    process.stderr = new EventEmitter();
    process.kill = vi.fn((signal: string) => {
      if (signal === "SIGKILL") queueMicrotask(() => process.emit("close", null, "SIGKILL"));
      return true;
    });
    const controller = new AbortController();
    let markSpawned: (() => void) | undefined;
    const spawned = new Promise<void>((resolve) => {
      markSpawned = resolve;
    });
    const resizing = resizeStandaloneExport(
      {
        format: "mp4",
        quality: "standard",
        inputPath: "/tmp/native.mp4",
        outputPath: "/tmp/output.mp4",
        dimensions: { width: 1920, height: 1080 },
        signal: controller.signal,
      },
      {
        findBinary: () => "/usr/bin/ffmpeg",
        detectGpuEncoder: vi.fn(async () => null),
        spawnProcess: (() => {
          markSpawned?.();
          return process;
        }) as never,
        cancelGraceMs: 100,
      },
    );

    const cancellation = expect(resizing).rejects.toMatchObject({ name: "AbortError" });
    await spawned;
    controller.abort();
    await vi.advanceTimersByTimeAsync(100);

    await cancellation;
    expect(process.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    vi.useRealTimers();
  });
});
