import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir, platform, arch } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const DEFAULT_MODEL = "u2net_human_seg" as const;
export type ModelId = typeof DEFAULT_MODEL;

const MODEL_URLS: Record<ModelId, string> = {
  u2net_human_seg:
    "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net_human_seg.onnx",
};

const MODEL_SHA256: Record<ModelId, string> = {
  u2net_human_seg: "01eb6a29a5c4d8edb30b56adad9bb3a2a0535338e480724a213e0acfd2d1c73c",
};

export const DEVICES = ["auto", "cpu", "coreml", "cuda"] as const;
export type Device = (typeof DEVICES)[number];

export interface ProviderChoice {
  providers: string[];
  label: "CoreML" | "CUDA" | "CPU";
}

export function modelsDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  return (
    environment.MPVFX_BACKGROUND_REMOVAL_MODELS_DIR ??
    join(homedir(), ".cache", "mpvfx", "background-removal", "models")
  );
}

export function selectProviders(device: Device = "auto"): ProviderChoice {
  if (device === "cpu") return { providers: ["cpu"], label: "CPU" };
  const available = listAvailableProviders();
  const hasCoreML = available.includes("coreml");
  const hasCuda = available.includes("cuda");
  if (device === "coreml") {
    if (!hasCoreML) throw new Error("CoreML is unavailable on this device. Use CPU instead.");
    return { providers: ["coreml", "cpu"], label: "CoreML" };
  }
  if (device === "cuda") {
    if (!hasCuda) throw new Error("CUDA is unavailable on this device. Use CPU instead.");
    return { providers: ["cuda", "cpu"], label: "CUDA" };
  }
  if (hasCoreML && platform() === "darwin" && arch() === "arm64") {
    return { providers: ["coreml", "cpu"], label: "CoreML" };
  }
  if (hasCuda) return { providers: ["cuda", "cpu"], label: "CUDA" };
  return { providers: ["cpu"], label: "CPU" };
}

export function listAvailableProviders(): string[] {
  const providers = ["cpu"];
  if (platform() === "darwin" && arch() === "arm64") providers.push("coreml");
  if (process.env.HYPERFRAMES_CUDA === "1") providers.push("cuda");
  return providers;
}

export function modelPath(
  model: ModelId = DEFAULT_MODEL,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return join(modelsDirectory(environment), `${model}.onnx`);
}

const pendingDownloads = new Map<string, Promise<string>>();

async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

async function assertModelChecksum(model: ModelId, path: string): Promise<void> {
  const actual = await sha256File(path);
  const expected = MODEL_SHA256[model];
  if (actual !== expected) {
    throw new Error(
      `Model integrity check failed for ${model}: expected SHA-256 ${expected}, received ${actual}`,
    );
  }
}

async function downloadModel(model: ModelId, url: string, destination: string): Promise<void> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Model download failed with HTTP ${response.status}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.download-${process.pid}`;
  try {
    await pipeline(
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
      createWriteStream(temporary, { flags: "wx" }),
    );
    await assertModelChecksum(model, temporary);
    renameSync(temporary, destination);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Another concurrent attempt may already have cleaned the partial file.
    }
    throw error;
  }
}

export async function ensureModel(
  model: ModelId = DEFAULT_MODEL,
  options?: { onProgress?: (message: string) => void },
): Promise<string> {
  const destination = modelPath(model);
  const active = pendingDownloads.get(destination);
  if (active) return active;
  const download = (async () => {
    if (existsSync(destination)) {
      try {
        await assertModelChecksum(model, destination);
        return destination;
      } catch {
        unlinkSync(destination);
      }
    }
    options?.onProgress?.(`Downloading ${model} weights (~168 MB)...`);
    await downloadModel(model, MODEL_URLS[model], destination);
    if (!existsSync(destination)) throw new Error(`Model download failed: ${model}`);
    return destination;
  })();
  pendingDownloads.set(destination, download);
  try {
    return await download;
  } finally {
    pendingDownloads.delete(destination);
  }
}
