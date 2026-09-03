// @vitest-environment happy-dom

import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GsapAnimation } from "@hyperframes/core/gsap-parser";
import type { DomEditSelection } from "../components/editor/domEditingTypes";
import { usePlayerStore } from "../player/store/playerStore";
import { useAnimatedPropertyCommit } from "./useAnimatedPropertyCommit";
import { mountReactHarness } from "./domSelectionTestHarness";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
  usePlayerStore.setState({ autoKeyframeEnabled: true, currentTime: 0 });
});

const selection = { id: "box", selector: "#box" } as DomEditSelection;

const keyframedAnim = {
  id: "#box-to-position",
  targetSelector: "#box",
  propertyGroup: "position",
  method: "to",
  properties: {},
  resolvedStart: 0,
  duration: 2,
  keyframes: {
    keyframes: [
      { percentage: 0, properties: { x: 0, y: 0 } },
      { percentage: 100, properties: { x: 100, y: 0 } },
    ],
  },
} as unknown as GsapAnimation;

type Commit = (
  selection: DomEditSelection,
  props: Record<string, number | string>,
) => Promise<void>;

/** Renders the hook and hands its commit function to the caller via a ref callback. */
function renderHookWith(
  animations: GsapAnimation[],
  onMutation: (mutation: Record<string, unknown>, label: string) => unknown | Promise<unknown>,
  onReady: (commit: Commit) => void,
  bumpGsapCache = vi.fn(),
  onBatch?: (
    calls: Array<{ mutation: Record<string, unknown>; options: { label: string } }>,
    label: string,
  ) => unknown | Promise<unknown>,
  previewIframeRef: React.RefObject<HTMLIFrameElement | null> = { current: null },
) {
  function Harness() {
    const gsapCommitMutation = Object.assign(
      async (
        _sel: DomEditSelection,
        mutation: Record<string, unknown>,
        options: { label: string },
      ) => {
        await onMutation(mutation, options.label);
      },
      onBatch
        ? {
            batch: async (
              calls: Array<{
                selection: DomEditSelection;
                mutation: Record<string, unknown>;
                options: { label: string };
              }>,
              options: { label: string },
            ) => {
              await onBatch(calls, options.label);
            },
          }
        : {},
    );
    const { commitAnimatedProperties } = useAnimatedPropertyCommit({
      selectedGsapAnimations: animations,
      gsapCommitMutation,
      addGsapAnimation: vi.fn(),
      convertToKeyframes: vi.fn(),
      previewIframeRef,
      bumpGsapCache,
    });
    onReady(commitAnimatedProperties);
    return null;
  }
  return mountReactHarness(<Harness />);
}

describe("useAnimatedPropertyCommit — ownership and rejection propagation", () => {
  it("rejects a helper-authored property before sending a mutation", async () => {
    const helperRotation = {
      id: "#box-to-rotation",
      targetSelector: "#box",
      propertyGroup: "rotation",
      method: "to",
      properties: { rotationX: 10 },
      provenance: { kind: "helper", fn: "spin", callSite: 1 },
    } as unknown as GsapAnimation;
    const mutations: Array<Record<string, unknown>> = [];
    let commit!: Commit;
    const root = renderHookWith(
      [helperRotation],
      (mutation) => mutations.push(mutation),
      (ready) => (commit = ready),
    );

    await expect(commit(selection, { rotationX: 12 })).rejects.toMatchObject({
      name: "GsapEditBlockedError",
      reason: "unroll-required",
    });
    expect(mutations).toHaveLength(0);
    act(() => root.unmount());
  });

  it("rejects runtime-computed property ownership before sending a mutation", async () => {
    const runtimePosition = {
      ...keyframedAnim,
      hasUnresolvedKeyframes: true,
    } as GsapAnimation;
    const mutations: Array<Record<string, unknown>> = [];
    let commit!: Commit;
    const root = renderHookWith(
      [runtimePosition],
      (mutation) => mutations.push(mutation),
      (ready) => (commit = ready),
    );

    await expect(commit(selection, { x: 50 })).rejects.toMatchObject({
      reason: "source-uneditable",
    });
    expect(mutations).toHaveLength(0);
    act(() => root.unmount());
  });

  it("rejects every property before a mixed-group commit can partially persist", async () => {
    const helperOpacity = {
      id: "#box-to-visual",
      targetSelector: "#box",
      propertyGroup: "visual",
      method: "to",
      properties: { opacity: 0.5 },
      provenance: { kind: "helper", fn: "fade", callSite: 1 },
    } as unknown as GsapAnimation;
    const mutations: Array<Record<string, unknown>> = [];
    let commit!: Commit;
    const root = renderHookWith(
      [helperOpacity],
      (mutation) => mutations.push(mutation),
      (ready) => (commit = ready),
    );

    await expect(commit(selection, { x: 50, opacity: 0.8 })).rejects.toMatchObject({
      reason: "unroll-required",
    });
    expect(mutations).toHaveLength(0);
    act(() => root.unmount());
  });

  it("rethrows a persistence failure to the telemetry wrapper", async () => {
    const failure = new Error("save failed");
    const bumpGsapCache = vi.fn();
    let commit!: Commit;
    const root = renderHookWith(
      [keyframedAnim],
      async () => {
        throw failure;
      },
      (ready) => (commit = ready),
      bumpGsapCache,
    );

    await expect(commit(selection, { x: 50 })).rejects.toBe(failure);
    expect(bumpGsapCache).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });
});

function renderCommitHook(
  mutations: Array<Record<string, unknown>>,
  onReady: (commit: Commit) => void,
) {
  return renderHookWith(
    [keyframedAnim],
    (mutation) => {
      mutations.push(mutation);
    },
    onReady,
  );
}

// Regression (#1808): a "3D transform" / design-panel property edit on an
// element that already has a keyframed tween is the ACTUAL path a manual
// canvas nudge exercises (not the raw drag intercept) — with auto-keyframe
// off, it must shift the whole tween instead of adding/updating a keyframe
// at the playhead.
describe("useAnimatedPropertyCommit — autoKeyframeEnabled toggle (#1808)", () => {
  async function runCommitWithAutoKeyframe(enabled: boolean, currentTime: number) {
    usePlayerStore.setState({ autoKeyframeEnabled: enabled, currentTime });
    const mutations: Array<Record<string, unknown>> = [];
    let commit: Commit | undefined;
    const root = renderCommitHook(mutations, (fn) => (commit = fn));
    await act(async () => commit!(selection, { x: 50 }));
    act(() => root.unmount());
    return mutations;
  }

  it("updates the existing keyframe when the toggle is off and the playhead is on it", async () => {
    const mutations = await runCommitWithAutoKeyframe(false, 0);
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toMatchObject({
      type: "update-keyframe",
      animationId: keyframedAnim.id,
      percentage: 0,
      properties: { x: 50 },
    });
  });

  it("offsets the whole animation only when the toggle is off between authored keyframes", async () => {
    const mutations = await runCommitWithAutoKeyframe(false, 1);
    expect(mutations).toHaveLength(1);
    expect(mutations[0]!.type).toBe("replace-with-keyframes");
  });

  it("still updates a keyframe at the playhead when the toggle is on (default)", async () => {
    const mutations = await runCommitWithAutoKeyframe(true, 0);
    expect(mutations.some((m) => m.type === "update-keyframe" || m.type === "add-keyframe")).toBe(
      true,
    );
    expect(mutations.some((m) => m.type === "replace-with-keyframes")).toBe(false);
  });
});

describe("useAnimatedPropertyCommit — extending keyframed tweens", () => {
  it("keeps per-keyframe and tween easing when an edit extends the tween window", async () => {
    const easedTween = {
      ...keyframedAnim,
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
    let commit!: Commit;
    const root = renderHookWith(
      [easedTween],
      (mutation) => mutations.push(mutation),
      (ready) => (commit = ready),
    );
    usePlayerStore.setState({ currentTime: 3, activeKeyframePct: null });

    await act(async () => {
      await commit(selection, { x: 150 });
    });

    const replacement = mutations.find((mutation) => mutation.type === "replace-with-keyframes");
    expect(replacement).toMatchObject({
      position: 0,
      duration: 3,
      ease: "expo.out",
      easeEach: "power2.inOut",
    });
    expect(replacement?.keyframes).toEqual([
      { percentage: 0, properties: { x: 0, y: 0 }, ease: "sine.in" },
      { percentage: 66.6666666667, properties: { x: 100, y: 0 }, ease: "back.out(1.7)" },
      { percentage: 100, properties: { x: 150 } },
    ]);
    act(() => root.unmount());
  });

  it("adds instead of updating a nearby percentage on a different output frame", async () => {
    const longTween = {
      ...keyframedAnim,
      duration: 120,
      keyframes: {
        keyframes: [
          { percentage: 0, properties: { x: 0, y: 0 } },
          { percentage: 50, properties: { x: 50, y: 0 } },
          { percentage: 100, properties: { x: 100, y: 0 } },
        ],
      },
    } as unknown as GsapAnimation;
    const mutations: Array<Record<string, unknown>> = [];
    let commit!: Commit;
    const root = renderHookWith(
      [longTween],
      (mutation) => mutations.push(mutation),
      (ready) => (commit = ready),
    );
    usePlayerStore.setState({ currentTime: 60.048, autoKeyframeEnabled: true });

    await act(async () => commit(selection, { x: 51 }));

    expect(mutations.at(-1)).toMatchObject({
      type: "add-keyframe",
      animationId: longTween.id,
      percentage: 50.04,
    });
    act(() => root.unmount());
  });

  it("updates the authored percentage when the playhead is on the same output frame", async () => {
    const authoredPercentage = 50.0277777778;
    const longTween = {
      ...keyframedAnim,
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
    let commit!: Commit;
    const root = renderHookWith(
      [longTween],
      (mutation) => mutations.push(mutation),
      (ready) => (commit = ready),
    );
    // 60.034s computes to 50.028%, but both it and the authored percentage
    // render as output frame 1801. The exact durable writer needs the source
    // percentage, not the nearby computed value.
    usePlayerStore.setState({ currentTime: 60.034, autoKeyframeEnabled: true });

    await act(async () => commit(selection, { x: 51 }));

    expect(mutations.at(-1)).toMatchObject({
      type: "update-keyframe",
      animationId: longTween.id,
      percentage: authoredPercentage,
    });
    act(() => root.unmount());
  });

  it("keeps adjacent 30fps source frames distinct while extending a 120s tween", async () => {
    const adjacentFrame = 50.0277777778;
    const longTween = {
      ...keyframedAnim,
      duration: 120,
      ease: "expo.out",
      keyframes: {
        easeEach: "power2.inOut",
        keyframes: [
          { percentage: 50, properties: { x: 50, y: 0 }, ease: "sine.in" },
          { percentage: adjacentFrame, properties: { x: 51, y: 0 }, ease: "back.out(1.7)" },
        ],
      },
    } as unknown as GsapAnimation;
    const mutations: Array<Record<string, unknown>> = [];
    let commit!: Commit;
    const root = renderHookWith(
      [longTween],
      (mutation) => mutations.push(mutation),
      (ready) => (commit = ready),
    );
    usePlayerStore.setState({ currentTime: 121, activeKeyframePct: null });

    await act(async () => commit(selection, { x: 101 }));

    const replacement = mutations.find((mutation) => mutation.type === "replace-with-keyframes");
    expect(replacement).toMatchObject({ ease: "expo.out", easeEach: "power2.inOut" });
    expect(replacement?.keyframes).toEqual([
      { percentage: 49.5867768595, properties: { x: 50, y: 0 }, ease: "sine.in" },
      { percentage: 49.6143250689, properties: { x: 51, y: 0 }, ease: "back.out(1.7)" },
      { percentage: 100, properties: { x: 101 } },
    ]);
    act(() => root.unmount());
  });

  it("authors a fresh property-group baseline from the pre-edit live rotation", async () => {
    const adjacentFrame = 50.0277777778;
    const longPositionTween = {
      ...keyframedAnim,
      duration: 120,
      ease: "expo.out",
      keyframes: {
        easeEach: "power2.inOut",
        keyframes: [
          { percentage: 50, properties: { x: 50, y: 0 } },
          { percentage: adjacentFrame, properties: { x: 51, y: 0 } },
        ],
      },
    } as unknown as GsapAnimation;
    const mutations: Array<Record<string, unknown>> = [];
    let commit!: Commit;
    const el = document.createElement("div");
    el.id = "box";
    document.body.appendChild(el);
    const previewIframeRef = {
      current: {
        contentWindow: {
          gsap: { getProperty: (_el: Element, property: string) => (property === "rotationX" ? 0 : 0) },
        },
        contentDocument: document,
      } as unknown as HTMLIFrameElement,
    };
    const root = renderHookWith(
      [longPositionTween],
      (mutation) => mutations.push(mutation),
      (ready) => (commit = ready),
      vi.fn(),
      undefined,
      previewIframeRef,
    );
    usePlayerStore.setState({ currentTime: 60.03333333336, activeKeyframePct: null });

    await act(async () => commit(selection, { rotationX: 12 }));

    expect(mutations.at(-1)).toMatchObject({
      type: "add-with-keyframes",
      position: 0,
      duration: 120,
      ease: "expo.out",
      easeEach: "power2.inOut",
      keyframes: [
        { percentage: 0, properties: { rotationX: 0 } },
        { percentage: adjacentFrame, properties: { rotationX: 12 } },
      ],
    });
    act(() => root.unmount());
  });

  it("authors the identity opacity baseline when no live runtime can be read", async () => {
    const mutations: Array<Record<string, unknown>> = [];
    let commit!: Commit;
    const root = renderHookWith(
      [keyframedAnim],
      (mutation) => mutations.push(mutation),
      (ready) => (commit = ready),
    );
    usePlayerStore.setState({ currentTime: 1, activeKeyframePct: null });

    await act(async () => commit(selection, { opacity: 0.25 }));

    expect(mutations.at(-1)).toMatchObject({
      type: "add-with-keyframes",
      position: 0,
      duration: 2,
      keyframes: [
        { percentage: 0, properties: { opacity: 1 } },
        { percentage: 50, properties: { opacity: 0.25 } },
      ],
    });
    act(() => root.unmount());
  });
});

// Regression: commitStaticSet picked the FIRST `set` for the selector with no
// group check — a panel W edit on a static element merged `width` into the
// POSITION set (`tl.set("#el",{x,y,width})`), a mixed-group set the split
// machinery exists to prevent, labeled "Set 3D transform" in undo history.
describe("commitStaticSet group routing", () => {
  const positionSet = {
    id: "#box-set-0-position",
    targetSelector: "#box",
    propertyGroup: "position",
    method: "set",
    properties: { x: 10, y: 20 },
  } as unknown as GsapAnimation;

  function renderStaticHook(
    committed: Array<{ mutation: Record<string, unknown>; label: string }>,
    onReady: (commit: Commit) => void,
  ) {
    return renderHookWith(
      [positionSet],
      (mutation, label) => {
        committed.push({ mutation, label });
      },
      onReady,
    );
  }

  it("width edit creates a size set instead of contaminating the position set", async () => {
    const committed: Array<{ mutation: Record<string, unknown>; label: string }> = [];
    let commit!: Commit;
    renderStaticHook(committed, (c) => (commit = c));
    await act(async () => {
      await commit(selection, { width: 500 });
    });
    const updates = committed.filter((c) => c.mutation.type === "update-properties");
    expect(updates).toHaveLength(0);
    const adds = committed.filter((c) => c.mutation.type === "add");
    expect(adds).toHaveLength(1);
    expect(adds[0]!.mutation.properties).toEqual({ width: 500 });
    expect(adds[0]!.label).toBe("Resize layer");
  });

  it("x edit updates the position set with a Move label", async () => {
    const committed: Array<{ mutation: Record<string, unknown>; label: string }> = [];
    let commit!: Commit;
    renderStaticHook(committed, (c) => (commit = c));
    await act(async () => {
      await commit(selection, { x: 400 });
    });
    const update = committed.find((c) => c.mutation.type === "update-properties");
    expect(update).toBeDefined();
    expect(update!.mutation.animationId).toBe("#box-set-0-position");
    expect(update!.label).toBe("Move layer");
  });

  it("width edit updates its duration-zero size hold instead of appending a set", async () => {
    const instantSizeHold = {
      id: "#box-to-0-size",
      targetSelector: "#box",
      propertyGroup: "size",
      method: "to",
      properties: { width: 150, height: 150 },
      resolvedStart: 0,
      duration: 0,
      extras: { immediateRender: "__raw:true" },
    } as unknown as GsapAnimation;
    const committed: Array<{ mutation: Record<string, unknown>; label: string }> = [];
    let commit!: Commit;
    renderHookWith(
      [positionSet, instantSizeHold],
      (mutation, label) => {
        committed.push({ mutation, label });
      },
      (c) => (commit = c),
    );

    await act(async () => {
      await commit(selection, { width: 344 });
    });

    expect(committed).toHaveLength(1);
    expect(committed[0]!.mutation).toEqual({
      type: "update-properties",
      animationId: instantSizeHold.id,
      properties: { width: 344 },
    });
    expect(committed[0]!.label).toBe("Resize layer");
    expect(committed.some(({ mutation }) => mutation.type === "add")).toBe(false);
    expect(committed[0]!.mutation.animationId).not.toBe(positionSet.id);
  });

  it("persists multiple property groups in one atomic batch", async () => {
    const committed: Array<{ mutation: Record<string, unknown>; label: string }> = [];
    const batches: Array<{
      calls: Array<{ mutation: Record<string, unknown>; options: { label: string } }>;
      label: string;
    }> = [];
    let commit!: Commit;
    const root = renderHookWith(
      [positionSet],
      (mutation, label) => committed.push({ mutation, label }),
      (ready) => (commit = ready),
      vi.fn(),
      (calls, label) => batches.push({ calls, label }),
    );

    await act(async () => {
      await commit(selection, { x: 400, width: 500 });
    });

    expect(committed).toHaveLength(0);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.label).toBe("Set properties");
    expect(batches[0]!.calls.map(({ mutation }) => mutation)).toEqual([
      {
        type: "update-properties",
        animationId: positionSet.id,
        properties: { x: 400 },
      },
      {
        type: "add",
        targetSelector: "#box",
        method: "set",
        position: 0,
        properties: { width: 500 },
        global: true,
      },
    ]);
    act(() => root.unmount());
  });

  it("fails before sending anything when an atomic multi-group batch is unavailable", async () => {
    const committed: Array<{ mutation: Record<string, unknown>; label: string }> = [];
    let commit!: Commit;
    const root = renderStaticHook(committed, (ready) => (commit = ready));

    await expect(commit(selection, { x: 400, width: 500 })).rejects.toThrow(
      "Atomic GSAP property batch is unavailable",
    );
    expect(committed).toHaveLength(0);
    act(() => root.unmount());
  });
});
