// @vitest-environment happy-dom

import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DomEditSelection } from "../components/editor/domEditing";
import { installReactActEnvironment, mountReactHarness } from "./domSelectionTestHarness";
import type { CommitMutation } from "./gsapScriptCommitTypes";
import { useKeyframeEaseCommits } from "./useKeyframeEaseCommits";

installReactActEnvironment();

afterEach(() => {
  document.body.innerHTML = "";
});

describe("useKeyframeEaseCommits — apply easing to all segments", () => {
  it("awaits one scoped update-meta mutation so the edit creates one undo operation", async () => {
    let releaseWrite: (() => void) | undefined;
    const durableWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const commit = vi.fn(() => durableWrite) as unknown as CommitMutation;
    commit.batch = vi.fn();
    const selection = {
      id: "clip-1",
      selector: "#clip-1",
      sourceFile: "scenes/one.html",
    } as DomEditSelection;
    const selectionRef = { current: selection };
    let handlers: ReturnType<typeof useKeyframeEaseCommits> | null = null;

    function Harness() {
      handlers = useKeyframeEaseCommits({
        gsapCommitMutation: commit,
        domEditSelectionRef: selectionRef,
      });
      return null;
    }

    const root = mountReactHarness(<Harness />);
    const currentHandlers = handlers as ReturnType<typeof useKeyframeEaseCommits> | null;
    if (!currentHandlers) throw new Error("ease commit handlers did not initialize");
    const settlement = currentHandlers.handleSetAllKeyframeEases(
      "opacity-animation",
      "power2.inOut",
    );
    let settled = false;
    settlement?.then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(commit).toHaveBeenCalledExactlyOnceWith(
      selection,
      {
        type: "update-meta",
        animationId: "opacity-animation",
        updates: { easeEach: "power2.inOut", resetKeyframeEases: true },
      },
      { label: "Apply ease to all segments", softReload: true },
    );
    // One update-meta request is one source/history transaction. The bulk edit
    // must never fan out to per-keyframe writes or a multi-entry batch.
    expect(commit.batch).not.toHaveBeenCalled();

    releaseWrite?.();
    await settlement;
    expect(settled).toBe(true);
    act(() => root.unmount());
  });

  it("settles a rejected single-segment ease write as a handled failure", async () => {
    const commit = vi.fn(async () => {
      throw new Error("disk full");
    }) as unknown as CommitMutation;
    const selection = {
      id: "clip-1",
      selector: "#clip-1",
      sourceFile: "scenes/one.html",
    } as DomEditSelection;
    const selectionRef = { current: selection };
    let handlers: ReturnType<typeof useKeyframeEaseCommits> | null = null;

    function Harness() {
      handlers = useKeyframeEaseCommits({ gsapCommitMutation: commit, domEditSelectionRef: selectionRef });
      return null;
    }

    const root = mountReactHarness(<Harness />);
    const currentHandlers = handlers as ReturnType<typeof useKeyframeEaseCommits> | null;
    if (!currentHandlers) throw new Error("ease commit handlers did not initialize");

    await expect(
      currentHandlers.handleUpdateKeyframeEase("opacity-animation", 50, "power2.inOut"),
    ).resolves.toBe(false);
    expect(commit).toHaveBeenCalledExactlyOnceWith(
      selection,
      {
        type: "update-keyframe",
        animationId: "opacity-animation",
        percentage: 50,
        properties: {},
        ease: "power2.inOut",
      },
      { label: "Update keyframe ease", softReload: true },
    );
    act(() => root.unmount());
  });

  it("settles a rejected colliding-segment batch without issuing partial individual writes", async () => {
    const commit = vi.fn() as unknown as CommitMutation;
    commit.batch = vi.fn(async () => {
      throw new Error("batch rejected");
    });
    const selection = {
      id: "clip-1",
      selector: "#clip-1",
      sourceFile: "scenes/one.html",
    } as DomEditSelection;
    const selectionRef = { current: selection };
    let handlers: ReturnType<typeof useKeyframeEaseCommits> | null = null;

    function Harness() {
      handlers = useKeyframeEaseCommits({ gsapCommitMutation: commit, domEditSelectionRef: selectionRef });
      return null;
    }

    const root = mountReactHarness(<Harness />);
    const currentHandlers = handlers as ReturnType<typeof useKeyframeEaseCommits> | null;
    if (!currentHandlers) throw new Error("ease commit handlers did not initialize");

    await expect(
      currentHandlers.handleUpdateSegmentEase(
        [
          { animationId: "opacity-animation", tweenPercentage: 50 },
          { animationId: "scale-animation", tweenPercentage: 50 },
        ],
        "power2.inOut",
      ),
    ).resolves.toBe(false);
    expect(commit.batch).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("refuses a multi-keyframe ease update without batch support before writing either target", async () => {
    const commit = vi.fn(async () => undefined) as unknown as CommitMutation;
    const selection = {
      id: "clip-1",
      selector: "#clip-1",
      sourceFile: "scenes/one.html",
    } as DomEditSelection;
    const selectionRef = { current: selection };
    let handlers: ReturnType<typeof useKeyframeEaseCommits> | null = null;

    function Harness() {
      handlers = useKeyframeEaseCommits({ gsapCommitMutation: commit, domEditSelectionRef: selectionRef });
      return null;
    }

    const root = mountReactHarness(<Harness />);
    const currentHandlers = handlers as ReturnType<typeof useKeyframeEaseCommits> | null;
    if (!currentHandlers) throw new Error("ease commit handlers did not initialize");

    await expect(
      currentHandlers.handleUpdateSegmentEase(
        [
          { animationId: "opacity-animation", tweenPercentage: 25 },
          { animationId: "scale-animation", tweenPercentage: 50 },
        ],
        "power2.inOut",
      ),
    ).resolves.toBe(false);
    expect(commit.batch).toBeUndefined();
    expect(commit).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("settles a rejected Apply to All write as a handled failure", async () => {
    const commit = vi.fn(async () => {
      throw new Error("writer unavailable");
    }) as unknown as CommitMutation;
    const selection = {
      id: "clip-1",
      selector: "#clip-1",
      sourceFile: "scenes/one.html",
    } as DomEditSelection;
    const selectionRef = { current: selection };
    let handlers: ReturnType<typeof useKeyframeEaseCommits> | null = null;

    function Harness() {
      handlers = useKeyframeEaseCommits({ gsapCommitMutation: commit, domEditSelectionRef: selectionRef });
      return null;
    }

    const root = mountReactHarness(<Harness />);
    const currentHandlers = handlers as ReturnType<typeof useKeyframeEaseCommits> | null;
    if (!currentHandlers) throw new Error("ease commit handlers did not initialize");

    await expect(
      currentHandlers.handleSetAllKeyframeEases("opacity-animation", "power2.inOut"),
    ).resolves.toBe(false);
    expect(commit.batch).toBeUndefined();
    act(() => root.unmount());
  });
});
