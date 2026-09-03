// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DomEditSelection } from "../components/editor/domEditingTypes";
import { evaluateNativeParameterTrack } from "../project/nativeKeyframeEvaluator";
import {
  NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
  parseNativeProjectDocument,
  serializeNativeProjectDocument,
  type NativeProjectDocument,
} from "../project/nativeProjectDocument";
import { createNativeParameterTrack } from "../project/nativeKeyframeTypes";
import {
  NativeProjectEditRoutingError,
  useProjectAnimatedPropertyCommit,
  type ProjectAnimatedPropertyCommitApi,
} from "./useProjectAnimatedPropertyCommit";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const project = (revision = 7): NativeProjectDocument => ({
  schemaVersion: NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
  id: "project:native-ui",
  revision,
  frameRate: { numerator: 30, denominator: 1 },
  canvas: { width: 1920, height: 1080, background: "#000000" },
  assets: [{ id: "asset:video", kind: "video", name: "clip.mov", durationFrames: 300 }],
  sequence: {
    id: "sequence:main",
    name: "Main",
    tracks: [
      {
        id: "track:v1",
        kind: "video",
        clips: [
          {
            id: "clip:first",
            assetId: "asset:video",
            startFrame: 30,
            durationFrames: 120,
            sourceInFrame: 0,
            muted: false,
            effects: [],
            parameterTracks: [],
          },
        ],
      },
    ],
  },
});

function selection(clipId = "clip:first"): DomEditSelection {
  const element = document.createElement("div");
  element.setAttribute("data-studio-clip-id", clipId);
  return {
    id: "legacy-dom-id",
    element,
    boundingBox: { x: 0, y: 0, width: 640, height: 360 },
  } as unknown as DomEditSelection;
}

function compatibilitySelection(options: { explicitNativeId?: string } = {}): DomEditSelection {
  const element = document.createElement("div");
  element.id = "legacy-camera-node";
  element.setAttribute("data-hf-id", "hf-camera-node");
  if (options.explicitNativeId !== undefined) {
    element.setAttribute("data-studio-clip-id", options.explicitNativeId);
  }
  return {
    id: "legacy-camera-node",
    hfId: "hf-camera-node",
    selector: ".camera-node",
    selectorIndex: 0,
    sourceFile: "index.html",
    element,
    boundingBox: { x: 0, y: 0, width: 640, height: 360 },
  } as unknown as DomEditSelection;
}

let roots: Root[] = [];
afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
  document.body.replaceChildren();
});

function renderCommit(
  options: Parameters<typeof useProjectAnimatedPropertyCommit>[0],
): ProjectAnimatedPropertyCommitApi {
  let api!: ProjectAnimatedPropertyCommitApi;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  function Harness() {
    api = useProjectAnimatedPropertyCommit(options);
    return null;
  }
  act(() => root.render(<Harness />));
  return api;
}

function memoryOptions(
  document: NativeProjectDocument | null,
  playheadSeconds = 2,
  autoKeyframeEnabled = false,
) {
  let content = document ? serializeNativeProjectDocument(document) : null;
  const writeProjectFile = vi.fn(async (_path: string, next: string, expected?: string) => {
    expect(expected).toBe(content ?? undefined);
    content = next;
  });
  const recordHistory = vi.fn();
  const onNativeDocumentCommitted = vi.fn();
  const legacyCommitProperties = vi.fn(async () => undefined);
  return {
    options: {
      nativeDocument: document,
      readOptionalProjectFile: async () => content,
      writeProjectFile,
      recordHistory,
      onNativeDocumentCommitted,
      getPlayheadSeconds: () => playheadSeconds,
      getAutoKeyframeEnabled: () => autoKeyframeEnabled,
      legacyCommitProperties,
    },
    getContent: () => content,
    writeProjectFile,
    recordHistory,
    onNativeDocumentCommitted,
    legacyCommitProperties,
  };
}

describe("useProjectAnimatedPropertyCommit", () => {
  it("defaults missing auto-keyframe state to off so an ordinary edit cannot create motion", async () => {
    const memory = memoryOptions(project(), 2, false);
    const options = { ...memory.options };
    delete (options as Partial<typeof options>).getAutoKeyframeEnabled;
    const api = renderCommit(options);

    await api.commitAnimatedProperty(selection(), "rotation", -45);

    const saved = parseNativeProjectDocument(JSON.parse(memory.getContent()!));
    expect(saved.sequence.tracks[0]!.clips[0]!.parameterTracks).toEqual([]);
    expect(saved.sequence.tracks[0]!.clips[0]!.staticParameters).toMatchObject({
      "transform.rotation": -45,
    });
  });

  it("routes an exact scoped compatibility binding to its independent native clip id", async () => {
    const native = project();
    native.sequence.tracks[0]!.clips[0]!.binding = {
      sourceFile: "index.html",
      domId: "legacy-camera-node",
      hfId: "hf-camera-node",
      selector: ".camera-node",
      selectorIndex: 0,
    };
    const memory = memoryOptions(native);
    const api = renderCommit(memory.options);
    const target = compatibilitySelection();

    expect(api.isNativeSelection(target)).toBe(true);
    await expect(
      api.commitAnimatedProperty(target, "rotation", -180, { intent: "keyframe" }),
    ).resolves.toBe("native");

    expect(memory.legacyCommitProperties).not.toHaveBeenCalled();
    const saved = parseNativeProjectDocument(JSON.parse(memory.getContent()!));
    expect(saved.sequence.tracks[0]!.clips[0]!.id).toBe("clip:first");
    expect(saved.sequence.tracks[0]!.clips[0]!.binding?.domId).toBe("legacy-camera-node");
  });

  it("does not bypass a wrong explicit native identity through a compatibility binding", async () => {
    const native = project();
    native.sequence.tracks[0]!.clips[0]!.binding = {
      sourceFile: "index.html",
      domId: "legacy-camera-node",
    };
    const memory = memoryOptions(native);
    const api = renderCommit(memory.options);
    const target = compatibilitySelection({ explicitNativeId: "clip:missing" });

    expect(api.isNativeSelection(target)).toBe(false);
    await expect(api.commitAnimatedProperty(target, "rotation", -180)).resolves.toBe("legacy");
    expect(memory.writeProjectFile).not.toHaveBeenCalled();
    expect(memory.legacyCommitProperties).toHaveBeenCalledOnce();
  });

  it("creates the native sidecar and keyframe atomically on the first eligible edit", async () => {
    const memory = memoryOptions(null);
    const api = renderCommit({
      ...memory.options,
      nativeBootstrapDocument: project(0),
    });

    await expect(
      api.commitAnimatedProperty(selection(), "rotation", -180, { intent: "keyframe" }),
    ).resolves.toBe("native");

    expect(memory.writeProjectFile).toHaveBeenCalledOnce();
    expect(memory.recordHistory).toHaveBeenCalledOnce();
    expect(memory.legacyCommitProperties).not.toHaveBeenCalled();
    const saved = parseNativeProjectDocument(JSON.parse(memory.getContent()!));
    expect(saved.revision).toBe(0);
    expect(saved.sequence.tracks[0]!.clips[0]!.parameterTracks[0]!.keyframes).toEqual([
      expect.objectContaining({ frame: 30, value: -180 }),
    ]);
  });

  it("writes an explicit rotation keyframe at the exact clip-local frame without calling GSAP", async () => {
    const memory = memoryOptions(project());
    const api = renderCommit(memory.options);

    expect(api.isNativeSelection(selection())).toBe(true);
    expect(api.isNativeSelection(selection("clip:missing"))).toBe(false);

    await expect(
      api.commitAnimatedProperty(selection(), "rotation", -180, { intent: "keyframe" }),
    ).resolves.toBe("native");

    expect(memory.writeProjectFile).toHaveBeenCalledTimes(1);
    expect(memory.recordHistory).toHaveBeenCalledTimes(1);
    expect(memory.onNativeDocumentCommitted).toHaveBeenCalledTimes(1);
    expect(memory.legacyCommitProperties).not.toHaveBeenCalled();
    const saved = parseNativeProjectDocument(JSON.parse(memory.getContent()!));
    expect(saved.revision).toBe(8);
    const rotation = saved.sequence.tracks[0]!.clips[0]!.parameterTracks.find(
      (track) => track.parameterId === "transform.rotation",
    );
    expect(rotation?.keyframes.map(({ frame, value }) => ({ frame, value }))).toEqual([
      { frame: 30, value: -180 },
    ]);
    expect(evaluateNativeParameterTrack(rotation!, 15)).toBe(-180);
  });

  it("does not turn the layer's existing rotation into an unrequested keyframe", async () => {
    const memory = memoryOptions(project());
    const api = renderCommit(memory.options);
    const target = selection();
    target.computedStyles = {
      transform: "matrix(0.906307787, 0.422618262, -0.422618262, 0.906307787, 0, 0)",
      opacity: "1",
      width: "640px",
      height: "360px",
    };

    await api.commitAnimatedProperty(target, "rotation", -180, { intent: "keyframe" });

    const saved = parseNativeProjectDocument(JSON.parse(memory.getContent()!));
    const rotation = saved.sequence.tracks[0]!.clips[0]!.parameterTracks.find(
      (track) => track.parameterId === "transform.rotation",
    )!;
    expect(rotation.keyframes.map(({ frame, value }) => ({ frame, value }))).toEqual([
      { frame: 30, value: -180 },
    ]);
    expect(evaluateNativeParameterTrack(rotation, 15)).toBe(-180);
  });

  it("commits a mixed native transform batch with one write, revision, and history entry", async () => {
    const memory = memoryOptions(project());
    const api = renderCommit(memory.options);

    await expect(
      api.commitAnimatedProperties(
        selection(),
        { x: 120, y: -40, rotation: -180, opacity: 0.5 },
        { intent: "keyframe" },
      ),
    ).resolves.toBe("native");

    expect(memory.writeProjectFile).toHaveBeenCalledTimes(1);
    expect(memory.recordHistory).toHaveBeenCalledTimes(1);
    const saved = parseNativeProjectDocument(JSON.parse(memory.getContent()!));
    expect(saved.revision).toBe(8);
    expect(
      saved.sequence.tracks[0]!.clips[0]!.parameterTracks.map((track) => track.parameterId),
    ).toEqual([
      "transform.position.x",
      "transform.position.y",
      "transform.rotation",
      "visual.opacity",
    ]);
  });

  it("routes all exposed 3D transform channels through one native commit", async () => {
    const memory = memoryOptions(project());
    const api = renderCommit(memory.options);

    await expect(
      api.commitAnimatedProperties(
        selection(),
        { z: 120, rotationX: 12, rotationY: -18, rotationZ: 30, scaleZ: 0.8, transformPerspective: 900 },
        { intent: "keyframe" },
      ),
    ).resolves.toBe("native");

    expect(memory.legacyCommitProperties).not.toHaveBeenCalled();
    expect(memory.writeProjectFile).toHaveBeenCalledOnce();
    const saved = parseNativeProjectDocument(JSON.parse(memory.getContent()!));
    expect(saved.sequence.tracks[0]!.clips[0]!.parameterTracks.map((track) => track.parameterId)).toEqual([
      "transform.position.z",
      "transform.rotationX",
      "transform.rotationY",
      "transform.rotation",
      "transform.scaleZ",
      "transform.perspective",
    ]);
  });

  it.each([
    ["absent sidecar", null, selection(), { rotation: -180 }],
    ["unmatched clip", project(), selection("clip:missing"), { rotation: -180 }],
    ["unsupported property", project(), selection(), { color: "red" }],
  ] as const)("falls back to legacy exactly once for %s", async (_label, native, target, props) => {
    const memory = memoryOptions(native);
    const api = renderCommit(memory.options);

    await expect(
      api.commitAnimatedProperties(target, props, { intent: "keyframe" }),
    ).resolves.toBe("legacy");

    expect(memory.legacyCommitProperties).toHaveBeenCalledTimes(1);
    expect(memory.legacyCommitProperties).toHaveBeenCalledWith(target, props);
    expect(memory.writeProjectFile).not.toHaveBeenCalled();
    expect(memory.recordHistory).not.toHaveBeenCalled();
  });

  it("does not partially write a mixed native/unsupported batch before legacy fallback", async () => {
    const memory = memoryOptions(project());
    const api = renderCommit(memory.options);
    const target = selection();
    const props = { rotation: -180, color: "red" };

    await expect(
      api.commitAnimatedProperties(target, props, { intent: "keyframe" }),
    ).resolves.toBe("legacy");

    expect(memory.legacyCommitProperties).toHaveBeenCalledOnce();
    expect(memory.writeProjectFile).not.toHaveBeenCalled();
    expect(memory.getContent()).toBe(serializeNativeProjectDocument(project()));
  });

  it("rejects an invalid native edit without mutating native or legacy state", async () => {
    const memory = memoryOptions(project(), 0);
    const api = renderCommit(memory.options);

    await expect(
      api.commitAnimatedProperty(selection(), "rotation", -180, { intent: "keyframe" }),
    ).rejects.toBeInstanceOf(NativeProjectEditRoutingError);
    expect(memory.legacyCommitProperties).not.toHaveBeenCalled();
    expect(memory.writeProjectFile).not.toHaveBeenCalled();
  });

  it("stores an ordinary edit as a static clip value when auto-keyframing is off", async () => {
    const memory = memoryOptions(project(), 2, false);
    const api = renderCommit(memory.options);

    await expect(api.commitAnimatedProperty(selection(), "rotation", -180)).resolves.toBe(
      "native",
    );

    const saved = parseNativeProjectDocument(JSON.parse(memory.getContent()!));
    const clip = saved.sequence.tracks[0]!.clips[0]!;
    expect(clip.staticParameters).toMatchObject({ "transform.rotation": -180 });
    expect(clip.parameterTracks).toHaveLength(0);
  });

  it("offsets every authored value when editing between keys with auto-keyframing off", async () => {
    const native = project();
    native.sequence.tracks[0]!.clips[0]!.parameterTracks = [
      createNativeParameterTrack({
        id: "parameter:rotation",
        parameterId: "transform.rotation",
        valueType: "number",
        frameRate: native.frameRate,
        keyframes: [
          { id: "key:0", frame: 0, value: 0, outgoing: { type: "linear" } },
          { id: "key:60", frame: 60, value: -180, outgoing: { type: "hold" } },
        ],
      }),
    ];
    const memory = memoryOptions(native, 2, false);
    const api = renderCommit(memory.options);

    await api.commitAnimatedProperty(selection(), "rotation", -120);

    const saved = parseNativeProjectDocument(JSON.parse(memory.getContent()!));
    const rotation = saved.sequence.tracks[0]!.clips[0]!.parameterTracks[0]!;
    expect(rotation.keyframes.map(({ frame, value, outgoing }) => ({ frame, value, outgoing }))).toEqual([
      { frame: 0, value: -30, outgoing: { type: "linear" } },
      { frame: 60, value: -210, outgoing: { type: "hold" } },
    ]);
    expect(evaluateNativeParameterTrack(rotation, 30)).toBe(-120);
  });

  it("changes only the exact authored key under the playhead when auto-keyframing is off", async () => {
    const native = project();
    native.sequence.tracks[0]!.clips[0]!.parameterTracks = [
      createNativeParameterTrack({
        id: "parameter:rotation",
        parameterId: "transform.rotation",
        valueType: "number",
        frameRate: native.frameRate,
        keyframes: [
          { id: "key:0", frame: 0, value: 0, outgoing: { type: "linear" } },
          { id: "key:30", frame: 30, value: -90, outgoing: { type: "hold" } },
          { id: "key:60", frame: 60, value: -180, outgoing: { type: "hold" } },
        ],
      }),
    ];
    const memory = memoryOptions(native, 2, false);
    const api = renderCommit(memory.options);

    await api.commitAnimatedProperty(selection(), "rotation", -135);

    const saved = parseNativeProjectDocument(JSON.parse(memory.getContent()!));
    expect(
      saved.sequence.tracks[0]!.clips[0]!.parameterTracks[0]!.keyframes.map(
        ({ frame, value }) => ({ frame, value }),
      ),
    ).toEqual([
      { frame: 0, value: 0 },
      { frame: 30, value: -135 },
      { frame: 60, value: -180 },
    ]);
  });

  it("still creates a keyframe for an ordinary edit when auto-keyframing is enabled", async () => {
    const memory = memoryOptions(project(), 2, true);
    const api = renderCommit(memory.options);

    await api.commitAnimatedProperty(selection(), "rotation", -180);

    const saved = parseNativeProjectDocument(JSON.parse(memory.getContent()!));
    expect(saved.sequence.tracks[0]!.clips[0]!.staticParameters).toEqual({});
    expect(saved.sequence.tracks[0]!.clips[0]!.parameterTracks[0]!.keyframes).toEqual([
      expect.objectContaining({ frame: 30, value: -180 }),
    ]);
  });

  it("replans once on a newer persisted revision without falling back or duplicating history", async () => {
    const supplied = project(7);
    const persisted = project(8);
    persisted.canvas.background = "#123456";
    let content = serializeNativeProjectDocument(persisted);
    const writeProjectFile = vi.fn(async (_path: string, next: string, expected?: string) => {
      expect(expected).toBe(content);
      content = next;
    });
    const recordHistory = vi.fn();
    const onNativeDocumentCommitted = vi.fn();
    const legacyCommitProperties = vi.fn(async () => undefined);
    const api = renderCommit({
      nativeDocument: supplied,
      readOptionalProjectFile: async () => content,
      writeProjectFile,
      recordHistory,
      onNativeDocumentCommitted,
      getPlayheadSeconds: () => 2,
      getAutoKeyframeEnabled: () => false,
      legacyCommitProperties,
    });

    await expect(api.commitAnimatedProperty(selection(), "rotation", -180)).resolves.toBe("native");

    const saved = parseNativeProjectDocument(JSON.parse(content));
    expect(saved.revision).toBe(9);
    expect(saved.canvas.background).toBe("#123456");
    expect(saved.sequence.tracks[0]!.clips[0]!.staticParameters).toMatchObject({
      "transform.rotation": -180,
    });
    expect(writeProjectFile).toHaveBeenCalledOnce();
    expect(recordHistory).toHaveBeenCalledOnce();
    expect(onNativeDocumentCommitted).toHaveBeenCalledOnce();
    expect(legacyCommitProperties).not.toHaveBeenCalled();
  });
});
