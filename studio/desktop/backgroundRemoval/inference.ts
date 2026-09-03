import type { InferenceSession, Tensor } from "onnxruntime-node";
import { createRequire } from "node:module";
import { ensureModel, selectProviders, type Device, type ModelId } from "./manager";

const INPUT_SIZE = 320;
const INPUT_PLANE = INPUT_SIZE * INPUT_SIZE;
export const MEAN = [0.485, 0.456, 0.406] as const;
export const STD = [0.229, 0.224, 0.225] as const;

interface SharpImage {
  resize(width: number, height: number, options: Record<string, unknown>): SharpImage;
  raw(): SharpImage;
  toColourspace(colourspace: string): SharpImage;
  toBuffer(): Promise<Buffer>;
}
type Sharp = (
  input: Buffer,
  options: { raw: { width: number; height: number; channels: 1 | 3 } },
) => SharpImage;
interface OrtModule {
  InferenceSession: typeof InferenceSession;
  Tensor: typeof Tensor;
}

export interface SessionResult {
  fg: Buffer;
  bg: Buffer | null;
}

export interface Session {
  process(
    rgb: Buffer,
    width: number,
    height: number,
    withBackground?: boolean,
  ): Promise<SessionResult>;
  provider: string;
  close(): Promise<void>;
}

export async function createSession(options: {
  model?: ModelId;
  device?: Device;
  onProgress?: (message: string) => void;
} = {}): Promise<Session> {
  const ort = (await import("onnxruntime-node")) as unknown as OrtModule;
  const sharp = createRequire(import.meta.url)("sharp") as Sharp;
  const choice = selectProviders(options.device ?? "auto");
  const path = await ensureModel(options.model, { onProgress: options.onProgress });
  options.onProgress?.(`Loading model on ${choice.label}...`);

  const create = (providers: string[]) =>
    ort.InferenceSession.create(path, {
      executionProviders: providers,
      graphOptimizationLevel: "all",
    });
  let session: InferenceSession;
  let provider = choice.label;
  try {
    session = await create(choice.providers);
  } catch (error) {
    if (choice.providers[0] === "cpu") throw error;
    options.onProgress?.(`${choice.label} failed; falling back to CPU.`);
    session = await create(["cpu"]);
    provider = "CPU";
  }

  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  if (!inputName || !outputName) throw new Error("Background-removal model has no bindings");
  const inputData = new Float32Array(3 * INPUT_PLANE);
  const maskBuffer = Buffer.allocUnsafe(INPUT_PLANE);
  let foreground: Buffer | null = null;
  let background: Buffer | null = null;

  return {
    provider,
    async process(rgb, width, height, withBackground = false) {
      const tensor = await preprocess(sharp, ort, rgb, width, height, inputData);
      const output = (await session.run({ [inputName]: tensor }))[outputName];
      if (!output) throw new Error("Background-removal model returned no mask");
      const bytes = width * height * 4;
      if (!foreground || foreground.length !== bytes) foreground = Buffer.allocUnsafe(bytes);
      if (withBackground && (!background || background.length !== bytes)) {
        background = Buffer.allocUnsafe(bytes);
      }
      return postprocess(
        sharp,
        output,
        rgb,
        width,
        height,
        maskBuffer,
        foreground,
        withBackground ? background : null,
      );
    },
    async close() {
      await session.release();
    },
  };
}

async function preprocess(
  sharp: Sharp,
  ort: OrtModule,
  rgb: Buffer,
  width: number,
  height: number,
  inputData: Float32Array,
): Promise<Tensor> {
  const resized = await sharp(rgb, { raw: { width, height, channels: 3 } })
    .resize(INPUT_SIZE, INPUT_SIZE, { kernel: "lanczos3", fit: "fill" })
    .raw()
    .toBuffer();
  let maxPixel = 0;
  for (const value of resized) if (value > maxPixel) maxPixel = value;
  if (maxPixel === 0) maxPixel = 1;
  for (let pixel = 0; pixel < INPUT_PLANE; pixel++) {
    const source = pixel * 3;
    inputData[pixel] = (resized[source]! / maxPixel - MEAN[0]) / STD[0];
    inputData[INPUT_PLANE + pixel] =
      (resized[source + 1]! / maxPixel - MEAN[1]) / STD[1];
    inputData[2 * INPUT_PLANE + pixel] =
      (resized[source + 2]! / maxPixel - MEAN[2]) / STD[2];
  }
  return new ort.Tensor("float32", inputData, [1, 3, INPUT_SIZE, INPUT_SIZE]);
}

async function postprocess(
  sharp: Sharp,
  output: Tensor,
  rgb: Buffer,
  width: number,
  height: number,
  maskBuffer: Buffer,
  foreground: Buffer,
  background: Buffer | null,
): Promise<SessionResult> {
  const raw = output.data as Float32Array;
  let low = Infinity;
  let high = -Infinity;
  for (let i = 0; i < INPUT_PLANE; i++) {
    low = Math.min(low, raw[i]!);
    high = Math.max(high, raw[i]!);
  }
  const range = high - low || 1;
  for (let i = 0; i < INPUT_PLANE; i++) {
    maskBuffer[i] = Math.max(0, Math.min(255, Math.round(((raw[i]! - low) / range) * 255)));
  }
  const mask = await sharp(maskBuffer, {
    raw: { width: INPUT_SIZE, height: INPUT_SIZE, channels: 1 },
  })
    .resize(width, height, { kernel: "lanczos3", fit: "fill" })
    .toColourspace("b-w")
    .raw()
    .toBuffer();
  return applyMask(rgb, mask, foreground, background, width * height);
}

export function applyMask(
  rgb: Buffer,
  mask: Buffer,
  foreground: Buffer,
  background: Buffer | null,
  pixels: number,
): SessionResult {
  for (let i = 0; i < pixels; i++) {
    const source = i * 3;
    const target = i * 4;
    foreground[target] = rgb[source]!;
    foreground[target + 1] = rgb[source + 1]!;
    foreground[target + 2] = rgb[source + 2]!;
    foreground[target + 3] = mask[i]!;
    if (background) {
      background[target] = rgb[source]!;
      background[target + 1] = rgb[source + 1]!;
      background[target + 2] = rgb[source + 2]!;
      background[target + 3] = 255 - mask[i]!;
    }
  }
  return { fg: foreground, bg: background };
}
