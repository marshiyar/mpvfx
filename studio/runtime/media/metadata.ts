import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { MediaMetadata } from "../../shared/media/mediaMetadata";
import { findBundledFfBinary } from "./binaries";

/** Use the bundled native probe for both authoring and export stream facts. */
export async function readProjectMediaMetadata(
  projectDir: string,
  source: string,
  signal?: AbortSignal,
): Promise<MediaMetadata> {
  signal?.throwIfAborted();
  if (typeof source !== "string" || !source || source.includes("\0")) {
    throw new Error("A project media path is required");
  }
  const root = await realpath(projectDir);
  const path = await realpath(resolve(root, source));
  const offset = relative(root, path);
  if (!offset || isAbsolute(offset) || offset === ".." || offset.startsWith(`..${sep}`)) {
    throw new Error("Media must be a file inside this project");
  }
  const before = await stat(path);
  if (!before.isFile()) throw new Error("Media must be a regular file");
  const binary = findBundledFfBinary("ffprobe", { configuredMustExist: true });
  if (!binary) throw new Error("MpVFX's bundled FFprobe is unavailable");
  const stdout = await new Promise<string>((accept, reject) => {
    execFile(binary, [
      "-v", "error", "-protocol_whitelist", "file,pipe",
      "-show_entries", "stream=codec_type:format=duration", "-of", "json", "--", path,
    ], { signal, timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 },
    (error, output) => error ? reject(error) : accept(output));
  });
  const after = await stat(path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error(`Media changed while reading its streams: ${source}`);
  }
  const data = JSON.parse(stdout) as {
    streams?: Array<{ codec_type?: string }>;
    format?: { duration?: string };
  };
  if (!Array.isArray(data.streams)) throw new Error(`Could not read media streams: ${source}`);
  const duration = Number(data.format?.duration);
  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    hasVideo: data.streams.some(stream => stream.codec_type === "video"),
    hasAudio: data.streams.some(stream => stream.codec_type === "audio"),
  };
}
