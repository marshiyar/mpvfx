import { describe, expect, it, vi } from "vitest";

import { createNativeParameterTrack } from "../../project/nativeKeyframeTypes";
import {
  NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
  parseNativeProjectDocument,
  type NativeProjectDocument,
} from "../../project/nativeProjectDocument";
import { deleteSelectedKeyframes } from "./deleteSelectedKeyframes";

const address = (parameterId: string) => ({
  sequenceId: "sequence:main",
  trackId: "track:video",
  clipId: "clip:first",
  parameterId,
});

const documentFixture = (): NativeProjectDocument => {
  const frameRate = { numerator: 30, denominator: 1 } as const;
  return parseNativeProjectDocument({
    schemaVersion: NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
    id: "project:keyboard",
    revision: 0,
    frameRate,
    canvas: { width: 1920, height: 1080, background: "#111" },
    assets: [{ id: "asset:v", kind: "video", name: "v.mov", durationFrames: 200 }],
    sequence: {
      id: "sequence:main",
      name: "Main",
      tracks: [
        {
          id: "track:video",
          kind: "video",
          clips: [
            {
              id: "clip:first",
              assetId: "asset:v",
              startFrame: 0,
              durationFrames: 120,
              sourceInFrame: 0,
              muted: false,
              effects: [],
              parameterTracks: [
                createNativeParameterTrack({
                  id: "animation:x",
                  parameterId: "transform.position.x",
                  valueType: "number",
                  frameRate,
                  keyframes: [
                    { id: "x:0", frame: 0, value: 0, outgoing: { type: "linear" } },
                    { id: "x:30", frame: 30, value: 30, outgoing: { type: "linear" } },
                    { id: "x:60", frame: 60, value: 60, outgoing: { type: "linear" } },
                  ],
                }),
                createNativeParameterTrack({
                  id: "animation:rotation",
                  parameterId: "transform.rotation",
                  valueType: "number",
                  frameRate,
                  keyframes: [
                    { id: "r:0", frame: 0, value: 0, outgoing: { type: "linear" } },
                    { id: "r:60", frame: 60, value: -180, outgoing: { type: "linear" } },
                  ],
                }),
              ],
            },
          ],
        },
      ],
    },
  });
};

describe("native selected-keyframe deletion routing", () => {
  it("commits one atomic native document edit across parameter selections", async () => {
    const commitNativeProject = vi.fn().mockResolvedValue(true);
    const deleteLegacySelectedKeyframes = vi.fn().mockResolvedValue(true);

    await expect(
      deleteSelectedKeyframes({
        nativeDocument: documentFixture(),
        nativeSelection: [
          { address: address("transform.position.x"), frame: 30 },
          { address: address("transform.position.x"), frame: 60 },
          { address: address("transform.rotation"), frame: 60 },
        ],
        commitNativeProject,
        deleteLegacySelectedKeyframes,
      }),
    ).resolves.toBe(true);

    expect(commitNativeProject).toHaveBeenCalledTimes(1);
    const committed = commitNativeProject.mock.calls[0]![0];
    const clip = committed.document.sequence.tracks[0]!.clips[0]!;
    expect(
      clip.parameterTracks.find((track) => track.parameterId === "transform.position.x")!.keyframes,
    ).toHaveLength(1);
    expect(
      clip.parameterTracks.find((track) => track.parameterId === "transform.rotation")!.keyframes,
    ).toHaveLength(1);
    expect(committed.label).toBe("Delete keyframes");
    expect(deleteLegacySelectedKeyframes).not.toHaveBeenCalled();
  });

  it("rejects a mixed valid/missing native selection without commit or legacy deletion", async () => {
    const commitNativeProject = vi.fn().mockResolvedValue(true);
    const deleteLegacySelectedKeyframes = vi.fn().mockResolvedValue(true);

    await expect(
      deleteSelectedKeyframes({
        nativeDocument: documentFixture(),
        nativeSelection: [
          { address: address("transform.position.x"), frame: 30 },
          { address: address("transform.rotation"), frame: 45 },
        ],
        commitNativeProject,
        deleteLegacySelectedKeyframes,
      }),
    ).resolves.toBe(false);

    expect(commitNativeProject).not.toHaveBeenCalled();
    expect(deleteLegacySelectedKeyframes).not.toHaveBeenCalled();
  });

  it("deduplicates identical native addresses before the atomic command", async () => {
    const commitNativeProject = vi.fn().mockResolvedValue(true);
    const selected = { address: address("transform.position.x"), frame: 30 };

    await deleteSelectedKeyframes({
      nativeDocument: documentFixture(),
      nativeSelection: [selected, selected],
      commitNativeProject,
      deleteLegacySelectedKeyframes: vi.fn().mockResolvedValue(true),
    });

    expect(commitNativeProject).toHaveBeenCalledTimes(1);
    const clip = commitNativeProject.mock.calls[0]![0].document.sequence.tracks[0]!.clips[0]!;
    expect(
      clip.parameterTracks.find((track) => track.parameterId === "transform.position.x")!.keyframes
        .map((keyframe) => keyframe.frame),
    ).toEqual([0, 60]);
  });

  it("uses the legacy deletion callback only when no native selection is present", async () => {
    const legacy = vi.fn().mockResolvedValue(true);

    await expect(
      deleteSelectedKeyframes({
        nativeDocument: documentFixture(),
        nativeSelection: [],
        commitNativeProject: vi.fn().mockResolvedValue(true),
        deleteLegacySelectedKeyframes: legacy,
      }),
    ).resolves.toBe(true);

    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it("does not fall through to legacy when a native commit rejects", async () => {
    const legacy = vi.fn().mockResolvedValue(true);
    await expect(
      deleteSelectedKeyframes({
        nativeDocument: documentFixture(),
        nativeSelection: [{ address: address("transform.position.x"), frame: 30 }],
        commitNativeProject: vi.fn().mockRejectedValue(new Error("conflict")),
        deleteLegacySelectedKeyframes: legacy,
      }),
    ).resolves.toBe(false);
    expect(legacy).not.toHaveBeenCalled();
  });
});
