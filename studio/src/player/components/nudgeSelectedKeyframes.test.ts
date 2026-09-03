import { describe, expect, it, vi } from "vitest";

import { createNativeParameterTrack } from "../../project/nativeKeyframeTypes";
import {
  NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
  parseNativeProjectDocument,
  type NativeProjectDocument,
} from "../../project/nativeProjectDocument";
import { nudgeSelectedKeyframes } from "./nudgeSelectedKeyframes";

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
    id: "project:nudge",
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
                    { id: "x:65", frame: 65, value: 65, outgoing: { type: "linear" } },
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

describe("native selected-keyframe keyboard nudge routing", () => {
  it("nudges native multi-selection atomically by one integer frame", async () => {
    const commitNativeProject = vi.fn().mockResolvedValue(true);
    const legacy = vi.fn().mockResolvedValue(true);

    await expect(
      nudgeSelectedKeyframes(
        {
          nativeDocument: documentFixture(),
          nativeSelection: [
            { address: address("transform.position.x"), frame: 30 },
            { address: address("transform.rotation"), frame: 60 },
          ],
          commitNativeProject,
          nudgeLegacySelectedKeyframes: legacy,
        },
        1,
        false,
      ),
    ).resolves.toBe(true);

    expect(commitNativeProject).toHaveBeenCalledTimes(1);
    const committed = commitNativeProject.mock.calls[0]![0];
    const clip = committed.document.sequence.tracks[0]!.clips[0]!;
    expect(
      clip.parameterTracks.find((track) => track.parameterId === "transform.position.x")!.keyframes
        .map((keyframe) => keyframe.frame),
    ).toEqual([0, 31, 60, 65]);
    expect(
      clip.parameterTracks.find((track) => track.parameterId === "transform.rotation")!.keyframes
        .map((keyframe) => keyframe.frame),
    ).toEqual([0, 61]);
    expect(committed.label).toBe("Nudge keyframes");
    expect(legacy).not.toHaveBeenCalled();
  });

  it("clamps a ten-frame request to the tightest stationary neighbor across groups", async () => {
    const commitNativeProject = vi.fn().mockResolvedValue(true);
    const onNativeSelectionCommitted = vi.fn();
    await nudgeSelectedKeyframes(
      {
        nativeDocument: documentFixture(),
        nativeSelection: [
          { address: address("transform.position.x"), frame: 30 },
          { address: address("transform.position.x"), frame: 60 },
          { address: address("transform.rotation"), frame: 60 },
        ],
        commitNativeProject,
        onNativeSelectionCommitted,
        nudgeLegacySelectedKeyframes: vi.fn().mockResolvedValue(true),
      },
      1,
      true,
    );

    const clip = commitNativeProject.mock.calls[0]![0].document.sequence.tracks[0]!.clips[0]!;
    expect(
      clip.parameterTracks.find((track) => track.parameterId === "transform.position.x")!.keyframes
        .map((keyframe) => keyframe.frame),
    ).toEqual([0, 34, 64, 65]);
    expect(
      clip.parameterTracks.find((track) => track.parameterId === "transform.rotation")!.keyframes
        .map((keyframe) => keyframe.frame),
    ).toEqual([0, 64]);
    expect(onNativeSelectionCommitted).toHaveBeenCalledWith([
      { address: address("transform.position.x"), frame: 34 },
      { address: address("transform.position.x"), frame: 64 },
      { address: address("transform.rotation"), frame: 64 },
    ]);
  });

  it("does not move or commit when a selected keyframe is clamped at the clip boundary", async () => {
    const commitNativeProject = vi.fn().mockResolvedValue(true);
    const legacy = vi.fn().mockResolvedValue(true);

    await expect(
      nudgeSelectedKeyframes(
        {
          nativeDocument: documentFixture(),
          nativeSelection: [{ address: address("transform.position.x"), frame: 0 }],
          commitNativeProject,
          nudgeLegacySelectedKeyframes: legacy,
        },
        -1,
        true,
      ),
    ).resolves.toBe(false);
    expect(commitNativeProject).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
  });

  it("rejects missing or fractional native selection atomically", async () => {
    for (const frame of [45, 30.5]) {
      const commitNativeProject = vi.fn().mockResolvedValue(true);
      await expect(
        nudgeSelectedKeyframes(
          {
            nativeDocument: documentFixture(),
            nativeSelection: [
              { address: address("transform.position.x"), frame: 30 },
              { address: address("transform.rotation"), frame },
            ],
            commitNativeProject,
            nudgeLegacySelectedKeyframes: vi.fn().mockResolvedValue(true),
          },
          1,
          false,
        ),
      ).resolves.toBe(false);
      expect(commitNativeProject).not.toHaveBeenCalled();
    }
  });

  it("uses legacy fallback only when no native selection exists", async () => {
    const legacy = vi.fn().mockResolvedValue(true);
    await expect(
      nudgeSelectedKeyframes(
        {
          nativeDocument: documentFixture(),
          nativeSelection: [],
          commitNativeProject: vi.fn().mockResolvedValue(true),
          nudgeLegacySelectedKeyframes: legacy,
        },
        -1,
        false,
      ),
    ).resolves.toBe(true);
    expect(legacy).toHaveBeenCalledExactlyOnceWith(-1, false);
  });

  it("does not run legacy fallback when native persistence rejects", async () => {
    const legacy = vi.fn().mockResolvedValue(true);
    await expect(
      nudgeSelectedKeyframes(
        {
          nativeDocument: documentFixture(),
          nativeSelection: [{ address: address("transform.position.x"), frame: 30 }],
          commitNativeProject: vi.fn().mockRejectedValue(new Error("conflict")),
          nudgeLegacySelectedKeyframes: legacy,
        },
        1,
        false,
      ),
    ).resolves.toBe(false);
    expect(legacy).not.toHaveBeenCalled();
  });
});
