import { existsSync, unlinkSync } from "node:fs";
import { execFile } from "node:child_process";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { probeAssetCodec } from "@hyperframes/studio-server/media-codec-map";
import { classifyMediaImportPath } from "./src/utils/mediaImportPolicy";
import { findBundledFfBinary } from "./vite.bundled-media-binaries";

const DIRECT_VIDEO_CODECS = new Set(["h264", "vp8"]);
const PROXIED_VIDEO_CODECS = new Set(["hevc", "prores", "av1", "vp9"]);

export type ImportedVideoCodecSupport = "direct" | "proxy" | "unsupported";

export interface ImportedVideoProbeFacts {
  codecName: string;
  containerName: string;
}

export function classifyImportedVideoCodec(codecName: string): ImportedVideoCodecSupport {
  const normalized = codecName.trim().toLowerCase();
  if (DIRECT_VIDEO_CODECS.has(normalized)) return "direct";
  if (PROXIED_VIDEO_CODECS.has(normalized)) return "proxy";
  return "unsupported";
}

const MP4_FAMILY_EXTENSIONS = new Set([".mp4", ".m4v", ".mov"]);

export function classifyImportedVideoContainerCodec(
  uploadedPath: string,
  facts: ImportedVideoProbeFacts,
): ImportedVideoCodecSupport {
  const codecName = facts.codecName.trim().toLowerCase();
  const containerNames = new Set(
    facts.containerName
      .toLowerCase()
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
  const extension = extname(uploadedPath).toLowerCase();

  if (MP4_FAMILY_EXTENSIONS.has(extension)) {
    if (!containerNames.has("mov") && !containerNames.has("mp4")) return "unsupported";
    if (codecName === "h264") return "direct";
    return PROXIED_VIDEO_CODECS.has(codecName) ? "proxy" : "unsupported";
  }

  if (extension === ".webm") {
    if (!containerNames.has("webm")) return "unsupported";
    if (codecName === "vp8") return "direct";
    return codecName === "vp9" || codecName === "av1" ? "proxy" : "unsupported";
  }

  return "unsupported";
}

function probeContainerName(absolutePath: string): Promise<string | null> {
  const ffprobePath = findBundledFfBinary("ffprobe", { configuredMustExist: true });
  if (!ffprobePath) return Promise.resolve(null);
  return new Promise((resolveProbe) => {
    execFile(
      ffprobePath,
      [
        "-v",
        "error",
        "-show_entries",
        "format=format_name",
        "-of",
        "json",
        "--",
        absolutePath,
      ],
      { timeout: 10_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolveProbe(null);
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as { format?: { format_name?: unknown } };
          const formatName = parsed.format?.format_name;
          resolveProbe(typeof formatName === "string" && formatName.trim() ? formatName : null);
        } catch {
          resolveProbe(null);
        }
      },
    );
  });
}

async function probeImportedVideo(absolutePath: string): Promise<ImportedVideoProbeFacts | null> {
  const [codecFacts, containerName] = await Promise.all([
    probeAssetCodec(absolutePath).catch(() => null),
    probeContainerName(absolutePath),
  ]);
  if (!codecFacts || !containerName) return null;
  return { codecName: codecFacts.codecName, containerName };
}

interface ResolvedImportProject {
  dir: string;
}

interface UploadPayload {
  ok?: unknown;
  files?: unknown;
  skipped?: unknown;
  invalid?: unknown;
  [key: string]: unknown;
}

function safeUploadedPath(projectDir: string, uploadedPath: string): string | null {
  const root = resolve(projectDir);
  const candidate = resolve(root, uploadedPath);
  const rel = relative(root, candidate);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return candidate;
}

function uploadProjectId(requestPath: string): string | null {
  const match = /^\/projects\/([^/]+)\/upload$/.exec(requestPath);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export async function applyUploadedVideoCodecPolicy(input: {
  requestPath: string;
  response: Response;
  resolveProject: (
    projectId: string,
  ) => ResolvedImportProject | null | Promise<ResolvedImportProject | null>;
  probeVideo?: (absolutePath: string) => Promise<ImportedVideoProbeFacts | null>;
}): Promise<Response> {
  const projectId = uploadProjectId(input.requestPath);
  if (!projectId || !input.response.ok) return input.response;

  let payload: UploadPayload;
  try {
    payload = (await input.response.clone().json()) as UploadPayload;
  } catch {
    return input.response;
  }
  if (!Array.isArray(payload.files)) return input.response;

  const project = await input.resolveProject(projectId);
  if (!project) return input.response;
  const probeVideo = input.probeVideo ?? probeImportedVideo;
  const kept: string[] = [];
  const rejected: Array<{ name: string; reason: string }> = [];

  for (const value of payload.files) {
    if (typeof value !== "string") continue;
    if (classifyMediaImportPath(value) !== "video") {
      kept.push(value);
      continue;
    }
    const absolutePath = safeUploadedPath(project.dir, value);
    let videoFacts: ImportedVideoProbeFacts | null = null;
    if (absolutePath) {
      try {
        videoFacts = await probeVideo(absolutePath);
      } catch {
        videoFacts = null;
      }
    }
    const support = videoFacts
      ? classifyImportedVideoContainerCodec(value, videoFacts)
      : "unsupported";
    if (videoFacts && support !== "unsupported") {
      kept.push(value);
      continue;
    }
    if (absolutePath && existsSync(absolutePath)) unlinkSync(absolutePath);
    rejected.push({
      name: value,
      reason: videoFacts
        ? classifyImportedVideoCodec(videoFacts.codecName) === "unsupported"
          ? `unsupported video codec: ${videoFacts.codecName}`
          : `unsupported video codec/container combination: ${videoFacts.codecName} in ${videoFacts.containerName}`
        : "video codec could not be verified",
    });
  }

  if (rejected.length === 0) return input.response;
  const existingInvalid = Array.isArray(payload.invalid) ? payload.invalid : [];
  const headers = new Headers(input.response.headers);
  headers.delete("content-length");
  return new Response(
    JSON.stringify({ ...payload, files: kept, invalid: [...existingInvalid, ...rejected] }),
    { status: input.response.status, statusText: input.response.statusText, headers },
  );
}
