import {
  findBundledFfBinary,
  type BundledFfBinaryFinder,
} from "./vite.bundled-media-binaries";

type FfBinaryFinder = BundledFfBinaryFinder;

export interface StandaloneFfmpegStatus {
  ok: boolean;
  title?: string;
  detail?: string;
  hint?: string;
}

export function resolveStandaloneFfmpegStatus(
  findBinary: FfBinaryFinder = findBundledFfBinary,
  _platform: NodeJS.Platform = process.platform,
): StandaloneFfmpegStatus {
  if (findBinary("ffmpeg", { configuredMustExist: true })) return { ok: true };
  return {
    ok: false,
    title: "Bundled media tools unavailable",
    detail: "MpVFX cannot access the FFmpeg executable shipped inside the application.",
    hint: "Reinstall MpVFX to restore its bundled media tools.",
  };
}

export function ffmpegEnvironmentResponse(
  requestPath: string,
  method: string | undefined,
  findBinary: FfBinaryFinder = findBundledFfBinary,
  platform: NodeJS.Platform = process.platform,
): Response | null {
  if (requestPath !== "/environment/ffmpeg" || method?.toUpperCase() !== "GET") return null;
  return Response.json(resolveStandaloneFfmpegStatus(findBinary, platform), {
    headers: { "Cache-Control": "no-store" },
  });
}
