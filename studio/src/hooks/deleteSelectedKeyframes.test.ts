import { afterEach, describe, expect, it, vi } from "vitest";
import { usePlayerStore } from "../player/store/playerStore";
import { deleteSelectedKeyframes } from "./deleteSelectedKeyframes";
import { createNativeParameterTrack } from "../project/nativeKeyframeTypes";
import { parseNativeProjectDocument } from "../project/nativeProjectDocument";
import { timelineKeyframeSelectionKey } from "../player/components/timelineKeyframeIdentity";

afterEach(() => {
  usePlayerStore.getState().reset();
});

function select(...keyframes: string[]) {
  usePlayerStore.setState({
    selectedElementId: "card",
    selectedKeyframes: new Set(keyframes),
  });
}

function nativeDocument() {
  const frameRate = { numerator: 30, denominator: 1 } as const;
  return parseNativeProjectDocument({
    schemaVersion: 1,
    id: "project:native",
    revision: 0,
    frameRate,
    canvas: { width: 1920, height: 1080, background: "#111" },
    assets: [{ id: "asset:v", kind: "video", name: "v.mp4", durationFrames: 120 }],
    sequence: {
      id: "sequence:main",
      name: "Main",
      tracks: [{
        id: "track:v1",
        kind: "video",
        clips: [{
          id: "clip:v",
          assetId: "asset:v",
          startFrame: 0,
          durationFrames: 120,
          sourceInFrame: 0,
          muted: false,
          effects: [],
          parameterTracks: [createNativeParameterTrack({
            id: "parameter:x",
            parameterId: "transform.position.x",
            valueType: "number",
            frameRate,
            keyframes: [
              { id: "x:0", frame: 0, value: 0, outgoing: { type: "linear" } },
              { id: "x:30", frame: 30, value: 30, outgoing: { type: "linear" } },
            ],
          }), createNativeParameterTrack({
            id: "parameter:y",
            parameterId: "transform.position.y",
            valueType: "number",
            frameRate,
            keyframes: [
              { id: "y:0", frame: 0, value: 0, outgoing: { type: "linear" } },
              { id: "y:30", frame: 30, value: 30, outgoing: { type: "linear" } },
            ],
          })],
        }],
      }],
    },
  });
}

function nativeSelectionKey(frame: number): string {
  return timelineKeyframeSelectionKey("index.html#video", {
    percentage: (frame / 120) * 100,
    tweenPercentage: (frame / 120) * 100,
    propertyGroup: "position",
    animationId: "parameter:x",
    native: {
      sequenceId: "sequence:main",
      trackId: "track:v1",
      clipId: "clip:v",
      parameterId: "transform.position.x",
      keyframeId: `x:${frame}`,
      frame,
    },
  });
}

describe("deleteSelectedKeyframes settlement", () => {
  it("routes native selection atomically and clears it only after native commit succeeds", async () => {
    const selected = nativeSelectionKey(30);
    usePlayerStore.setState({ selectedElementId: "index.html#video", selectedKeyframes: new Set([selected]) });
    const commitNativeProject = vi.fn().mockResolvedValue(true);
    const handleGsapRemoveKeyframes = vi.fn().mockResolvedValue(true);

    await expect(deleteSelectedKeyframes({
      selectedGsapAnimations: [{ id: "legacy", keyframes: {} }],
      handleGsapRemoveKeyframes,
      nativeDocument: nativeDocument(),
      commitNativeProject,
    })).resolves.toBe(true);

    expect(commitNativeProject).toHaveBeenCalledTimes(1);
    expect(handleGsapRemoveKeyframes).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().selectedKeyframes).toEqual(new Set());
  });

  it("deletes every scalar channel represented by one grouped native diamond atomically", async () => {
    const nativeTargets = ["transform.position.x", "transform.position.y"].map(
      (parameterId) => ({
        sequenceId: "sequence:main",
        trackId: "track:v1",
        clipId: "clip:v",
        parameterId,
        keyframeId: `${parameterId.endsWith(".x") ? "x" : "y"}:30`,
        frame: 30,
      }),
    );
    const selected = timelineKeyframeSelectionKey("index.html#video", {
      percentage: 25,
      tweenPercentage: 25,
      propertyGroup: "position",
      animationId: "native-parameter:position",
      native: nativeTargets[0]!,
      nativeTargets,
    });
    usePlayerStore.setState({
      selectedElementId: "index.html#video",
      selectedKeyframes: new Set([selected]),
    });
    const commitNativeProject = vi.fn().mockResolvedValue(true);

    await expect(deleteSelectedKeyframes({
      selectedGsapAnimations: [],
      handleGsapRemoveKeyframes: vi.fn().mockResolvedValue(true),
      nativeDocument: nativeDocument(),
      commitNativeProject,
    })).resolves.toBe(true);

    const committed = commitNativeProject.mock.calls[0]?.[0].document;
    expect(committed.sequence.tracks[0].clips[0].parameterTracks.map((track) => ({
      parameterId: track.parameterId,
      frames: track.keyframes.map((keyframe) => keyframe.frame),
    }))).toEqual([
      { parameterId: "transform.position.x", frames: [0] },
      { parameterId: "transform.position.y", frames: [0] },
    ]);
    expect(usePlayerStore.getState().selectedKeyframes).toEqual(new Set());
  });

  it("does not fall through to GSAP or clear selection when native commit fails", async () => {
    const selected = nativeSelectionKey(30);
    usePlayerStore.setState({ selectedElementId: "index.html#video", selectedKeyframes: new Set([selected]) });
    const commitNativeProject = vi.fn().mockResolvedValue(false);
    const handleGsapRemoveKeyframes = vi.fn().mockResolvedValue(true);

    await expect(deleteSelectedKeyframes({
      selectedGsapAnimations: [{ id: "legacy", keyframes: {} }],
      handleGsapRemoveKeyframes,
      nativeDocument: nativeDocument(),
      commitNativeProject,
    })).resolves.toBe(false);

    expect(handleGsapRemoveKeyframes).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().selectedKeyframes).toEqual(new Set([selected]));
  });

  it("submits same-element multi-key deletion as one atomic request", async () => {
    select("card:10", "card:90");
    const handleGsapRemoveKeyframes = vi.fn().mockResolvedValue(true);

    await expect(
      deleteSelectedKeyframes({
        selectedGsapAnimations: [{ id: "card-position", keyframes: {} }],
        handleGsapRemoveKeyframes,
      }),
    ).resolves.toBe(true);

    expect(handleGsapRemoveKeyframes).toHaveBeenCalledExactlyOnceWith(
      [
        { animationId: "card-position", percentage: 10 },
        { animationId: "card-position", percentage: 90 },
      ],
      expect.objectContaining({ coalesceMs: Infinity, softReload: true }),
    );
    expect(usePlayerStore.getState().selectedKeyframes).toEqual(new Set());
  });

  it("clears the requested selection only after every durable removal succeeds", async () => {
    select("card:10", "card:90");
    let finishRemoval!: (success: boolean) => void;
    const handleGsapRemoveKeyframes = vi
      .fn<() => Promise<boolean>>()
      .mockImplementation(() =>
        new Promise<boolean>((resolve) => {
          finishRemoval = resolve;
        }),
      );

    const pending = deleteSelectedKeyframes({
      selectedGsapAnimations: [{ id: "card-position", keyframes: {} }],
      handleGsapRemoveKeyframes,
    });

    expect(usePlayerStore.getState().selectedKeyframes).toEqual(new Set(["card:10", "card:90"]));
    finishRemoval(true);
    await expect(pending).resolves.toBe(true);
    expect(usePlayerStore.getState().selectedKeyframes).toEqual(new Set());
  });

  it("preserves selection when any requested durable removal is rejected", async () => {
    select("card:10", "card:90");
    const handleGsapRemoveKeyframes = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);

    await expect(
      deleteSelectedKeyframes({
        selectedGsapAnimations: [{ id: "card-position", keyframes: {} }],
        handleGsapRemoveKeyframes,
      }),
    ).resolves.toBe(false);

    expect(usePlayerStore.getState().selectedKeyframes).toEqual(new Set(["card:10", "card:90"]));
  });

  it("does not let a late successful delete clear a newer selection", async () => {
    select("card:10");
    let settleRemoval!: (success: boolean) => void;
    const pending = deleteSelectedKeyframes({
      selectedGsapAnimations: [{ id: "card-position", keyframes: {} }],
      handleGsapRemoveKeyframes: vi.fn(
        () => new Promise<boolean>((resolve) => {
          settleRemoval = resolve;
        }),
      ),
    });

    select("card:90");
    settleRemoval(true);
    await expect(pending).resolves.toBe(true);

    expect(usePlayerStore.getState().selectedKeyframes).toEqual(new Set(["card:90"]));
  });
});
