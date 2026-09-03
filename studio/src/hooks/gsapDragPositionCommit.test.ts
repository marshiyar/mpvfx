// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import type { GsapAnimation } from "@hyperframes/core/gsap-parser";
import type { DomEditSelection } from "../components/editor/domEditingTypes";
import type { GsapDragCommitCallbacks } from "./gsapDragCommit";
import {
  buildTemporalArcKeyframes,
  commitGsapPositionFromDrag,
} from "./gsapDragPositionCommit";
import { usePlayerStore } from "../player/store/playerStore";

const selection = (): DomEditSelection =>
  ({
    id: "puck-a",
    selector: "#puck-a",
    element: {
      style: { getPropertyValue: () => "", setProperty: () => {} },
      getAttribute: () => null,
      removeAttribute: () => {},
      getBoundingClientRect: () => ({ top: 0, left: 0 }),
    },
  }) as unknown as DomEditSelection;

describe("commitGsapPositionFromDrag — extending a keyframed tween", () => {
  beforeEach(() =>
    usePlayerStore.setState({
      currentTime: 0,
      activeKeyframePct: null,
      activeKeyframeTarget: null,
    }),
  );

  it("keeps per-keyframe and tween easing when the drag extends the tween window", async () => {
    const anim = {
      id: "#puck-a-position",
      targetSelector: "#puck-a",
      propertyGroup: "position",
      method: "to",
      resolvedStart: 1,
      duration: 2,
      ease: "expo.out",
      keyframes: {
        easeEach: "power2.inOut",
        keyframes: [
          { percentage: 0, properties: { x: 0, y: 0 }, ease: "sine.in" },
          { percentage: 100, properties: { x: 100, y: 0 }, ease: "back.out(1.7)" },
        ],
      },
    } as unknown as GsapAnimation;
    const mutations: Array<Record<string, unknown>> = [];
    const callbacks: GsapDragCommitCallbacks = {
      commitMutation: async (_selection, mutation) => {
        mutations.push(mutation);
      },
    };
    usePlayerStore.setState({ currentTime: 4 });

    await commitGsapPositionFromDrag(
      selection(),
      anim,
      { x: 200, y: 50 },
      { x: 0, y: 0 },
      null,
      "#puck-a",
      callbacks,
    );

    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toMatchObject({
      type: "replace-with-keyframes",
      position: 1,
      duration: 3,
      ease: "expo.out",
      easeEach: "power2.inOut",
    });
    expect(mutations[0]?.keyframes).toEqual([
      { percentage: 0, properties: { x: 0, y: 0 }, ease: "sine.in" },
      { percentage: 66.6666666667, properties: { x: 100, y: 0 }, ease: "back.out(1.7)" },
      { percentage: 100, properties: { x: 200, y: 50 } },
    ]);
  });

  it("preserves adjacent output-frame keys when extending a long tween", async () => {
    const firstPercentage = 50;
    const secondPercentage = 50.0277777778;
    const anim = {
      id: "position-tween",
      targetSelector: "#puck-a",
      propertyGroup: "position",
      method: "to",
      resolvedStart: 0,
      duration: 120,
      ease: "expo.out",
      keyframes: {
        easeEach: "power2.inOut",
        keyframes: [
          { percentage: 0, properties: { x: 0, y: 0 } },
          { percentage: firstPercentage, properties: { x: 50, y: 0 }, ease: "sine.in" },
          {
            percentage: secondPercentage,
            properties: { x: 51, y: 0 },
            ease: "back.out(1.7)",
          },
          { percentage: 100, properties: { x: 100, y: 0 } },
        ],
      },
    } as unknown as GsapAnimation;
    const mutations: Array<Record<string, unknown>> = [];
    const callbacks: GsapDragCommitCallbacks = {
      commitMutation: async (_selection, mutation) => {
        mutations.push(mutation);
      },
    };
    usePlayerStore.setState({ currentTime: 121 });

    await commitGsapPositionFromDrag(
      selection(),
      anim,
      { x: 121, y: 0 },
      { x: 0, y: 0 },
      null,
      "#puck-a",
      callbacks,
    );

    const replacement = mutations[0] as {
      keyframes: Array<{ percentage: number; properties: Record<string, number>; ease?: string }>;
      ease?: string;
      easeEach?: string;
    };
    const middle = replacement.keyframes.filter(
      (keyframe) => keyframe.properties.x === 50 || keyframe.properties.x === 51,
    );
    expect(middle).toHaveLength(2);
    expect(new Set(middle.map((keyframe) => keyframe.percentage)).size).toBe(2);
    expect(middle.map((keyframe) => keyframe.ease)).toEqual(["sine.in", "back.out(1.7)"]);
    expect(replacement).toMatchObject({ ease: "expo.out", easeEach: "power2.inOut" });
  });

  it("preserves the original boundary when a from tween is extended by one frame", async () => {
    const anim = {
      id: "from-position",
      targetSelector: "#puck-a",
      propertyGroup: "position",
      method: "from",
      resolvedStart: 1,
      duration: 120,
    } as unknown as GsapAnimation;
    const mutations: Array<Record<string, unknown>> = [];
    const callbacks: GsapDragCommitCallbacks = {
      commitMutation: async (_selection, mutation) => {
        mutations.push(mutation);
      },
      fetchAnimations: async () => [],
    };
    usePlayerStore.setState({ currentTime: 1 - 1 / 30 });

    await commitGsapPositionFromDrag(
      selection(),
      anim,
      { x: -10, y: 0 },
      { x: 0, y: 0 },
      null,
      "#puck-a",
      callbacks,
    );

    expect(mutations[0]).toMatchObject({
      type: "split-into-property-groups",
      animationId: "from-position",
    });
    const replacement = mutations[1] as {
      type: string;
      keyframes: Array<{ percentage: number; properties: Record<string, number> }>;
    };
    expect(replacement.type).toBe("add-with-keyframes");
    expect(replacement.keyframes).toHaveLength(3);
    expect(replacement.keyframes[1]?.percentage).toBeCloseTo(
      ((1 / 30) / (120 + 1 / 30)) * 100,
      5,
    );
  });

  it("does not apply a selected rotation keyframe percentage to the position tween", async () => {
    const anim = {
      id: "position-tween",
      targetSelector: "#puck-a",
      propertyGroup: "position",
      method: "to",
      resolvedStart: 1,
      duration: 2,
      keyframes: {
        keyframes: [
          { percentage: 0, properties: { x: 0, y: 0 } },
          { percentage: 100, properties: { x: 100, y: 0 } },
        ],
      },
    } as unknown as GsapAnimation;
    const mutations: Array<Record<string, unknown>> = [];
    const callbacks: GsapDragCommitCallbacks = {
      commitMutation: async (_selection, mutation) => {
        mutations.push(mutation);
      },
    };
    usePlayerStore.getState().setActiveKeyframeTarget({
      elementId: "index.html#puck-a",
      animationId: "rotation-tween",
      propertyGroup: "rotation",
      tweenPercentage: 50,
    });
    usePlayerStore.setState({ currentTime: 4 });

    await commitGsapPositionFromDrag(
      selection(),
      anim,
      { x: 200, y: 50 },
      { x: 0, y: 0 },
      null,
      "#puck-a",
      callbacks,
    );

    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toMatchObject({
      type: "replace-with-keyframes",
      animationId: "position-tween",
      position: 1,
      duration: 3,
    });
  });

  it("writes the exact authored percentage when the playhead shares its output frame", async () => {
    const authoredPercentage = 50.0277777778;
    const anim = {
      id: "position-tween",
      targetSelector: "#puck-a",
      propertyGroup: "position",
      method: "to",
      resolvedStart: 0,
      duration: 120,
      keyframes: {
        keyframes: [
          { percentage: 0, properties: { x: 0, y: 0 } },
          { percentage: authoredPercentage, properties: { x: 50, y: 0 } },
          { percentage: 100, properties: { x: 100, y: 0 } },
        ],
      },
    } as unknown as GsapAnimation;
    const mutations: Array<Record<string, unknown>> = [];
    const callbacks: GsapDragCommitCallbacks = {
      commitMutation: async (_selection, mutation) => {
        mutations.push(mutation);
      },
    };
    usePlayerStore.setState({ currentTime: 60.034 });

    await commitGsapPositionFromDrag(
      selection(),
      anim,
      { x: 51, y: 0 },
      { x: 0, y: 0 },
      null,
      "#puck-a",
      callbacks,
    );

    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toMatchObject({
      type: "add-keyframe",
      animationId: "position-tween",
      percentage: authoredPercentage,
    });
  });
});

describe("buildTemporalArcKeyframes — output-frame identity", () => {
  it("keeps nearby percentages when they are different frames on a long tween", () => {
    const anim = {
      id: "arc-tween",
      duration: 120,
      keyframes: {
        keyframes: [{ percentage: 50, properties: { x: 10, y: 20 } }],
      },
    } as unknown as GsapAnimation;

    expect(buildTemporalArcKeyframes(anim, 50.9, { x: 30, y: 40 })).toEqual([
      { percentage: 50, properties: { x: 10, y: 20 } },
      { percentage: 50.9, properties: { x: 30, y: 40 } },
    ]);
  });
});
