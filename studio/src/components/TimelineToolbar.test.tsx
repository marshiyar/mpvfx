// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GsapAnimation } from "@hyperframes/core/gsap-parser";
import { usePlayerStore } from "../player/store/playerStore";
import { makeSelection } from "../hooks/domSelectionTestHarness";
import { timelineKeyframeSelectionKey } from "../player/components/timelineKeyframeIdentity";
import { TimelineToolbar } from "./TimelineToolbar";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
  usePlayerStore.setState({
    autoKeyframeEnabled: false,
    thumbnailMode: "adaptive",
    zoomMode: "fit",
    manualZoomPercent: 100,
    timelineFitPps: 100,
  });
});

function renderToolbar(
  domEditSession?: React.ComponentProps<typeof TimelineToolbar>["domEditSession"],
) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(<TimelineToolbar domEditSession={domEditSession} />);
  });
  return { host, root };
}

// Regression (#1808): the auto-keyframe toggle is a GLOBAL setting (unlike the
// diamond "Add keyframe" button, which needs a selection to mean anything), so
// it must stay visible and usable with nothing selected — it must not be
// gated behind `domEditSession`/`onToggleKeyframe`.
describe("TimelineToolbar — auto-keyframe toggle (#1808)", () => {
  it("renders disabled by default with no selection", () => {
    const { host, root } = renderToolbar();
    const btn = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Auto-record manual edits as keyframes"]',
    );
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute("aria-pressed")).toBe("false");
    act(() => root.unmount());
  });

  it("flips autoKeyframeEnabled in the store when clicked", () => {
    const { host, root } = renderToolbar();
    const btn = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Auto-record manual edits as keyframes"]',
    );
    if (!btn) throw new Error("auto-keyframe toggle not rendered");

    act(() => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(usePlayerStore.getState().autoKeyframeEnabled).toBe(true);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    act(() => root.unmount());
  });
});

describe("TimelineToolbar — adaptive thumbnails", () => {
  it("does not duplicate the clip-level thumbnail control in the toolbar", () => {
    const { host, root } = renderToolbar();
    expect(host.querySelector('button[aria-label^="Show thumbnails"]')).toBeNull();
    expect(host.querySelector('button[aria-label^="Hide thumbnails"]')).toBeNull();
    act(() => root.unmount());
  });
});

describe("TimelineToolbar — zoom reset", () => {
  it("shows a percentage without either Fit label", () => {
    const { host, root } = renderToolbar();

    expect(host.querySelector('button[aria-label="Fit timeline to width"]')).toBeNull();
    expect(host.querySelector('[aria-label="Timeline zoom level"]')?.textContent).toBe("100%");
    expect(host.querySelector('button[aria-label="Zoom out"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="Zoom in"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it("resets a manual zoom to fit when the slider knob is double-clicked", () => {
    usePlayerStore.setState({ zoomMode: "manual", manualZoomPercent: 240, timelineFitPps: 100 });
    const { host, root } = renderToolbar();
    const slider = host.querySelector<HTMLInputElement>('input[aria-label="Timeline zoom"]');
    if (!slider) throw new Error("timeline zoom slider not rendered");

    expect(host.querySelector('[aria-label="Timeline zoom level"]')?.textContent).toBe("240%");
    act(() => slider.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));

    expect(usePlayerStore.getState().zoomMode).toBe("fit");
    expect(host.querySelector('[aria-label="Timeline zoom level"]')?.textContent).toBe("100%");
    act(() => root.unmount());
  });
});

describe("TimelineToolbar — motion path endpoints", () => {
  it("does not advertise a destructive keyframe toggle for a required endpoint", () => {
    usePlayerStore.setState({ currentTime: 10 });
    const animation: GsapAnimation = {
      id: "#el-to-0-position",
      targetSelector: "#el",
      method: "to",
      position: 0,
      duration: 10,
      properties: {},
      keyframes: {
        format: "object-array",
        keyframes: [
          { percentage: 0, properties: { x: 0, y: 0 } },
          { percentage: 100, properties: { x: 100, y: 0 } },
        ],
      },
      arcPath: {
        enabled: true,
        autoRotate: false,
        segments: [{ curviness: 1 }],
      },
    };
    const element = document.createElement("div");
    element.id = "el";
    const session = {
      domEditSelection: makeSelection("Element", element),
      selectedGsapAnimations: [animation],
      handleGsapAddAnimation: vi.fn(),
      handleGsapConvertToKeyframes: vi.fn(),
      handleGsapRemoveKeyframe: vi.fn(),
    } satisfies NonNullable<React.ComponentProps<typeof TimelineToolbar>["domEditSession"]>;

    const { host, root } = renderToolbar(session);
    const button = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Motion path endpoint"]',
    );
    expect(button?.disabled).toBe(true);
    act(() => root.unmount());
  });
});

describe("TimelineToolbar — keyframes on audio tracks", () => {
  const clip = (tag: string) => ({
    id: "bgm",
    key: "bgm",
    tag,
    start: 0,
    duration: 10,
    track: 1,
  });

  /** A session whose selection would otherwise offer the keyframe toggle. */
  function sessionFor(tag: string) {
    usePlayerStore.setState({ elements: [clip(tag)], selectedElementId: "bgm", currentTime: 1 });
    const element = document.createElement(tag);
    element.id = "bgm";
    return {
      domEditSelection: makeSelection("Element", element),
      selectedGsapAnimations: [],
      handleGsapAddAnimation: vi.fn(),
      handleGsapConvertToKeyframes: vi.fn(),
      handleGsapRemoveKeyframe: vi.fn(),
    } satisfies NonNullable<React.ComponentProps<typeof TimelineToolbar>["domEditSession"]>;
  }

  it("offers no keyframe toggle for an audio clip", () => {
    // An audio clip has no box on the canvas, so there is nothing to move or fade —
    // and pressing this seeded a tween from the position properties, which put a
    // position lane on a track that has no position. Audio is automated instead.
    const { host, root } = renderToolbar(sessionFor("audio"));
    const button = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Add keyframe at playhead"]',
    );
    expect(button?.disabled).toBe(true);
    act(() => root.unmount());
  });

  it("still offers it for a visual clip", () => {
    const { host, root } = renderToolbar(sessionFor("div"));
    const button = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Add keyframe at playhead"]',
    );
    expect(button?.disabled).toBe(false);
    act(() => root.unmount());
  });
});

describe("TimelineToolbar — selected keyframe nudging", () => {
  it("moves selected keyframes later through the period shortcut", async () => {
    const element = document.createElement("div");
    element.id = "box";
    element.dataset.start = "0";
    element.dataset.duration = "120";
    const domEditSelection = makeSelection("Box", element);
    const animation = {
      id: "position",
      targetSelector: "#box",
      method: "to",
      propertyGroup: "position",
      resolvedStart: 0,
      duration: 120,
      keyframes: {
        keyframes: [
          { percentage: 0, properties: { x: 0 } },
          { percentage: 50, properties: { x: 50 } },
          { percentage: 100, properties: { x: 100 } },
        ],
      },
    } as unknown as GsapAnimation;
    const selectedKey = timelineKeyframeSelectionKey("index.html#box", {
      percentage: 50,
      tweenPercentage: 50,
      animationId: "position",
      propertyGroup: "position",
    });
    usePlayerStore.setState({
      elements: [
        { id: "box", key: "index.html#box", tag: "div", start: 0, duration: 120, track: 0 },
      ],
      selectedElementId: "index.html#box",
      selectedKeyframes: new Set([selectedKey]),
    });
    const handleGsapMoveKeyframes = vi.fn().mockResolvedValue(true);
    const session = {
      domEditSelection,
      selectedGsapAnimations: [animation],
      handleGsapAddAnimation: vi.fn(),
      handleGsapConvertToKeyframes: vi.fn(),
      handleGsapRemoveKeyframe: vi.fn(),
      handleGsapMoveKeyframes,
    } satisfies NonNullable<React.ComponentProps<typeof TimelineToolbar>["domEditSession"]>;
    const { root } = renderToolbar(session);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: ".", bubbles: true }));
      await Promise.resolve();
    });

    expect(handleGsapMoveKeyframes).toHaveBeenCalledExactlyOnceWith([
      { animationId: "position", fromPercentage: 50, toPercentage: 50.0277777778 },
    ]);
    act(() => root.unmount());
  });
});
