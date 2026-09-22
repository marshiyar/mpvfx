import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { minimalEnvironment } from "../../scripts/automation/privacy.mjs";

const require = createRequire(import.meta.url);
const engine = join(dirname(require.resolve("@hyperframes/engine/package.json")), "dist");
const ffmpeg = join(dirname(require.resolve("ffmpeg-static/package.json")), process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
const ffprobe = join(dirname(require.resolve(`@ffprobe-installer/${process.platform}-${process.arch}/package.json`)), process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
const policy = () => require("../scripts/apply-streaming-png-patch.cjs");
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

function directory() {
  const path = mkdtempSync(join(tmpdir(), "mpvfx-png-sequence-test-"));
  temporary.push(path);
  return path;
}

// Generate valid, plain RGBA captures. No checked-in or user-owned media.
function png(rgba: number[], width = 16, height = 16) {
  const crc32 = (bytes: Buffer) => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, bytes: Buffer) => {
    const data = Buffer.alloc(bytes.length + 12);
    data.writeUInt32BE(bytes.length); data.write(type, 4); bytes.copy(data, 8);
    data.writeUInt32BE(crc32(data.subarray(4, -4)), data.length - 4);
    return data;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.set(rgba, y * (1 + width * 4) + 1 + x * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

const colors = [[255, 0, 0, 255], [0, 0, 255, 64], [0, 255, 0, 255]];
function frames(path: string) {
  colors.forEach((color, index) => writeFileSync(join(path, `frame_${String(index).padStart(6, "0")}.png`), png(color)));
}

function args(path: string, range: string[] = []) {
  // Forward slashes let the simulated Linux argument path also run on Windows.
  return ["-v", "error", "-framerate", "30000/1001", ...range, "-i", join(path, "frame_%06d.png").replaceAll("\\", "/"), "-r", "30000/1001", "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-y", join(path, "output.mov")];
}

async function runner(platform = "linux", launch?: typeof spawn) {
  const source = readFileSync(join(engine, "utils/runFfmpeg.js"), "utf8");
  const implementation = source.match(/async function runFfmpeg\(args, opts\) \{[\s\S]*?\n\}/)?.[0];
  if (!implementation) throw new Error("Unsupported test runner source");
  const { ManagedChildProcess } = await import(/* @vite-ignore */ pathToFileURL(join(engine, "utils/managedChildProcess.js")).href);
  const calls: string[][] = [];
  const launchWithoutPng: typeof spawn = ((binary: string, command: string[], options: object) => {
    calls.push([...command]);
    // Reproduce the pinned Linux binary's missing PNG decoder on any test host.
    // Successful input is encoded by the real pinned host FFmpeg.
    if (command.some((arg) => arg.endsWith("frame_%06d.png"))) {
      return spawn(process.execPath, ["-e", "process.stderr.write('PNG decoder unavailable'); process.exit(1)"], { ...options, env: minimalEnvironment() });
    }
    return (launch ?? spawn)(binary, command, { ...options, env: minimalEnvironment() });
  }) as typeof spawn;
  const run = new Function("process", "spawn", "getFfmpegBinary", "trackChildProcess", "ManagedChildProcess", "DEFAULT_TIMEOUT", "mpvfxPreparePngSequenceInput", `${implementation}; return runFfmpeg;`)(
    { platform }, launchWithoutPng, () => ffmpeg, () => {}, ManagedChildProcess, 5000,
    policy().mpvfxPreparePngSequenceInput,
  );
  return { run, calls };
}

function decodedPixels(path: string) {
  const result = spawnSync(ffmpeg, ["-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { env: minimalEnvironment(), windowsHide: true, timeout: 5000 });
  expect(result.status).toBe(0);
  return result.stdout;
}

describe("saved PNG capture compatibility", () => {
  it("encodes ordered ProRes frames with alpha without asking FFmpeg to decode PNG", async () => {
    const path = directory(); frames(path);
    const { run, calls } = await runner();
    const result = await run(args(path), { timeout: 5000 });
    expect(result.success, result.stderr).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain(join(path, "frame_%06d.png"));
    const pixels = decodedPixels(join(path, "output.mov"));
    expect(pixels.length).toBe(3 * 16 * 16 * 4);
    colors.forEach((color, frame) => color.forEach((channel, index) => expect(Math.abs(pixels[frame * 16 * 16 * 4 + index] - channel)).toBeLessThanOrEqual(3)));
    const probe = spawnSync(ffprobe, ["-v", "error", "-show_streams", "-of", "json", join(path, "output.mov")], { env: minimalEnvironment(), windowsHide: true, timeout: 5000 });
    expect(probe.status).toBe(0);
    expect(JSON.parse(probe.stdout.toString()).streams[0]).toMatchObject({ codec_name: "prores", avg_frame_rate: "30000/1001", nb_frames: "3" });
  });

  it("honors a chunk's start number and frame limit without repeating or skipping frames", async () => {
    const path = directory(); frames(path);
    const { run } = await runner();
    const command = args(path, ["-start_number", "1"]);
    command.splice(command.length - 2, 0, "-frames:v", "1");
    const result = await run(command, { timeout: 5000 });
    expect(result.success, result.stderr).toBe(true);
    const pixels = decodedPixels(join(path, "output.mov"));
    expect(pixels.length).toBe(16 * 16 * 4);
    colors[1].forEach((channel, index) => expect(Math.abs(pixels[index] - channel)).toBeLessThanOrEqual(3));
  });

  it("keeps non-Linux and non-sequence invocations unchanged", async () => {
    for (const platform of ["darwin", "win32"]) {
      const { run, calls } = await runner(platform);
      const command = ["-version"];
      expect((await run(command)).success).toBe(true);
      expect(calls).toEqual([command]);
    }
    const prepare = policy().mpvfxPreparePngSequenceInput;
    expect(await prepare(["-i", "/synthetic/frame_%06d.jpg"], "linux")).toBeNull();
    expect(await prepare(["-i", "/synthetic/source.png"], "linux")).toBeNull();
    expect(await prepare(["-f", "rawvideo", "-i", "pipe:0"], "linux")).toBeNull();
    for (const platform of ["darwin", "win32"]) expect(await prepare(["-i", "/synthetic/frame_%06d.png"], platform)).toBeNull();
  });

  it("retains audio input and muxing alongside the saved video frames", async () => {
    const path = directory(); frames(path);
    const command = args(path);
    command.splice(command.indexOf("-r"), 0, "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=0.1001");
    command.splice(command.length - 2, 0, "-c:a", "pcm_s16le");
    const { run } = await runner();
    const result = await run(command, { timeout: 5000 });
    expect(result.success, result.stderr).toBe(true);
    const audio = spawnSync(ffmpeg, ["-v", "error", "-i", join(path, "output.mov"), "-vn", "-f", "s16le", "pipe:1"], { env: minimalEnvironment(), windowsHide: true, timeout: 5000 });
    expect(audio.status).toBe(0);
    expect(Math.abs(audio.stdout.length / 2 - 48000 * 0.1001)).toBeLessThan(2);
    expect(audio.stdout.some((byte) => byte !== 0)).toBe(true);
  });

  it("changes only input transport, retaining encoder, color, timing and chunk settings", async () => {
    const path = directory(); frames(path);
    const command = args(path, ["-start_number", "1"]);
    command.unshift("-vaapi_device", "/dev/dri/renderD128");
    command.splice(command.length - 2, 0, "-frames:v", "1", "-vf", "scale=in_range=pc:out_range=tv", "-g", "30", "-flags", "+cgop", "-video_track_timescale", "90000");
    const before = [...command];
    const prepared = await policy().mpvfxPreparePngSequenceInput(command, "linux");
    expect(command).toEqual(before);
    expect(prepared.args.slice(prepared.args.indexOf("-i") + 2)).toEqual(before.slice(before.indexOf("-i") + 2));
    expect(prepared.args).toEqual([
      "-vaapi_device", "/dev/dri/renderD128", "-v", "error", "-framerate", "30000/1001",
      "-f", "rawvideo", "-pix_fmt", "rgba", "-video_size", "16x16", "-i", "pipe:0",
      ...before.slice(before.indexOf("-i") + 2),
    ]);
  });

  it.each(["missing", "corrupt", "different-size", "short-chunk"])("fails a %s sequence instead of reporting a truncated export as successful", async (kind) => {
    const path = directory(); frames(path);
    const second = join(path, "frame_000001.png");
    if (kind === "missing") rmSync(second);
    if (kind === "corrupt") writeFileSync(second, "not a captured PNG");
    if (kind === "different-size") writeFileSync(second, png(colors[1], 8, 8));
    const command = args(path);
    if (kind === "short-chunk") command.splice(command.length - 2, 0, "-frames:v", "4");
    const { run } = await runner();
    const result = await run(command, { timeout: 1000 });
    expect(result.success).toBe(false);
    expect(result.terminationReason).not.toBe("deadline");
    expect(result.stderr).toBeTruthy();
    expect(result.stderr).not.toContain(path);
  });

  it("does not start an encoder for an already cancelled capture", async () => {
    const path = directory(); frames(path);
    const controller = new AbortController(); controller.abort();
    const { run, calls } = await runner();
    expect(await run(args(path), { signal: controller.signal })).toMatchObject({ success: false, terminationReason: "abort" });
    expect(calls).toHaveLength(0);
  });

  it.each(["abort", "deadline"])("reaps an encoder on %s while its input pipe is blocked", async (reason) => {
    const path = directory();
    colors.forEach((color, index) => writeFileSync(join(path, `frame_${String(index).padStart(6, "0")}.png`), png(color, 512, 512)));
    const controller = new AbortController();
    let child: ReturnType<typeof spawn> | undefined;
    const launch = ((_: string, _args: string[], options: object) => {
      child = spawn(process.execPath, ["-e", "process.stdin.pause(); setInterval(() => {}, 1000)"], options);
      if (reason === "abort") child.once("spawn", () => setTimeout(() => controller.abort(), 50));
      return child;
    }) as typeof spawn;
    const { run } = await runner("linux", launch);
    const result = await run(args(path), { signal: controller.signal, timeout: reason === "deadline" ? 100 : 1500 });
    expect(result).toMatchObject({ success: false, terminationReason: reason });
    expect(child?.signalCode).toBe("SIGTERM");
  });

  it("preserves FFmpeg failures and completes without an unhandled pipe error", async () => {
    const path = directory(); frames(path);
    const command = args(path);
    command[command.indexOf("prores_ks")] = "mpvfx_nonexistent_encoder";
    const { run } = await runner();
    const result = await run(command, { timeout: 1000 });
    expect(result.success).toBe(false);
    expect(result.stderr).toMatch(/Unknown encoder|Encoder not found/);
  });

  it("handles an input pipe failure during encoder startup", async () => {
    const path = directory(); frames(path);
    let child: ReturnType<typeof spawn> | undefined;
    const launch = ((_: string, _args: string[], options: object) => {
      child = spawn(process.execPath, ["-e", "process.stdin.pause(); setInterval(() => {}, 1000)"], options);
      process.nextTick(() => child?.stdin?.destroy(new Error("synthetic early pipe failure")));
      return child;
    }) as typeof spawn;
    const { run } = await runner("linux", launch);
    const result = await run(args(path), { timeout: 1000 });
    expect(result.success).toBe(false);
    expect(result.terminationReason).not.toBe("deadline");
    expect(child?.signalCode).toBe("SIGTERM");
  });

  it("requires the saved-frame repair in every installed producer bundle", () => {
    const { assertStreamingPngPolicy, patchPngSequenceSource } = policy();
    expect(() => assertStreamingPngPolicy(resolve(import.meta.dirname, ".."))).not.toThrow();
    for (const file of ["@hyperframes/engine/dist/utils/runFfmpeg.js", ...["index.js", "public-server.js", "distributed.js"].map((name) => `@hyperframes/producer/dist/${name}`)]) {
      const absolute = resolve(import.meta.dirname, "../node_modules", file);
      const source = readFileSync(absolute, "utf8");
      expect(patchPngSequenceSource(source, file)).toBe(source);
      expect(() => patchPngSequenceSource(source.replace("const mpvfxInputStart = Date.now();", "const mpvfxInputStart = 0;"), file)).toThrow(/unsupported/i);
      const syntax = spawnSync(process.execPath, ["--check", absolute], { env: minimalEnvironment(), windowsHide: true, timeout: 5000 });
      expect(syntax.status, syntax.stderr.toString()).toBe(0);
    }
    expect(() => patchPngSequenceSource("unsupported dependency", "test")).toThrow(/unsupported/i);
  });
});
