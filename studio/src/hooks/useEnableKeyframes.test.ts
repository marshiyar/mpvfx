// @vitest-environment happy-dom
import { act, createElement, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GsapAnimation } from "@hyperframes/core/gsap-parser";
import type { DomEditSelection } from "../components/editor/domEditingTypes";
import {
  applyArcKeyframeAtPlayhead,
  animatedProps,
  buildExtendedKeyframes,
  isPlayheadWithinTween,
  promoteSetToKeyframes,
  resolveNewTweenRange,
  useEnableKeyframes,
  type EnableKeyframesSession,
} from "./useEnableKeyframes";
import { usePlayerStore } from "../player/store/playerStore";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  vi.unstubAllGlobals();
  window.location.hash = "";
});

function anim(overrides: Partial<GsapAnimation>): GsapAnimation {
  return {
    id: "#el-to-0-position",
    targetSelector: "#el",
    method: "to",
    position: 0,
    properties: {},
    ...overrides,
  };
}

describe("resolveNewTweenRange", () => {
  // Regression: "add a keyframe" must land at the PLAYHEAD. The runtime auto-stamps
  // data-start="0" + data-duration=<rootDuration> on every GSAP element, so honoring
  // data-start as authored timing put the keyframe at 0. Clamping the playhead into
  // the element's range fixes it (auto-stamp's full range passes the playhead through).
  it("anchors at the playhead through the auto-stamped full-composition range", () => {
    // data-start="0", data-duration="14" (the auto-stamp), playhead 4.9 → 4.9
    expect(resolveNewTweenRange("0", "14", 4.9)).toEqual({ start: 4.9, duration: 9.1 });
  });

  it("anchors at the playhead when the element has no authored range", () => {
    expect(resolveNewTweenRange(undefined, undefined, 4)).toEqual({ start: 4, duration: 1 });
    expect(resolveNewTweenRange(undefined, undefined, 6.123456).start).toBe(6.123);
  });

  it("never returns a negative start", () => {
    expect(resolveNewTweenRange(undefined, undefined, -2).start).toBe(0);
  });

  it("clamps the playhead into a genuinely narrow authored clip", () => {
    // clip [2.5, 8]: inside → playhead; before → start; after → end
    expect(resolveNewTweenRange("2.5", "5.5", 4)).toEqual({ start: 4, duration: 4 });
    expect(resolveNewTweenRange("2.5", "5.5", 1).start).toBe(2.5);
    expect(resolveNewTweenRange("2.5", "5.5", 99).start).toBe(8);
  });
});

describe("animatedProps", () => {
  it("uses top-level properties when present (flat tween)", () => {
    expect(animatedProps(anim({ properties: { x: -260 } }))).toEqual(["x"]);
  });

  it("derives props from keyframe stops when top-level properties is empty (array form)", () => {
    // Regression: array-form `keyframes: [{x,y},…]` leaves `properties` empty, so
    // add-keyframe read an empty prop list → empty position → silent no-op.
    const a = anim({
      properties: {},
      keyframes: {
        format: "object-array",
        keyframes: [
          { percentage: 0, properties: { x: 0, y: 0 } },
          { percentage: 100, properties: { x: -460, y: -20 } },
        ],
      },
    });
    expect(animatedProps(a).sort()).toEqual(["x", "y"]);
  });

  it("falls back to x/y for a null anim or one with no resolvable props", () => {
    expect(animatedProps(null)).toEqual(["x", "y"]);
    expect(animatedProps(anim({ properties: {} }))).toEqual(["x", "y"]);
  });
});

describe("isPlayheadWithinTween", () => {
  const tween = anim({ position: 1.0, duration: 3.4 }); // range [1.0, 4.4]

  it("is true inside the range (incl. boundaries)", () => {
    expect(isPlayheadWithinTween(tween, 3.0)).toBe(true);
    expect(isPlayheadWithinTween(tween, 1.0)).toBe(true);
    expect(isPlayheadWithinTween(tween, 4.4)).toBe(true);
  });

  it("is false outside the tween range", () => {
    expect(isPlayheadWithinTween(tween, 5.767)).toBe(false);
    expect(isPlayheadWithinTween(tween, 0.5)).toBe(false);
  });

  it("does not block when the start can't be resolved", () => {
    expect(isPlayheadWithinTween(anim({ position: "+=1" }), 99)).toBe(true);
  });

  // The toolbar's "extends animation" tooltip has to agree with what the edit
  // paths do. Those span a duration-less tween across its clip, so answering
  // from GSAP's 0.5s default reported the playhead outside a window the click
  // then treated as clip-wide.
  it("spans the clip for a duration-less tween when given the selection", () => {
    const durationless = anim({ position: 0 });
    const selection = { dataAttributes: { duration: "16" } } as unknown as DomEditSelection;

    expect(isPlayheadWithinTween(durationless, 5)).toBe(false);
    expect(isPlayheadWithinTween(durationless, 5, selection)).toBe(true);
    expect(isPlayheadWithinTween(durationless, 20, selection)).toBe(false);
  });
});

describe("buildExtendedKeyframes", () => {
  // puck-b: tween [1.0, 4.4], four evenly-distributed stops.
  const kfAnim = anim({
    position: 1.0,
    duration: 3.4,
    keyframes: {
      format: "object-array",
      keyframes: [
        { percentage: 0, properties: { x: 0, y: 0 } },
        { percentage: 33.3, properties: { x: -180, y: -60 } },
        { percentage: 66.7, properties: { x: -320, y: 40 } },
        { percentage: 100, properties: { x: -460, y: -20 } },
      ],
    },
  });

  it("extends the end and rescales existing stops to keep their absolute timing", () => {
    const out = buildExtendedKeyframes(kfAnim, 5.767, { x: -460, y: -20 });
    expect(out.position).toBe(1.0); // start unchanged
    expect(out.duration).toBe(4.767); // grown to reach the playhead
    // old end (abs 4.4) is no longer 100% — it slid back inside the longer range
    const last = out.keyframes[out.keyframes.length - 1]!;
    expect(last.percentage).toBe(100); // the new keyframe sits at the new end
    expect(last.properties).toEqual({ x: -460, y: -20 });
    expect(out.keyframes[0]!.percentage).toBe(0); // old start still anchors 0%
    expect(out.keyframes.some((k) => k.percentage > 0 && k.percentage < 100)).toBe(true);
  });

  it("extends the start when the playhead precedes the tween", () => {
    const out = buildExtendedKeyframes(kfAnim, 0, { x: 0, y: 0 });
    expect(out.position).toBe(0); // start moved back to the playhead
    expect(out.duration).toBe(4.4); // end (abs 4.4) unchanged
    expect(out.keyframes[0]).toEqual({ percentage: 0, properties: { x: 0, y: 0 } });
    // the old first stop (abs 1.0) is now partway in: 1.0 / 4.4 ≈ 22.7%
    expect(out.keyframes[1]!.percentage).toBeCloseTo(22.7, 1);
  });

  it("keeps adjacent 30fps source frames distinct when extending a 120s tween before or after", () => {
    const adjacentFrame = 50.0277777778;
    const longTween = anim({
      position: 0,
      duration: 120,
      keyframes: {
        format: "percentage",
        easeEach: "power2.inOut",
        keyframes: [
          { percentage: 50, properties: { x: 50 }, ease: "sine.in" },
          { percentage: adjacentFrame, properties: { x: 51 }, ease: "back.out(1.7)" },
        ],
      },
    });

    const after = buildExtendedKeyframes(longTween, 121, { x: 101 });
    const before = buildExtendedKeyframes(longTween, -1, { x: -1 });

    // A 0.1%-rounded remap collapses each pair into one stop (49.6 / 50.4).
    // These are adjacent Studio output frames and must retain source separation.
    expect(after.keyframes.map((keyframe) => keyframe.percentage)).toEqual([
      49.5867768595,
      49.6143250689,
      100,
    ]);
    expect(before.keyframes.map((keyframe) => keyframe.percentage)).toEqual([
      0,
      50.4132231405,
      50.4407713499,
    ]);
    expect(after.keyframes[0]?.ease).toBe("sine.in");
    expect(after.keyframes[1]?.ease).toBe("back.out(1.7)");
  });
});

describe("promoteSetToKeyframes — explicit authoring", () => {
  it("creates exactly one key at the playhead without an automatic held endpoint", async () => {
    let committed: Record<string, unknown> | undefined;
    const session = {
      commitMutation: async (mutation: Record<string, unknown>) => {
        committed = mutation;
      },
    } as unknown as EnableKeyframesSession;
    const sel = {
      id: "card",
      selector: "#card",
      sourceFile: "index.html",
      element: { isConnected: true } as unknown as HTMLElement,
    } as unknown as DomEditSelection;
    // readElementPosition reads gsap.getProperty off the iframe window.
    const iframe = {
      contentWindow: { gsap: { getProperty: () => -74 } },
    } as unknown as HTMLIFrameElement;
    const setAnim = anim({
      id: "#card-set-0-position",
      targetSelector: "#card",
      method: "set",
      global: true,
      resolvedStart: 0,
      properties: { x: -74, y: -469 },
    });

    await promoteSetToKeyframes(session, sel, setAnim, 1, iframe);

    const kfs = committed?.keyframes as Array<{ percentage: number; auto?: boolean }>;
    expect(committed?.type).toBe("replace-with-keyframes");
    expect(committed?.position).toBe(1);
    expect(kfs).toEqual([{ percentage: 0, properties: { x: -74, y: -74 } }]);
  });

  it("playhead AT the set (t <= setStart) drops a single 0% keyframe, not a no-op", async () => {
    // Regression: enabling keyframes on a `gsap.set` element at t=0 (set start 0)
    // returned early (`t <= setStart`) → nothing created. Must give a 0% keyframe.
    let committed: Record<string, unknown> | undefined;
    const session = {
      commitMutation: async (mutation: Record<string, unknown>) => {
        committed = mutation;
      },
    } as unknown as EnableKeyframesSession;
    const sel = {
      id: "box",
      selector: "#box",
      sourceFile: "index.html",
      element: { isConnected: true } as unknown as HTMLElement,
    } as unknown as DomEditSelection;
    const iframe = {
      contentWindow: { gsap: { getProperty: () => -1091 } },
    } as unknown as HTMLIFrameElement;
    const setAnim = anim({
      id: "#box-set-0-position",
      targetSelector: "#box",
      method: "set",
      global: true,
      resolvedStart: 0,
      properties: { x: -1091, y: 280 },
    });

    await promoteSetToKeyframes(session, sel, setAnim, 0, iframe);

    const kfs = committed?.keyframes as Array<{ percentage: number }>;
    expect(committed?.type).toBe("replace-with-keyframes");
    expect(kfs).toHaveLength(1);
    expect(kfs[0].percentage).toBe(0);
  });
});

describe("applyArcKeyframeAtPlayhead", () => {
  const arcAnim = anim({
    id: "#el-to-0-position",
    position: 0,
    duration: 10,
    keyframes: {
      format: "object-array",
      keyframes: [
        { percentage: 0, properties: { x: 0, y: 0 } },
        { percentage: 50, properties: { x: 50, y: 50 } },
        { percentage: 100, properties: { x: 100, y: 0 } },
      ],
    },
    arcPath: {
      enabled: true,
      autoRotate: false,
      segments: [{ curviness: 1 }, { curviness: 1 }],
    },
  });

  function arcFixture(x: number, y: number) {
    const commitMutation = vi.fn(async () => undefined);
    const session = { commitMutation } as unknown as EnableKeyframesSession;
    const sel = {
      id: "el",
      selector: "#el",
      element: { isConnected: true } as HTMLElement,
      dataAttributes: { duration: "10" },
    } as DomEditSelection;
    const iframe = {
      contentWindow: {
        gsap: { getProperty: (_element: Element, property: string) => (property === "x" ? x : y) },
      },
    } as unknown as HTMLIFrameElement;
    return { commitMutation, iframe, sel, session };
  }

  it("removes an existing interior stop without redistributing the remaining times", async () => {
    const fixture = arcFixture(50, 50);
    await applyArcKeyframeAtPlayhead(fixture.session, fixture.sel, arcAnim, 5, fixture.iframe);
    expect(fixture.commitMutation).toHaveBeenCalledWith(
      {
        type: "replace-with-keyframes",
        animationId: arcAnim.id,
        targetSelector: "#el",
        position: 0,
        duration: 10,
        keyframes: [
          { percentage: 0, properties: { x: 0, y: 0 } },
          { percentage: 100, properties: { x: 100, y: 0 } },
        ],
        ease: "none",
      },
      { label: "Remove keyframe", softReload: true },
    );
  });

  it("preserves the path endpoints", async () => {
    const fixture = arcFixture(0, 0);
    await applyArcKeyframeAtPlayhead(fixture.session, fixture.sel, arcAnim, 0, fixture.iframe);
    expect(fixture.commitMutation).not.toHaveBeenCalled();
  });

  it("adds a temporal keyframe at the exact playhead while preserving authored times", async () => {
    const fixture = arcFixture(25, 25);
    await applyArcKeyframeAtPlayhead(fixture.session, fixture.sel, arcAnim, 2.5, fixture.iframe);
    expect(fixture.commitMutation).toHaveBeenCalledWith(
      {
        type: "replace-with-keyframes",
        animationId: arcAnim.id,
        targetSelector: "#el",
        position: 0,
        duration: 10,
        keyframes: [
          { percentage: 0, properties: { x: 0, y: 0 } },
          { percentage: 25, properties: { x: 25, y: 25 } },
          { percentage: 50, properties: { x: 50, y: 50 } },
          { percentage: 100, properties: { x: 100, y: 0 } },
        ],
        ease: "none",
      },
      { label: "Add keyframe", softReload: true },
    );
  });

  it("uses the owning clip duration when an arc omits its outer duration", async () => {
    const fixture = arcFixture(25, 25);
    const durationlessArc = { ...arcAnim, duration: undefined };

    await applyArcKeyframeAtPlayhead(
      fixture.session,
      fixture.sel,
      durationlessArc,
      2.5,
      fixture.iframe,
    );

    expect(fixture.commitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "replace-with-keyframes",
        duration: 10,
        keyframes: expect.arrayContaining([{ percentage: 25, properties: { x: 25, y: 25 } }]),
      }),
      { label: "Add keyframe", softReload: true },
    );
  });
});

function renderEnableKeyframes(session: EnableKeyframesSession): () => Promise<void> {
  let enable: (() => Promise<void>) | null = null;
  function Probe() {
    const sessionRef = useRef<EnableKeyframesSession | undefined>(session);
    enable = useEnableKeyframes(sessionRef);
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(createElement(Probe)));
  cleanup = () => act(() => root.unmount());
  if (!enable) throw new Error("hook did not initialize");
  return enable;
}

function flatTweenResponse(flat: GsapAnimation) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ animations: [flat] }),
    })),
  );
}

function makeElementSelection(): DomEditSelection {
  const element = document.body.appendChild(document.createElement("div"));
  element.id = "el";
  return {
    id: "el",
    selector: "#el",
    sourceFile: "index.html",
    element,
  } as DomEditSelection;
}

describe("useEnableKeyframes — flat tween transaction", () => {
  it("replaces a flat tween with exactly one authored key and does not synthesize endpoints", async () => {
    window.location.hash = "#/project/test-project";
    usePlayerStore.setState({ currentTime: 3 });
    const selection = makeElementSelection();
    const flat = anim({ id: "flat-single", position: 1, duration: 1, properties: { x: 10 } });
    flatTweenResponse(flat);
    const handleConvert = vi.fn(async () => undefined);
    const commitMutation = vi.fn(async () => undefined);
    const enable = renderEnableKeyframes({
      domEditSelection: selection,
      selectedGsapAnimations: [flat],
      previewIframeRef: {
        current: {
          contentWindow: { gsap: { getProperty: () => 10 } },
        } as unknown as HTMLIFrameElement,
      },
      handleGsapAddAnimation: vi.fn(),
      handleGsapConvertToKeyframes: handleConvert,
      handleGsapRemoveKeyframe: vi.fn(),
      commitMutation,
    });

    await act(async () => enable());

    expect(handleConvert).not.toHaveBeenCalled();
    expect(commitMutation).toHaveBeenCalledTimes(1);
    expect(commitMutation.mock.calls[0]?.[0]).toMatchObject({
      type: "replace-with-keyframes",
      animationId: "flat-single",
      position: 3,
      keyframes: [{ percentage: 0, properties: { x: 10 } }],
    });
  });

});

describe("useEnableKeyframes — frame-identity toggle", () => {
  it("adds on a long tween instead of removing a keyframe many output frames away", async () => {
    window.location.hash = "#/project/test-project";
    // On a 120s tween, a 0.5% percentage gap is 0.6s — eighteen Studio frames.
    // It is a new keyframe, never a request to remove the existing 50% stop.
    usePlayerStore.setState({ currentTime: 60.6 });
    const selection = makeElementSelection();
    const keyframed = anim({
      id: "long-keyframed",
      position: 0,
      duration: 120,
      properties: { x: 10 },
      keyframes: {
        format: "object-array",
        keyframes: [
          { percentage: 0, properties: { x: 0 } },
          { percentage: 50, properties: { x: 5 } },
          { percentage: 100, properties: { x: 10 } },
        ],
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ animations: [keyframed] }) })),
    );
    const remove = vi.fn();
    const add = vi.fn(async () => undefined);
    const enable = renderEnableKeyframes({
      domEditSelection: selection,
      selectedGsapAnimations: [keyframed],
      previewIframeRef: {
        current: {
          contentWindow: { gsap: { getProperty: () => 6 } },
        } as unknown as HTMLIFrameElement,
      },
      handleGsapAddAnimation: vi.fn(),
      handleGsapConvertToKeyframes: vi.fn(),
      handleGsapRemoveKeyframe: remove,
      handleGsapAddKeyframeBatch: add,
    });

    await act(async () => enable());

    expect(remove).not.toHaveBeenCalled();
    expect(add).toHaveBeenCalledWith("long-keyframed", 50.5, { x: 6 }, undefined);
  });

  it("extends a 120s tween without merging adjacent source frames or dropping easing", async () => {
    usePlayerStore.setState({ currentTime: 121 });
    const selection = makeElementSelection();
    const adjacentFrame = 50.0277777778;
    const keyframed = anim({
      id: "long-keyframed",
      position: 0,
      duration: 120,
      ease: "expo.out",
      properties: { x: 100 },
      keyframes: {
        format: "percentage",
        easeEach: "power2.inOut",
        keyframes: [
          { percentage: 50, properties: { x: 50 }, ease: "sine.in" },
          { percentage: adjacentFrame, properties: { x: 51 }, ease: "back.out(1.7)" },
        ],
      },
    });
    const commitMutation = vi.fn(async () => undefined);
    const enable = renderEnableKeyframes({
      domEditSelection: selection,
      selectedGsapAnimations: [keyframed],
      previewIframeRef: {
        current: {
          contentWindow: { gsap: { getProperty: () => 101 } },
        } as unknown as HTMLIFrameElement,
      },
      handleGsapAddAnimation: vi.fn(),
      handleGsapConvertToKeyframes: vi.fn(),
      handleGsapRemoveKeyframe: vi.fn(),
      commitMutation,
    });

    await act(async () => enable());

    expect(commitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "replace-with-keyframes",
        ease: "expo.out",
        easeEach: "power2.inOut",
        keyframes: [
          { percentage: 49.5867768595, properties: { x: 50 }, ease: "sine.in" },
          { percentage: 49.6143250689, properties: { x: 51 }, ease: "back.out(1.7)" },
          { percentage: 100, properties: { x: 101 } },
        ],
      }),
      { label: "Add keyframe", softReload: true },
    );
  });
});

describe("useEnableKeyframes — new tween on a class-only element", () => {
  it("targets the selected sibling alone, not every element sharing its class", async () => {
    window.location.hash = "#/project/test-project";
    usePlayerStore.setState({ currentTime: 1 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ animations: [] }) })),
    );
    const scene = document.body.appendChild(document.createElement("div"));
    scene.id = "scene";
    scene.innerHTML = '<i class="group"></i>'.repeat(5);
    const groups = Array.from(scene.querySelectorAll<HTMLElement>(".group"));
    const commitMutation = vi.fn(async () => undefined);
    const enable = renderEnableKeyframes({
      // A bare `.group` here writes `tl.to(".group", …)`, which animates all five
      // siblings and reads back as all five — one add wiped the timeline.
      domEditSelection: {
        selector: ".group",
        selectorIndex: 3,
        sourceFile: "index.html",
        element: groups[3],
        dataAttributes: { start: "0", duration: "2" },
      } as unknown as DomEditSelection,
      selectedGsapAnimations: [],
      previewIframeRef: {
        current: {
          contentWindow: { gsap: { getProperty: () => 7 } },
        } as unknown as HTMLIFrameElement,
      },
      handleGsapAddAnimation: vi.fn(),
      handleGsapConvertToKeyframes: vi.fn(),
      handleGsapRemoveKeyframe: vi.fn(),
      commitMutation,
    });

    await act(async () => enable());

    const mutation = commitMutation.mock.calls[0]?.[0] as { targetSelector: string };
    expect(mutation?.targetSelector).toBeTruthy();
    expect(document.querySelectorAll(mutation.targetSelector)).toHaveLength(1);
    expect(document.querySelector(mutation.targetSelector)).toBe(groups[3]);
  });
});
