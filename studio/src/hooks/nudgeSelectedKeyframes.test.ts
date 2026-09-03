import { afterEach, describe, expect, it, vi } from "vitest";
import type { GsapAnimation } from "@hyperframes/core/gsap-parser";
import type { DomEditSelection } from "../components/editor/domEditingTypes";
import {
  timelineKeyframeSelectionKey,
  type TimelineKeyframeTarget,
} from "../player/components/timelineKeyframeIdentity";
import { usePlayerStore } from "../player/store/playerStore";
import { nudgeSelectedKeyframes } from "./nudgeSelectedKeyframes";
import { createNativeParameterTrack } from "../project/nativeKeyframeTypes";
import { parseNativeProjectDocument } from "../project/nativeProjectDocument";

const elementId = "index.html#box";

function selection(): DomEditSelection {
  return {
    id: "box",
    sourceFile: "index.html",
    selector: "#box",
    dataAttributes: { start: "0", duration: "120" },
  } as unknown as DomEditSelection;
}

function animation(
  id: string,
  percentages: number[],
  propertyGroup = "position",
): GsapAnimation {
  return {
    id,
    targetSelector: "#box",
    propertyGroup,
    method: "to",
    resolvedStart: 0,
    duration: 120,
    keyframes: {
      keyframes: percentages.map((percentage) => ({
        percentage,
        properties: { x: percentage },
      })),
    },
  } as unknown as GsapAnimation;
}

function key(target: TimelineKeyframeTarget): string {
  return timelineKeyframeSelectionKey(elementId, target);
}

function seedSelected(targets: TimelineKeyframeTarget[]) {
  const selectedKeyframes = new Set(targets.map(key));
  usePlayerStore.setState({
    selectedElementId: elementId,
    selectedKeyframes,
    elements: [
      {
        id: "box",
        key: elementId,
        start: 0,
        duration: 120,
        tag: "div",
      },
    ],
  });
  return selectedKeyframes;
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
              { id: "x:60", frame: 60, value: 60, outgoing: { type: "linear" } },
            ],
          }), createNativeParameterTrack({
            id: "parameter:y",
            parameterId: "transform.position.y",
            valueType: "number",
            frameRate,
            keyframes: [
              { id: "y:0", frame: 0, value: 0, outgoing: { type: "linear" } },
              { id: "y:30", frame: 30, value: 30, outgoing: { type: "linear" } },
              { id: "y:60", frame: 60, value: 60, outgoing: { type: "linear" } },
            ],
          })],
        }],
      }],
    },
  });
}

function nativeSelectionKey(frame: number, keyframeFrame = frame): string {
  return timelineKeyframeSelectionKey(elementId, {
    percentage: (frame / 120) * 100,
    tweenPercentage: (frame / 120) * 100,
    propertyGroup: "position",
    animationId: "parameter:x",
    native: {
      sequenceId: "sequence:main",
      trackId: "track:v1",
      clipId: "clip:v",
      parameterId: "transform.position.x",
      keyframeId: `x:${keyframeFrame}`,
      frame,
    },
  });
}

afterEach(() => usePlayerStore.getState().reset());

describe("nudgeSelectedKeyframes", () => {
  it("routes native selection through one atomic commit and re-keys selection after success", async () => {
    const selected = nativeSelectionKey(30);
    usePlayerStore.setState({
      selectedElementId: elementId,
      selectedKeyframes: new Set([selected]),
    });
    const commitNativeProject = vi.fn().mockResolvedValue(true);
    const handleGsapMoveKeyframes = vi.fn().mockResolvedValue(true);

    await expect(nudgeSelectedKeyframes({
      domEditSelection: selection(),
      selectedGsapAnimations: [animation("legacy", [0, 25, 50, 100])],
      handleGsapMoveKeyframes,
      nativeDocument: nativeDocument(),
      commitNativeProject,
    }, 1, false)).resolves.toBe(true);

    expect(commitNativeProject).toHaveBeenCalledTimes(1);
    expect(handleGsapMoveKeyframes).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().selectedKeyframes).toEqual(new Set([nativeSelectionKey(31, 30)]));
  });

  it("nudges every scalar channel represented by one grouped native diamond atomically", async () => {
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
    const selected = timelineKeyframeSelectionKey(elementId, {
      percentage: 25,
      tweenPercentage: 25,
      propertyGroup: "position",
      animationId: "native-parameter:position",
      native: nativeTargets[0]!,
      nativeTargets,
    });
    usePlayerStore.setState({
      selectedElementId: elementId,
      selectedKeyframes: new Set([selected]),
    });
    const commitNativeProject = vi.fn().mockResolvedValue(true);
    const document = nativeDocument();

    await expect(nudgeSelectedKeyframes({
      domEditSelection: selection(),
      selectedGsapAnimations: [],
      nativeDocument: document,
      commitNativeProject,
    }, 1, false)).resolves.toBe(true);

    const committed = commitNativeProject.mock.calls[0]?.[0].document;
    expect(committed.sequence.tracks[0].clips[0].parameterTracks.map((track) => ({
      parameterId: track.parameterId,
      frames: track.keyframes.map((keyframe) => keyframe.frame),
    }))).toEqual([
      { parameterId: "transform.position.x", frames: [0, 31, 60] },
      { parameterId: "transform.position.y", frames: [0, 31, 60] },
    ]);
    const [rekeyed] = usePlayerStore.getState().selectedKeyframes;
    expect(rekeyed).toContain('"frame":31');
    expect(rekeyed?.match(/"frame":31/g)).toHaveLength(3);
  });

  it("does not fall through to GSAP or re-key selection when native commit fails", async () => {
    const selected = nativeSelectionKey(30);
    usePlayerStore.setState({
      selectedElementId: elementId,
      selectedKeyframes: new Set([selected]),
    });
    const handleGsapMoveKeyframes = vi.fn().mockResolvedValue(true);

    await expect(nudgeSelectedKeyframes({
      domEditSelection: selection(),
      selectedGsapAnimations: [animation("legacy", [0, 25, 50, 100])],
      handleGsapMoveKeyframes,
      nativeDocument: nativeDocument(),
      commitNativeProject: vi.fn().mockResolvedValue(false),
    }, 1, false)).resolves.toBe(false);

    expect(handleGsapMoveKeyframes).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().selectedKeyframes).toEqual(new Set([selected]));
  });

  it("moves a same-element selection by ten frames atomically and preserves selection", async () => {
    const targets = [
      {
        percentage: 20,
        tweenPercentage: 20,
        animationId: "position",
        propertyGroup: "position",
      },
      {
        percentage: 40,
        tweenPercentage: 40,
        animationId: "position",
        propertyGroup: "position",
      },
    ];
    seedSelected(targets);
    usePlayerStore.getState().setActiveKeyframeTarget({
      elementId,
      animationId: "position",
      propertyGroup: "position",
      tweenPercentage: 20,
    });
    const handleGsapMoveKeyframes = vi.fn().mockResolvedValue(true);

    await expect(
      nudgeSelectedKeyframes(
        {
          domEditSelection: selection(),
          selectedGsapAnimations: [animation("position", [0, 20, 40, 100])],
          handleGsapMoveKeyframes,
        },
        1,
        true,
      ),
    ).resolves.toBe(true);

    expect(handleGsapMoveKeyframes).toHaveBeenCalledExactlyOnceWith([
      { animationId: "position", fromPercentage: 20, toPercentage: 20.2777777778 },
      { animationId: "position", fromPercentage: 40, toPercentage: 40.2777777778 },
    ]);
    expect(usePlayerStore.getState().selectedKeyframes).toEqual(
      new Set([
        key({ ...targets[0], percentage: 20.278, tweenPercentage: 20.2777777778 }),
        key({ ...targets[1], percentage: 40.278, tweenPercentage: 40.2777777778 }),
      ]),
    );
    expect(usePlayerStore.getState().activeKeyframeTarget?.tweenPercentage).toBe(20.2777777778);
  });

  it("re-keys the selection when a source refresh recreates the same selected-key set", async () => {
    const target = {
      percentage: 20,
      tweenPercentage: 20,
      animationId: "position",
      propertyGroup: "position",
    };
    const originalSelection = seedSelected([target]);
    const handleGsapMoveKeyframes = vi.fn().mockImplementation(async () => {
      // A successful source write can refresh the store before this coordinator
      // settles. That refresh may preserve the same logical selection in a new Set.
      usePlayerStore.setState({ selectedKeyframes: new Set(originalSelection) });
      return true;
    });

    await expect(
      nudgeSelectedKeyframes(
        {
          domEditSelection: selection(),
          selectedGsapAnimations: [animation("position", [0, 20, 100])],
          handleGsapMoveKeyframes,
        },
        1,
        false,
      ),
    ).resolves.toBe(true);

    expect(usePlayerStore.getState().selectedKeyframes).toEqual(
      new Set([
        key({
          ...target,
          percentage: 20.028,
          tweenPercentage: 20.0277777778,
        }),
      ]),
    );
  });

  it("does not replace a genuinely newer selection when a nudge settles late", async () => {
    const target = {
      percentage: 20,
      tweenPercentage: 20,
      animationId: "position",
      propertyGroup: "position",
    };
    seedSelected([target]);
    const newerSelection = new Set(["newer-user-selection"]);
    const handleGsapMoveKeyframes = vi.fn().mockImplementation(async () => {
      usePlayerStore.setState({ selectedKeyframes: newerSelection });
      return true;
    });

    await nudgeSelectedKeyframes(
      {
        domEditSelection: selection(),
        selectedGsapAnimations: [animation("position", [0, 20, 100])],
        handleGsapMoveKeyframes,
      },
      1,
      false,
    );

    expect(usePlayerStore.getState().selectedKeyframes).toBe(newerSelection);
  });

  it("uses the tightest neighbor limit across animation groups", async () => {
    seedSelected([
      {
        percentage: 50,
        tweenPercentage: 50,
        animationId: "position",
        propertyGroup: "position",
      },
      {
        percentage: 20,
        tweenPercentage: 20,
        animationId: "visual",
        propertyGroup: "visual",
      },
    ]);
    const handleGsapMoveKeyframes = vi.fn().mockResolvedValue(true);

    await nudgeSelectedKeyframes(
      {
        domEditSelection: selection(),
        selectedGsapAnimations: [
          animation("position", [0, 50, 50.0555555556, 100]),
          animation("visual", [0, 20, 100], "visual"),
        ],
        handleGsapMoveKeyframes,
      },
      1,
      true,
    );

    expect(handleGsapMoveKeyframes).toHaveBeenCalledExactlyOnceWith([
      { animationId: "position", fromPercentage: 50, toPercentage: 50.0277777778 },
      { animationId: "visual", fromPercentage: 20, toPercentage: 20.0277777778 },
    ]);
  });

  it("keeps the original selection and active target when persistence fails", async () => {
    const target = {
      percentage: 50,
      tweenPercentage: 50,
      animationId: "position",
      propertyGroup: "position",
    };
    const originalSelection = seedSelected([target]);
    usePlayerStore.getState().setActiveKeyframeTarget({
      elementId,
      animationId: "position",
      propertyGroup: "position",
      tweenPercentage: 50,
    });

    await expect(
      nudgeSelectedKeyframes(
        {
          domEditSelection: selection(),
          selectedGsapAnimations: [animation("position", [0, 50, 100])],
          handleGsapMoveKeyframes: vi.fn().mockResolvedValue(false),
        },
        -1,
        false,
      ),
    ).resolves.toBe(false);

    expect(usePlayerStore.getState().selectedKeyframes).toBe(originalSelection);
    expect(usePlayerStore.getState().activeKeyframeTarget?.tweenPercentage).toBe(50);
  });
});
