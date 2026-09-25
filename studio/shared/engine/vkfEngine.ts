/**
 * Port to the C++ video-keyframing engine, which owns keyframe validation and
 * evaluation. Every process installs one backend at startup:
 *
 *  - main process and tests: the Node-API module (`createModuleEngine`)
 *  - editor renderer: the preload bridge to the same module (`createBridgeEngine`)
 *  - export capture pages, which cannot load native code: values pre-computed
 *    by the engine in the main process (`createBakedEngine` + `bakeTrackSamples`)
 *
 * No evaluation rules live in TypeScript; this file only moves data.
 */

export const VKF_ENGINE_API_VERSION = 1;

export interface VkfVec2 {
  readonly x: number;
  readonly y: number;
}

export interface VkfRgba {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly alpha: number;
}

export type VkfValueType = "number" | "vec2" | "rgba";
export type VkfValue = number | VkfVec2 | VkfRgba;

export type VkfInterpolation =
  | { readonly type: "hold" }
  | { readonly type: "linear" }
  | {
      readonly type: "cubic-bezier";
      readonly controlPoints: { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number };
    };

export interface VkfTrack {
  readonly valueType: VkfValueType;
  readonly keyframes: readonly {
    readonly frame: number;
    readonly value: VkfValue;
    readonly outgoing: VkfInterpolation;
  }[];
}

/** Error codes raised by the engine for invalid tracks. */
export type VkfTrackErrorCode =
  | "empty-track"
  | "invalid-keyframe-frame"
  | "duplicate-keyframe-frame"
  | "invalid-value"
  | "invalid-interpolation";

const TRACK_ERROR_CODES: ReadonlySet<string> = new Set<VkfTrackErrorCode>([
  "empty-track",
  "invalid-keyframe-frame",
  "duplicate-keyframe-frame",
  "invalid-value",
  "invalid-interpolation",
]);

export class VkfTrackError extends Error {
  readonly code: VkfTrackErrorCode;

  constructor(code: VkfTrackErrorCode, message: string) {
    super(message);
    this.name = "VkfTrackError";
    this.code = code;
  }
}

export interface VkfEngine {
  readonly version: string;
  /** Throws VkfTrackError when the engine rejects the track. */
  validate(track: VkfTrack): void;
  /** Value at an integer or fractional frame. */
  evaluate(track: VkfTrack, frame: number): VkfValue;
  /** `count` consecutive frames from `firstFrame`, components interleaved. */
  sample(track: VkfTrack, firstFrame: number, count: number): Float64Array;
}

/** Shape of the Node-API module `vkf.node` (engine apiVersion 1). */
export interface VkfNativeModule {
  readonly apiVersion: number;
  readonly version: string;
  compileTrack(track: VkfTrack): unknown;
  evaluateTrack(compiled: unknown, frame: number): VkfValue;
  sampleTrack(compiled: unknown, firstFrame: number, count: number): Float64Array;
}

/** Result of compiling across the context bridge, which cannot carry error fields. */
export type VkfBridgeCompileResult =
  | { readonly handle: number }
  | { readonly code: string; readonly message: string };

/** Functions the preload script exposes to the renderer (handles, not objects). */
export interface VkfEngineBridge {
  readonly apiVersion: number;
  readonly version: string;
  compile(track: VkfTrack): VkfBridgeCompileResult;
  evaluate(handle: number, frame: number): VkfValue;
  sample(handle: number, firstFrame: number, count: number): Float64Array;
  release(handle: number): void;
}

/**
 * One engine per process, kept on the global object rather than in module
 * state: a second copy of this module (a duplicated bundle chunk, or a test
 * that resets its module registry) must see the same engine, never none.
 */
const ENGINE_SLOT = Symbol.for("mpvfx.vkfEngine");
type EngineSlot = { [ENGINE_SLOT]?: VkfEngine };

export function installVkfEngine(engine: VkfEngine): void {
  (globalThis as EngineSlot)[ENGINE_SLOT] = engine;
}

export function vkfEngine(): VkfEngine {
  const installed = (globalThis as EngineSlot)[ENGINE_SLOT];
  if (!installed) {
    throw new Error("The video-keyframing engine is not loaded in this process");
  }
  return installed;
}

export function vkfEngineInstalled(): boolean {
  return (globalThis as EngineSlot)[ENGINE_SLOT] !== undefined;
}

function asTrackError(error: unknown): never {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (typeof code === "string" && TRACK_ERROR_CODES.has(code)) {
    throw new VkfTrackError(code as VkfTrackErrorCode, message);
  }
  throw error;
}

function assertApiVersion(apiVersion: number): void {
  if (apiVersion !== VKF_ENGINE_API_VERSION) {
    throw new Error(
      `video-keyframing engine API ${apiVersion} is incompatible (expected ${VKF_ENGINE_API_VERSION})`,
    );
  }
}

/**
 * Tracks are immutable project values, so compiled engine tracks are cached by
 * object identity and dropped with the track.
 */
export function createModuleEngine(module: VkfNativeModule): VkfEngine {
  assertApiVersion(module.apiVersion);
  const compiled = new WeakMap<VkfTrack, unknown>();
  const compile = (track: VkfTrack): unknown => {
    let handle = compiled.get(track);
    if (handle === undefined) {
      try {
        handle = module.compileTrack(track);
      } catch (error) {
        asTrackError(error);
      }
      compiled.set(track, handle);
    }
    return handle;
  };
  return {
    version: module.version,
    validate: (track) => {
      compile(track);
    },
    evaluate: (track, frame) => module.evaluateTrack(compile(track), frame),
    sample: (track, firstFrame, count) => module.sampleTrack(compile(track), firstFrame, count),
  };
}

interface FinalizationRegistryLike<T> {
  register(target: object, heldValue: T): void;
}
declare const FinalizationRegistry:
  | (new <T>(cleanup: (heldValue: T) => void) => FinalizationRegistryLike<T>)
  | undefined;

export function createBridgeEngine(bridge: VkfEngineBridge): VkfEngine {
  assertApiVersion(bridge.apiVersion);
  const handles = new WeakMap<VkfTrack, number>();
  const registry =
    typeof FinalizationRegistry === "function"
      ? new FinalizationRegistry<number>((handle) => bridge.release(handle))
      : null;
  const handleOf = (track: VkfTrack): number => {
    let handle = handles.get(track);
    if (handle === undefined) {
      const result = bridge.compile(track);
      if (!("handle" in result)) asTrackError(Object.assign(new Error(result.message), { code: result.code }));
      handle = result.handle;
      handles.set(track, handle);
      registry?.register(track, handle);
    }
    return handle;
  };
  return {
    version: bridge.version,
    validate: (track) => {
      handleOf(track);
    },
    evaluate: (track, frame) => bridge.evaluate(handleOf(track), frame),
    sample: (track, firstFrame, count) => bridge.sample(handleOf(track), firstFrame, count),
  };
}

// ---------------------------------------------------------------------------
// Pre-computed values for processes that cannot load the engine.

export interface VkfBakedTrack {
  readonly valueType: VkfValueType;
  /** Samples for frames 0 .. frameCount-1, components interleaved. */
  readonly samples: readonly number[];
}

const COMPONENTS: Readonly<Record<VkfValueType, number>> = { number: 1, vec2: 2, rgba: 4 };

/**
 * Engine samples for frames [0, frameCount). frameCount must reach past the
 * last keyframe so every later frame equals the final sample; frames before 0
 * precede every keyframe (frames are non-negative) and equal the first sample.
 */
export function bakeTrackSamples(engine: VkfEngine, track: VkfTrack, frameCount: number): VkfBakedTrack {
  const lastKey = track.keyframes.reduce((last, key) => Math.max(last, key.frame), 0);
  const count = Math.max(1, Math.floor(frameCount), lastKey + 1);
  return { valueType: track.valueType, samples: Array.from(engine.sample(track, 0, count)) };
}

function valueAt(baked: VkfBakedTrack, frame: number): VkfValue {
  const n = COMPONENTS[baked.valueType];
  const frames = baked.samples.length / n;
  const index = Math.min(frames - 1, Math.max(0, frame));
  const at = index * n;
  const s = baked.samples;
  if (baked.valueType === "number") return s[at];
  if (baked.valueType === "vec2") return { x: s[at], y: s[at + 1] };
  return { red: s[at], green: s[at + 1], blue: s[at + 2], alpha: s[at + 3] };
}

/**
 * Engine replacement for export pages: `lookup` maps a track to its baked
 * samples. Only integer frames can be answered; anything else is an error
 * rather than a silent re-implementation of the engine's interpolation.
 */
export function createBakedEngine(
  version: string,
  lookup: (track: VkfTrack) => VkfBakedTrack | undefined,
): VkfEngine {
  const baked = (track: VkfTrack): VkfBakedTrack => {
    const found = lookup(track);
    if (!found) throw new Error("No engine samples were prepared for this track");
    return found;
  };
  return {
    version,
    validate: (track) => {
      baked(track);
    },
    evaluate: (track, frame) => {
      if (!Number.isInteger(frame)) {
        throw new TypeError("Pre-computed engine values exist only for integer frames");
      }
      return valueAt(baked(track), frame);
    },
    sample: (track, firstFrame, count) => {
      if (!Number.isInteger(firstFrame) || !Number.isInteger(count) || count < 0) {
        throw new TypeError("Pre-computed engine values exist only for integer frames");
      }
      const b = baked(track);
      const n = COMPONENTS[b.valueType];
      const out = new Float64Array(count * n);
      for (let i = 0; i < count; i += 1) {
        const v = valueAt(b, firstFrame + i);
        if (typeof v === "number") out[i] = v;
        else if ("x" in v) out.set([v.x, v.y], i * n);
        else out.set([v.red, v.green, v.blue, v.alpha], i * n);
      }
      return out;
    },
  };
}
