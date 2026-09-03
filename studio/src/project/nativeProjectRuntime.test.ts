// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  installNativeProjectRuntime,
  type NativeProjectRuntimeClock,
} from "./nativeProjectRuntime";
import {
  NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
  type NativeProjectDocument,
} from "./nativeProjectDocument";
import { createNativeParameterTrack } from "./nativeKeyframeTypes";

const clock = (): NativeProjectRuntimeClock => ({
  now: () => 0,
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: () => undefined,
});

function project(): NativeProjectDocument {
  return {
    schemaVersion: NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
    id: "project:demo",
    revision: 0,
    frameRate: { numerator: 30, denominator: 1 },
    canvas: { width: 1920, height: 1080, background: "#101010" },
    assets: [{ id: "asset:camera", kind: "video", name: "camera.mov", durationFrames: 300 }],
    sequence: {
      id: "sequence:main",
      name: "Main",
      tracks: [
        {
          id: "track:video",
          kind: "video",
          clips: [
            {
              id: "clip:camera",
              assetId: "asset:camera",
              startFrame: 0,
              durationFrames: 91,
              sourceInFrame: 0,
              muted: false,
              effects: [],
              parameterTracks: [
                createNativeParameterTrack({
                  id: "parameter:rotation",
                  parameterId: "transform.rotation",
                  valueType: "number",
                  frameRate: { numerator: 30, denominator: 1 },
                  keyframes: [
                    { id: "key:start", frame: 0, value: 0, outgoing: { type: "linear" } },
                    { id: "key:end", frame: 90, value: -180, outgoing: { type: "linear" } },
                  ],
                }),
              ],
            },
          ],
        },
      ],
    },
  };
}

beforeEach(() => document.body.replaceChildren());

describe("installNativeProjectRuntime", () => {
  it("flattens clips, installs the native player, and renders an exact midpoint", () => {
    const element = document.createElement("div");
    element.setAttribute("data-studio-clip-id", "clip:camera");
    document.body.append(element);
    const iframeWindow = {} as Window;

    const runtime = installNativeProjectRuntime({
      window: iframeWindow,
      document,
      project: project(),
      clock: clock(),
    });

    expect(runtime.durationFrames).toBe(91);
    expect(runtime.clips).toEqual([
      expect.objectContaining({
        clipId: "clip:camera",
        assetId: "asset:camera",
        assetKind: "video",
        startFrame: 0,
        durationFrames: 91,
        sourceInFrame: 0,
        muted: false,
      }),
    ]);
    expect((iframeWindow as Window & { __studioNativePlayer?: unknown }).__studioNativePlayer).toBe(
      runtime.player,
    );
    runtime.player.seek(1.5);
    expect(element.style.transform).toContain("rotate(-90deg)");
  });

  it("projects optional clip playback rate into preview transport metadata without rounding it", () => {
    const native = project();
    const clip = native.sequence.tracks[0]!.clips[0]! as typeof native.sequence.tracks[0]["clips"][number] & {
      playbackRate?: { numerator: number; denominator: number };
    };
    clip.sourceInFrame = 17;
    clip.muted = true;
    clip.playbackRate = { numerator: 1_001, denominator: 1_000 };

    const runtime = installNativeProjectRuntime({
      window: {} as Window,
      document,
      project: native,
      clock: clock(),
    });

    expect(runtime.clips[0]).toEqual(expect.objectContaining({
      assetId: "asset:camera",
      assetKind: "video",
      sourceInFrame: 17,
      muted: true,
      playbackRate: { numerator: 1_001, denominator: 1_000 },
    }));
  });

  it("maps an exact scoped DOM id binding and restores only the attribute it added on cleanup", () => {
    const fallback = document.createElement("div");
    fallback.id = "clip:camera";
    const wrong = document.createElement("div");
    wrong.id = "clip:camera-extra";
    document.body.append(fallback, wrong);
    const iframeWindow = {} as Window;

    const bound = project();
    bound.sequence.tracks[0]!.clips[0]!.binding = {
      sourceFile: "index.html",
      domId: "clip:camera",
    };
    const runtime = installNativeProjectRuntime({
      window: iframeWindow,
      document,
      project: bound,
      clock: clock(),
    });
    runtime.player.seek(1.5);

    expect(fallback.getAttribute("data-studio-clip-id")).toBe("clip:camera");
    expect(fallback.style.transform).toContain("rotate(-90deg)");
    expect(wrong.getAttribute("data-studio-clip-id")).toBeNull();
    runtime.cleanup();
    expect(fallback.getAttribute("data-studio-clip-id")).toBeNull();
    expect((iframeWindow as Window & { __studioNativePlayer?: unknown }).__studioNativePlayer).toBeUndefined();
  });

  it("keeps a replacement runtime's DOM binding when an overlapping predecessor cleans up", () => {
    const media = document.createElement("video");
    media.id = "legacy-camera";
    document.body.append(media);
    const iframeWindow = {} as Window;
    const bound = project();
    bound.sequence.tracks[0]!.clips[0]!.binding = {
      sourceFile: "index.html",
      domId: "legacy-camera",
    };

    const predecessor = installNativeProjectRuntime({
      window: iframeWindow,
      document,
      project: bound,
      clock: clock(),
    });
    const replacement = installNativeProjectRuntime({
      window: iframeWindow,
      document,
      project: bound,
      clock: clock(),
    });

    predecessor.cleanup();
    replacement.player.seek(1.5);

    expect(media.getAttribute("data-studio-clip-id")).toBe("clip:camera");
    expect(media.getAttribute("data-studio-native-owned")).toContain("transform.rotation");
    expect(media.style.transform).toContain("rotate(-90deg)");
    expect(
      (iframeWindow as Window & { __studioNativePlayer?: unknown }).__studioNativePlayer,
    ).toBe(replacement.player);

    replacement.cleanup();
    expect(media.getAttribute("data-studio-clip-id")).toBeNull();
    expect(
      (iframeWindow as Window & { __studioNativePlayer?: unknown }).__studioNativePlayer,
    ).toBeUndefined();
  });

  it("prefers an existing canonical data attribute over a differing legacy binding", () => {
    const canonical = document.createElement("div");
    canonical.setAttribute("data-studio-clip-id", "clip:camera");
    const boundElsewhere = document.createElement("div");
    boundElsewhere.id = "legacy-camera";
    document.body.append(canonical, boundElsewhere);
    const bound = project();
    bound.sequence.tracks[0]!.clips[0]!.binding = {
      sourceFile: "index.html",
      domId: "legacy-camera",
    };

    const runtime = installNativeProjectRuntime({
      window: {} as Window,
      document,
      project: bound,
      clock: clock(),
    });
    runtime.player.seek(1.5);

    expect(canonical.style.transform).toContain("rotate(-90deg)");
    expect(boundElsewhere.getAttribute("data-studio-clip-id")).toBeNull();
    runtime.cleanup();
    expect(canonical.getAttribute("data-studio-clip-id")).toBe("clip:camera");
  });

  it("uses an exact unique data-hf-id or selector binding, while refusing ambiguous selector targets", () => {
    const hf = document.createElement("div");
    hf.setAttribute("data-hf-id", "hf-camera");
    const first = document.createElement("div");
    const second = document.createElement("div");
    const unique = document.createElement("div");
    first.className = "legacy-clip";
    second.className = "legacy-clip";
    unique.className = "one-legacy-clip";
    document.body.append(hf, first, second, unique);

    const byHf = project();
    byHf.sequence.tracks[0]!.clips[0]!.binding = {
      sourceFile: "index.html",
      hfId: "hf-camera",
    };
    const hfRuntime = installNativeProjectRuntime({
      window: {} as Window,
      document,
      project: byHf,
      clock: clock(),
    });
    hfRuntime.player.seek(1.5);
    expect(hf.getAttribute("data-studio-clip-id")).toBe("clip:camera");
    hfRuntime.cleanup();

    const byIndex = project();
    byIndex.sequence.tracks[0]!.clips[0]!.binding = {
      sourceFile: "index.html",
      selector: ".legacy-clip",
      selectorIndex: 1,
    };
    const indexedRuntime = installNativeProjectRuntime({
      window: {} as Window,
      document,
      project: byIndex,
      clock: clock(),
    });
    indexedRuntime.player.seek(1.5);
    expect(first.getAttribute("data-studio-clip-id")).toBeNull();
    expect(second.getAttribute("data-studio-clip-id")).toBe("clip:camera");
    indexedRuntime.cleanup();

    const byUniqueSelector = project();
    byUniqueSelector.sequence.tracks[0]!.clips[0]!.binding = {
      sourceFile: "index.html",
      selector: ".one-legacy-clip",
    };
    const uniqueRuntime = installNativeProjectRuntime({
      window: {} as Window,
      document,
      project: byUniqueSelector,
      clock: clock(),
    });
    uniqueRuntime.player.seek(1.5);
    expect(unique.getAttribute("data-studio-clip-id")).toBe("clip:camera");
    uniqueRuntime.cleanup();

    const ambiguous = project();
    ambiguous.sequence.tracks[0]!.clips[0]!.binding = {
      sourceFile: "index.html",
      selector: ".legacy-clip",
    };
    installNativeProjectRuntime({
      window: {} as Window,
      document,
      project: ambiguous,
      clock: clock(),
    }).player.seek(1.5);
    expect(first.getAttribute("data-studio-clip-id")).toBeNull();
    expect(second.getAttribute("data-studio-clip-id")).toBeNull();
  });

  it("calculates project duration from the latest clip end and removes only its own player", () => {
    const documentWithTail = project();
    documentWithTail.sequence.tracks[0]!.clips.push({
      id: "clip:tail",
      assetId: "asset:camera",
      startFrame: 120,
      durationFrames: 30,
      sourceInFrame: 0,
      muted: false,
      effects: [],
      parameterTracks: [],
    });
    const priorNative = {
      play() {}, pause() {}, seek() {}, getTime: () => 0, getDuration: () => 99, isPlaying: () => false,
    };
    const iframeWindow = { __studioNativePlayer: priorNative } as unknown as Window;

    const runtime = installNativeProjectRuntime({
      window: iframeWindow,
      document,
      project: documentWithTail,
      clock: clock(),
    });
    expect(runtime.durationFrames).toBe(150);
    runtime.cleanup();

    expect((iframeWindow as unknown as { __studioNativePlayer?: unknown }).__studioNativePlayer).toBe(
      priorNative,
    );
  });

  it("composes native picture evaluation with the existing media player transport", () => {
    const element = document.createElement("div");
    element.id = "clip:camera";
    document.body.append(element);
    const legacy = {
      play: vi.fn(),
      pause: vi.fn(),
      seek: vi.fn(),
      getTime: () => 0,
      getDuration: () => 91 / 30,
      isPlaying: () => false,
    };
    const iframeWindow = { __player: legacy } as unknown as Window;
    const bound = project();
    bound.sequence.tracks[0]!.clips[0]!.binding = {
      sourceFile: "index.html",
      domId: "clip:camera",
    };

    const runtime = installNativeProjectRuntime({
      window: iframeWindow,
      document,
      project: bound,
      clock: clock(),
    });
    runtime.player.seek(1.5);
    runtime.player.play();
    runtime.player.pause();

    expect(legacy.seek).toHaveBeenCalledWith(1.5, undefined);
    expect(legacy.play).toHaveBeenCalledOnce();
    expect(legacy.pause).toHaveBeenCalledOnce();
    expect(element.style.transform).toContain("rotate(-90deg)");
  });

  it("disposes a replaced native evaluator without pausing the shared media transport", () => {
    const legacy = {
      play: vi.fn(),
      pause: vi.fn(),
      seek: vi.fn(),
      getTime: () => 1.5,
      getDuration: () => 10,
      isPlaying: () => true,
    };
    const iframeWindow = { __player: legacy } as unknown as Window;
    const runtime = installNativeProjectRuntime({
      window: iframeWindow,
      document,
      project: project(),
      clock: clock(),
    });

    runtime.player.play();
    legacy.pause.mockClear();
    runtime.cleanup();

    expect(legacy.pause).not.toHaveBeenCalled();
    expect((iframeWindow as unknown as { __studioNativePlayer?: unknown }).__studioNativePlayer)
      .toBeUndefined();
  });

  it("renders static clip parameters through the native preview runtime", () => {
    const element = document.createElement("div");
    element.setAttribute("data-studio-clip-id", "clip:camera");
    document.body.append(element);
    const native = project();
    native.sequence.tracks[0]!.clips[0]!.parameterTracks = [];
    native.sequence.tracks[0]!.clips[0]!.staticParameters = {
      "transform.position": { x: 10, y: 20 },
      "transform.rotation": 30,
      "transform.scale": { x: 1.5, y: 0.75 },
      "transform.opacity": 0.8,
    };

    const runtime = installNativeProjectRuntime({
      window: {} as Window,
      document,
      project: native,
      clock: clock(),
    });
    runtime.player.seek(1.5);

    expect(element.style.transform).toBe(
      "translate3d(10px, 20px, 0px) rotate(30deg) scale(1.5, 0.75)",
    );
    expect(element.style.opacity).toBe("0.8");
    runtime.cleanup();
  });

  it("lets animated tracks override only their matching static base parameters", () => {
    const element = document.createElement("div");
    element.setAttribute("data-studio-clip-id", "clip:camera");
    document.body.append(element);
    const native = project();
    native.sequence.tracks[0]!.clips[0]!.staticParameters = {
      "transform.position": { x: 10, y: 20 },
      "transform.rotation": 30,
      "transform.scale": { x: 1.5, y: 0.75 },
      "transform.opacity": 0.8,
    };

    const runtime = installNativeProjectRuntime({
      window: {} as Window,
      document,
      project: native,
      clock: clock(),
    });
    runtime.player.seek(1.5);

    expect(element.style.transform).toBe(
      "translate3d(10px, 20px, 0px) rotate(-90deg) scale(1.5, 0.75)",
    );
    expect(element.style.opacity).toBe("0.8");
    runtime.cleanup();
  });
});
