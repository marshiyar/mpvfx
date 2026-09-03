// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseNativeProjectDocument,
  serializeNativeProjectDocument,
  type NativeProjectDocument,
} from "../project/nativeProjectDocument";
import {
  NativeProjectKeyframeCommandError,
  useNativeProjectKeyframeCommands,
  type NativeProjectKeyframeCommandApi,
  type NativeProjectKeyframeTarget,
} from "./useNativeProjectKeyframeCommands";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const project = (revision = 7): NativeProjectDocument =>
  parseNativeProjectDocument({
    schemaVersion: 1,
    id: "project:commands",
    revision,
    frameRate: { numerator: 30, denominator: 1 },
    canvas: { width: 1920, height: 1080, background: "#000000" },
    assets: [{ id: "asset:a", kind: "video", name: "a.mov", durationFrames: 120 }],
    sequence: {
      id: "sequence:main",
      name: "Main",
      tracks: [{
        id: "track:v1",
        kind: "video",
        clips: [{
          id: "clip:a",
          assetId: "asset:a",
          startFrame: 0,
          durationFrames: 90,
          sourceInFrame: 0,
          muted: false,
          effects: [],
          parameterTracks: [{
            schemaVersion: 1,
            id: "parameter:rotation",
            parameterId: "transform.rotation",
            valueType: "number",
            frameRate: { numerator: 30, denominator: 1 },
            keyframes: [
              { id: "key:0", frame: 0, value: 0, outgoing: { type: "linear" } },
              { id: "key:30", frame: 30, value: -180, outgoing: { type: "linear" } },
              { id: "key:60", frame: 60, value: -360, outgoing: { type: "linear" } },
            ],
          }],
        }],
      }],
    },
  });

const target = (frame: number): NativeProjectKeyframeTarget => ({
  sequenceId: "sequence:main",
  trackId: "track:v1",
  clipId: "clip:a",
  parameterId: "transform.rotation",
  frame,
});

let roots: Root[] = [];
afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
  document.body.replaceChildren();
});

function harness(initial = project()) {
  let content = serializeNativeProjectDocument(initial);
  const writeProjectFile = vi.fn(async (_path: string, next: string, expected?: string) => {
    expect(expected).toBe(content);
    content = next;
  });
  const recordHistory = vi.fn();
  const onNativeDocumentCommitted = vi.fn();
  let api!: NativeProjectKeyframeCommandApi;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  function Harness() {
    api = useNativeProjectKeyframeCommands({
      nativeDocument: initial,
      readOptionalProjectFile: async () => content,
      writeProjectFile,
      recordHistory,
      onNativeDocumentCommitted,
    });
    return null;
  }
  act(() => root.render(<Harness />));
  return {
    get api() { return api; },
    get document() { return parseNativeProjectDocument(JSON.parse(content)); },
    writeProjectFile,
    recordHistory,
    onNativeDocumentCommitted,
  };
}

describe("useNativeProjectKeyframeCommands", () => {
  it("deletes an authored keyframe in one revisioned transaction", async () => {
    const state = harness();

    await state.api.deleteKeyframe(target(30));

    expect(state.document.revision).toBe(8);
    expect(state.document.sequence.tracks[0]!.clips[0]!.parameterTracks[0]!.keyframes.map((key) => key.frame))
      .toEqual([0, 60]);
    expect(state.writeProjectFile).toHaveBeenCalledOnce();
    expect(state.recordHistory).toHaveBeenCalledOnce();
    expect(state.onNativeDocumentCommitted).toHaveBeenCalledOnce();
  });

  it("moves one keyframe on integer frames and preserves its authored value", async () => {
    const state = harness();

    await state.api.moveKeyframe(target(30), 45);

    expect(
      state.document.sequence.tracks[0]!.clips[0]!.parameterTracks[0]!.keyframes,
    ).toContainEqual(expect.objectContaining({ frame: 45, value: -180 }));
  });

  it("moves grouped scalar keyframes atomically in one revision and history entry", async () => {
    const initial = project();
    const clip = initial.sequence.tracks[0]!.clips[0]!;
    clip.parameterTracks.push({
      schemaVersion: 1,
      id: "parameter:x",
      parameterId: "transform.position.x",
      valueType: "number",
      frameRate: { numerator: 30, denominator: 1 },
      keyframes: [
        { id: "key:x:0", frame: 0, value: 0, outgoing: { type: "linear" } },
        { id: "key:x:30", frame: 30, value: 100, outgoing: { type: "linear" } },
      ],
    }, {
      schemaVersion: 1,
      id: "parameter:y",
      parameterId: "transform.position.y",
      valueType: "number",
      frameRate: { numerator: 30, denominator: 1 },
      keyframes: [
        { id: "key:y:0", frame: 0, value: 0, outgoing: { type: "linear" } },
        { id: "key:y:30", frame: 30, value: 50, outgoing: { type: "linear" } },
      ],
    });
    const state = harness(parseNativeProjectDocument(initial));
    const targets = ["transform.position.x", "transform.position.y"].map((parameterId) => ({
      ...target(30),
      parameterId,
    }));

    await state.api.moveKeyframes(targets, 45);

    expect(state.document.revision).toBe(8);
    expect(
      state.document.sequence.tracks[0]!.clips[0]!.parameterTracks
        .filter((track) => targets.some((candidate) => candidate.parameterId === track.parameterId))
        .map((track) => track.keyframes.map((keyframe) => keyframe.frame)),
    ).toEqual([[0, 45], [0, 45]]);
    expect(state.writeProjectFile).toHaveBeenCalledOnce();
    expect(state.recordHistory).toHaveBeenCalledOnce();
    expect(state.recordHistory).toHaveBeenCalledWith(
      expect.objectContaining({ label: "Move 2 keyframes" }),
    );
  });

  it("rejects a mixed invalid grouped move without writing either scalar", async () => {
    const state = harness();

    await expect(
      state.api.moveKeyframes([target(30), { ...target(89), parameterId: "missing.parameter" }], 45),
    ).rejects.toBeInstanceOf(NativeProjectKeyframeCommandError);

    expect(state.document.revision).toBe(7);
    expect(state.writeProjectFile).not.toHaveBeenCalled();
    expect(state.recordHistory).not.toHaveBeenCalled();
  });

  it("rejects an occupied move destination atomically without revision or history", async () => {
    const state = harness();

    await expect(state.api.moveKeyframe(target(30), 60)).rejects.toMatchObject({
      failure: { code: "frame-collision" },
    });

    expect(state.document.revision).toBe(7);
    expect(
      state.document.sequence.tracks[0]!.clips[0]!.parameterTracks[0]!.keyframes.map(
        (keyframe) => keyframe.frame,
      ),
    ).toEqual([0, 30, 60]);
    expect(state.writeProjectFile).not.toHaveBeenCalled();
    expect(state.recordHistory).not.toHaveBeenCalled();
    expect(state.onNativeDocumentCommitted).not.toHaveBeenCalled();
  });

  it("sets native outgoing interpolation without translating through a GSAP ease", async () => {
    const state = harness();
    const outgoing = {
      type: "cubic-bezier" as const,
      controlPoints: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
    };

    await state.api.setKeyframeInterpolation(target(0), outgoing);

    expect(
      state.document.sequence.tracks[0]!.clips[0]!.parameterTracks[0]!.keyframes[0]!.outgoing,
    ).toEqual(outgoing);
  });

  it("sets grouped scalar interpolation atomically in one revision and history entry", async () => {
    const initial = project();
    const clip = initial.sequence.tracks[0]!.clips[0]!;
    clip.parameterTracks.push(
      {
        schemaVersion: 1,
        id: "parameter:x",
        parameterId: "transform.position.x",
        valueType: "number",
        frameRate: { numerator: 30, denominator: 1 },
        keyframes: [
          { id: "key:x:0", frame: 0, value: 0, outgoing: { type: "linear" } },
          { id: "key:x:30", frame: 30, value: 100, outgoing: { type: "linear" } },
        ],
      },
      {
        schemaVersion: 1,
        id: "parameter:y",
        parameterId: "transform.position.y",
        valueType: "number",
        frameRate: { numerator: 30, denominator: 1 },
        keyframes: [
          { id: "key:y:0", frame: 0, value: 0, outgoing: { type: "linear" } },
          { id: "key:y:30", frame: 30, value: 50, outgoing: { type: "linear" } },
        ],
      },
    );
    const state = harness(parseNativeProjectDocument(initial));
    const targets = ["transform.position.x", "transform.position.y"].map((parameterId) => ({
      ...target(0),
      parameterId,
    }));
    const outgoing = { type: "hold" as const };

    await state.api.setKeyframesInterpolation(targets, outgoing);

    expect(state.document.revision).toBe(8);
    expect(
      state.document.sequence.tracks[0]!.clips[0]!.parameterTracks
        .filter((track) => targets.some((target) => target.parameterId === track.parameterId))
        .map((track) => track.keyframes[0]!.outgoing),
    ).toEqual([outgoing, outgoing]);
    expect(state.writeProjectFile).toHaveBeenCalledOnce();
    expect(state.recordHistory).toHaveBeenCalledOnce();
    expect(state.onNativeDocumentCommitted).toHaveBeenCalledOnce();
  });

  it("deletes all keyframes by collapsing the track to the evaluated current-frame value", async () => {
    const state = harness();

    await state.api.deleteAllKeyframes(target(15));

    expect(state.document.revision).toBe(8);
    const clip = state.document.sequence.tracks[0]!.clips[0]!;
    expect(clip.staticParameters).toEqual({ "transform.rotation": -90 });
    expect(clip.parameterTracks).toEqual([]);
    expect(state.writeProjectFile).toHaveBeenCalledOnce();
    expect(state.recordHistory).toHaveBeenCalledOnce();
    expect(state.recordHistory).toHaveBeenCalledWith(
      expect.objectContaining({ label: "Delete all keyframes" }),
    );
  });

  it("collapses grouped scalar tracks atomically in one revision and history entry", async () => {
    const initial = project();
    const clip = initial.sequence.tracks[0]!.clips[0]!;
    clip.parameterTracks.push({
      schemaVersion: 1,
      id: "parameter:x",
      parameterId: "transform.position.x",
      valueType: "number",
      frameRate: { numerator: 30, denominator: 1 },
      keyframes: [
        { id: "key:x:0", frame: 0, value: 0, outgoing: { type: "linear" } },
        { id: "key:x:30", frame: 30, value: 100, outgoing: { type: "linear" } },
      ],
    }, {
      schemaVersion: 1,
      id: "parameter:y",
      parameterId: "transform.position.y",
      valueType: "number",
      frameRate: { numerator: 30, denominator: 1 },
      keyframes: [
        { id: "key:y:0", frame: 0, value: 0, outgoing: { type: "linear" } },
        { id: "key:y:30", frame: 30, value: 50, outgoing: { type: "linear" } },
      ],
    });
    const state = harness(parseNativeProjectDocument(initial));
    const targets = ["transform.position.x", "transform.position.y"].map((parameterId) => ({
      ...target(15),
      parameterId,
    }));

    await state.api.deleteAllKeyframes(targets);

    expect(state.document.revision).toBe(8);
    expect(state.document.sequence.tracks[0]!.clips[0]!.staticParameters).toMatchObject({
      "transform.position.x": 50,
      "transform.position.y": 25,
    });
    expect(state.writeProjectFile).toHaveBeenCalledOnce();
    expect(state.recordHistory).toHaveBeenCalledOnce();
    expect(state.recordHistory).toHaveBeenCalledWith(
      expect.objectContaining({ label: "Delete all keyframes from 2 parameters" }),
    );
  });

  it("rejects delete-all at an invalid local frame without revision or history", async () => {
    const state = harness();

    await expect(state.api.deleteAllKeyframes(target(90))).rejects.toBeInstanceOf(
      NativeProjectKeyframeCommandError,
    );

    expect(state.document.revision).toBe(7);
    expect(state.writeProjectFile).not.toHaveBeenCalled();
    expect(state.recordHistory).not.toHaveBeenCalled();
  });

  it("rejects a mixed invalid delete batch without writing a partial document", async () => {
    const state = harness();

    await expect(state.api.deleteKeyframes([target(30), target(89)])).rejects.toBeInstanceOf(
      NativeProjectKeyframeCommandError,
    );

    expect(state.writeProjectFile).not.toHaveBeenCalled();
    expect(state.document.revision).toBe(7);
    expect(state.document.sequence.tracks[0]!.clips[0]!.parameterTracks[0]!.keyframes).toHaveLength(3);
  });

  it("rejects operations when there is no authoritative native document", async () => {
    let api!: NativeProjectKeyframeCommandApi;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    function Harness() {
      api = useNativeProjectKeyframeCommands({
        nativeDocument: null,
        readOptionalProjectFile: async () => null,
        writeProjectFile: vi.fn(),
      });
      return null;
    }
    act(() => root.render(<Harness />));

    await expect(api.deleteKeyframe(target(30))).rejects.toBeInstanceOf(
      NativeProjectKeyframeCommandError,
    );
  });

  it("rebases once onto a newer persisted revision without duplicating history", async () => {
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
    let api!: NativeProjectKeyframeCommandApi;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    function Harness() {
      api = useNativeProjectKeyframeCommands({
        nativeDocument: supplied,
        readOptionalProjectFile: async () => content,
        writeProjectFile,
        recordHistory,
        onNativeDocumentCommitted,
      });
      return null;
    }
    act(() => root.render(<Harness />));

    await api.deleteKeyframe(target(30));

    const saved = parseNativeProjectDocument(JSON.parse(content));
    expect(saved.revision).toBe(9);
    expect(saved.canvas.background).toBe("#123456");
    expect(saved.sequence.tracks[0]!.clips[0]!.parameterTracks[0]!.keyframes.map((key) => key.frame))
      .toEqual([0, 60]);
    expect(writeProjectFile).toHaveBeenCalledOnce();
    expect(recordHistory).toHaveBeenCalledOnce();
    expect(onNativeDocumentCommitted).toHaveBeenCalledOnce();
  });
});
