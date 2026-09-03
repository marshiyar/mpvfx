// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GsapAnimation } from "@hyperframes/core/gsap-parser";

// Tell React this is an act-capable environment so act(...) flushes effects.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import type { DomEditSelection } from "../components/editor/domEditingTypes";
import type { KeyframeCacheEntry } from "../player/store/playerStore";
import { usePlayerStore } from "../player/store/playerStore";
import { useGsapKeyframeOps } from "./useGsapKeyframeOps";

type HookApi = ReturnType<typeof useGsapKeyframeOps>;
type CommitResult = { ok: boolean; changed: boolean };
type CommitOptions = { onResult?: (result: CommitResult) => void };
type CommitCall = [selection: unknown, mutation: unknown, options: CommitOptions];

function readCommitOptions(args: unknown[]): CommitOptions {
  // The hook accepts the production writer type; these test doubles expose only
  // the third tuple member they exercise.
  return (args as unknown as CommitCall)[2];
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

const selection: DomEditSelection = { id: "box", selector: "#box" } as DomEditSelection;

function successfulCommitMutation() {
  return vi.fn<(...args: unknown[]) => Promise<unknown>>(async (...args) => {
    const options = readCommitOptions(args);
    options.onResult?.({ ok: true, changed: true });
  });
}

function renderKeyframeOps(over: {
  commitMutation: (...args: unknown[]) => Promise<unknown>;
  commitMutationSafely?: (...args: unknown[]) => Promise<void>;
  trackGsapSaveFailure: (...args: unknown[]) => void;
}) {
  const captured: { api: HookApi | null } = { api: null };
  // This hook harness intentionally mirrors the separate script-commit harness.
  function Probe() {
    // fallow-ignore-next-line code-duplication
    captured.api = useGsapKeyframeOps({
      activeCompPath: "index.html",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test doubles
      commitMutation: over.commitMutation as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test doubles
      commitMutationSafely: (over.commitMutationSafely ?? (async () => {})) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test doubles
      trackGsapSaveFailure: over.trackGsapSaveFailure as any,
      sdkSession: null,
      sdkDeps: null,
    });
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => {
    root.render(<Probe />);
  });
  cleanup = () => act(() => root.unmount());
  if (!captured.api) throw new Error("hook did not initialize");
  return captured.api;
}

async function moveKeyframeWith(
  commitMutation: (...args: unknown[]) => Promise<unknown>,
): Promise<{ committed: boolean; trackGsapSaveFailure: ReturnType<typeof vi.fn> }> {
  const trackGsapSaveFailure = vi.fn();
  const api = renderKeyframeOps({ commitMutation, trackGsapSaveFailure });
  let committed = true;
  await act(async () => {
    committed = await api.moveKeyframe(selection, "box-to-0-position", 50, 75);
  });
  return { committed, trackGsapSaveFailure };
}

describe("useGsapKeyframeOps — resizeKeyframedTween", () => {
  it("issues a resize-keyframed-tween mutation with the remap + window", async () => {
    const commitMutation = successfulCommitMutation();
    const trackGsapSaveFailure = vi.fn<(...args: unknown[]) => void>();
    const api = renderKeyframeOps({ commitMutation, trackGsapSaveFailure });

    const pctRemap = [
      { from: 0, to: 0 },
      { from: 100, to: 100 },
    ];
    let committed = false;
    await act(async () => {
      committed = await api.resizeKeyframedTween(selection, "box-to-0-opacity", 0.2, 2, pctRemap);
    });

    expect(commitMutation).toHaveBeenCalledTimes(1);
    const [sel, mutation] = commitMutation.mock.calls[0]!;
    expect(sel).toBe(selection);
    expect(mutation).toEqual({
      type: "resize-keyframed-tween",
      animationId: "box-to-0-opacity",
      position: 0.2,
      duration: 2,
      pctRemap,
    });
    expect(trackGsapSaveFailure).not.toHaveBeenCalled();
    expect(committed).toBe(true);
  });

  it("routes a rejected commit to trackGsapSaveFailure (no unhandled rejection)", async () => {
    const error = new Error("network down");
    const commitMutation = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => {
      throw error;
    });
    const trackGsapSaveFailure = vi.fn<(...args: unknown[]) => void>();
    const api = renderKeyframeOps({ commitMutation, trackGsapSaveFailure });

    let committed = true;
    await act(async () => {
      committed = await api.resizeKeyframedTween(selection, "box-to-0-opacity", 0.2, 2, [
        { from: 100, to: 100 },
      ]);
    });

    expect(trackGsapSaveFailure).toHaveBeenCalledTimes(1);
    const [errArg, selArg, mutationArg, labelArg] = trackGsapSaveFailure.mock.calls[0]!;
    expect(errArg).toBe(error);
    expect(selArg).toBe(selection);
    expect((mutationArg as { type: string }).type).toBe("resize-keyframed-tween");
    expect(labelArg).toBe("Retime keyframe (resize tween)");
    expect(committed).toBe(false);
  });
});

describe("useGsapKeyframeOps — moveKeyframe settlement", () => {
  it("returns false when the commit settles without a durable writer result", async () => {
    const { committed, trackGsapSaveFailure } = await moveKeyframeWith(vi.fn(async () => {}));

    expect(committed).toBe(false);
    expect(trackGsapSaveFailure).not.toHaveBeenCalled();
  });

  it("returns false when the writer accepts but does not change the keyframe", async () => {
    const commitMutation = vi.fn(async (...args: unknown[]) => {
      const options = readCommitOptions(args);
      options.onResult?.({ ok: true, changed: false });
    });
    const { committed, trackGsapSaveFailure } = await moveKeyframeWith(commitMutation);

    expect(committed).toBe(false);
    expect(trackGsapSaveFailure).not.toHaveBeenCalled();
  });

  it("returns false and tracks a rejected move", async () => {
    const error = new Error("write failed");
    const commitMutation = vi.fn().mockRejectedValue(error);
    const { committed, trackGsapSaveFailure } = await moveKeyframeWith(commitMutation);

    expect(committed).toBe(false);
    expect(trackGsapSaveFailure).toHaveBeenCalledExactlyOnceWith(
      error,
      selection,
      {
        type: "move-keyframe",
        animationId: "box-to-0-position",
        fromPercentage: 50,
        toPercentage: 75,
      },
      "Move keyframe to 75%",
    );
  });
});

describe("useGsapKeyframeOps — atomic group retime", () => {
  const moves = [
    {
      animationId: "box-position",
      fromPercentage: 20,
      toPercentage: 23.3333333333,
    },
    {
      animationId: "box-position",
      fromPercentage: 40,
      toPercentage: 43.3333333333,
    },
  ];

  it("orders adjacent rightward moves back-to-front within each animation so a sequential writer preserves spacing", async () => {
    const source = new Map<string, Set<number>>([
      ["box-position", new Set([20, 40])],
      ["box-opacity", new Set([30, 70])],
    ]);
    const applied: Array<{ animationId: string; fromPercentage: number; toPercentage: number }> = [];
    const batch = vi.fn(async (entries: Array<{ mutation: { animationId: string; fromPercentage: number; toPercentage: number } }>, options: CommitOptions) => {
      for (const { mutation } of entries) {
        const keyframes = source.get(mutation.animationId)!;
        // This models the installed writer: it receives one mutation at a time
        // and cannot temporarily occupy a sibling's old keyframe position.
        if (!keyframes.has(mutation.fromPercentage) || keyframes.has(mutation.toPercentage)) {
          throw new Error(`collision at ${mutation.toPercentage}%`);
        }
        keyframes.delete(mutation.fromPercentage);
        keyframes.add(mutation.toPercentage);
        applied.push({
          animationId: mutation.animationId,
          fromPercentage: mutation.fromPercentage,
          toPercentage: mutation.toPercentage,
        });
      }
      options.onResult?.({ ok: true, changed: true });
    });
    const commitMutation = Object.assign(vi.fn(async () => undefined), { batch });
    const api = renderKeyframeOps({ commitMutation, trackGsapSaveFailure: vi.fn() });

    await expect(
      api.moveKeyframes(selection, [
        { animationId: "box-opacity", fromPercentage: 30, toPercentage: 40 },
        { animationId: "box-position", fromPercentage: 20, toPercentage: 40 },
        { animationId: "box-opacity", fromPercentage: 70, toPercentage: 80 },
        { animationId: "box-position", fromPercentage: 40, toPercentage: 60 },
      ]),
    ).resolves.toBe(true);

    // Animation groups remain independent in first-seen order. Within each
    // group, a rightward retime runs from the highest source key backwards.
    expect(applied).toEqual([
      { animationId: "box-opacity", fromPercentage: 70, toPercentage: 80 },
      { animationId: "box-opacity", fromPercentage: 30, toPercentage: 40 },
      { animationId: "box-position", fromPercentage: 40, toPercentage: 60 },
      { animationId: "box-position", fromPercentage: 20, toPercentage: 40 },
    ]);
    expect([...source.get("box-opacity")!].sort((a, b) => a - b)).toEqual([40, 80]);
    expect([...source.get("box-position")!].sort((a, b) => a - b)).toEqual([40, 60]);
  });

  it("orders adjacent leftward moves front-to-back within each animation", async () => {
    const source = new Set([40, 60]);
    const applied: Array<{ fromPercentage: number; toPercentage: number }> = [];
    const batch = vi.fn(async (entries: Array<{ mutation: { fromPercentage: number; toPercentage: number } }>, options: CommitOptions) => {
      for (const { mutation } of entries) {
        if (!source.has(mutation.fromPercentage) || source.has(mutation.toPercentage)) {
          throw new Error(`collision at ${mutation.toPercentage}%`);
        }
        source.delete(mutation.fromPercentage);
        source.add(mutation.toPercentage);
        applied.push({
          fromPercentage: mutation.fromPercentage,
          toPercentage: mutation.toPercentage,
        });
      }
      options.onResult?.({ ok: true, changed: true });
    });
    const commitMutation = Object.assign(vi.fn(async () => undefined), { batch });
    const api = renderKeyframeOps({ commitMutation, trackGsapSaveFailure: vi.fn() });

    await expect(
      api.moveKeyframes(selection, [
        { animationId: "box-position", fromPercentage: 60, toPercentage: 40 },
        { animationId: "box-position", fromPercentage: 40, toPercentage: 20 },
      ]),
    ).resolves.toBe(true);

    expect(applied).toEqual([
      { fromPercentage: 40, toPercentage: 20 },
      { fromPercentage: 60, toPercentage: 40 },
    ]);
    expect([...source].sort((a, b) => a - b)).toEqual([20, 40]);
  });

  it("submits every selected move through one batch and one preview boundary", async () => {
    const batch = vi.fn(async (...args: unknown[]) => {
      (args[1] as CommitOptions).onResult?.({ ok: true, changed: true });
    });
    const commitMutation = Object.assign(vi.fn(async () => undefined), { batch });
    const api = renderKeyframeOps({ commitMutation, trackGsapSaveFailure: vi.fn() });

    await expect(api.moveKeyframes(selection, moves)).resolves.toBe(true);

    expect(commitMutation).not.toHaveBeenCalled();
    expect(batch).toHaveBeenCalledExactlyOnceWith(
      [...moves].reverse().map((move) => ({
        selection,
        mutation: { type: "move-keyframe", ...move },
        options: { label: `Move keyframe to ${move.toPercentage}%` },
      })),
      expect.objectContaining({
        label: "Move 2 keyframes",
        softReload: true,
        onResult: expect.any(Function),
      }),
    );
  });

  it("refuses a group retime without batch support instead of partially moving source", async () => {
    const commitMutation = vi.fn(async () => undefined);
    const trackGsapSaveFailure = vi.fn();
    const api = renderKeyframeOps({ commitMutation, trackGsapSaveFailure });

    await expect(api.moveKeyframes(selection, moves)).resolves.toBe(false);

    expect(commitMutation).not.toHaveBeenCalled();
    expect(trackGsapSaveFailure).toHaveBeenCalledOnce();
  });

  it("settles a rejected group retime as one handled failure", async () => {
    const error = new Error("batch move failed");
    const batch = vi.fn().mockRejectedValue(error);
    const commitMutation = Object.assign(vi.fn(async () => undefined), { batch });
    const trackGsapSaveFailure = vi.fn();
    const api = renderKeyframeOps({ commitMutation, trackGsapSaveFailure });

    await expect(api.moveKeyframes(selection, moves)).resolves.toBe(false);

    expect(trackGsapSaveFailure).toHaveBeenCalledExactlyOnceWith(
      error,
      selection,
      { type: "move-keyframes", targets: moves },
      "Move 2 keyframes",
    );
  });
});

describe("useGsapKeyframeOps — removeKeyframe settlement", () => {
  it("returns true only after the durable remove commit settles", async () => {
    let finishCommit!: () => void;
    const commitMutation = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCommit = resolve;
        }),
    );
    const api = renderKeyframeOps({ commitMutation, trackGsapSaveFailure: vi.fn() });

    const pending = api.removeKeyframe(selection, "box-to-0-position", 50);
    finishCommit();

    await expect(pending).resolves.toBe(true);
  });

  it("returns false and retains existing save failure reporting when removal rejects", async () => {
    const error = new Error("write failed");
    const trackGsapSaveFailure = vi.fn();
    const api = renderKeyframeOps({
      commitMutation: vi.fn().mockRejectedValue(error),
      trackGsapSaveFailure,
    });

    await expect(api.removeKeyframe(selection, "box-to-0-position", 50)).resolves.toBe(false);
    expect(trackGsapSaveFailure).toHaveBeenCalledExactlyOnceWith(
      error,
      selection,
      { type: "remove-keyframe", animationId: "box-to-0-position", percentage: 50 },
      "Remove keyframe at 50%",
    );
  });
});

describe("useGsapKeyframeOps — atomic keyframe removal", () => {
  it("submits same-element removals through one batch mutation and one reload boundary", async () => {
    const batch = vi.fn(async () => undefined);
    const commitMutation = Object.assign(vi.fn(async () => undefined), { batch });
    const api = renderKeyframeOps({ commitMutation, trackGsapSaveFailure: vi.fn() });

    await expect(
      api.removeKeyframes(
        selection,
        [
          { animationId: "box-position", percentage: 10 },
          { animationId: "box-visual", percentage: 90 },
        ],
        { coalesceKey: "delete-keyframes:1", coalesceMs: Infinity },
      ),
    ).resolves.toBe(true);

    expect(commitMutation).not.toHaveBeenCalled();
    expect(batch).toHaveBeenCalledExactlyOnceWith(
      [
        expect.objectContaining({
          selection,
          mutation: { type: "remove-keyframe", animationId: "box-position", percentage: 10 },
        }),
        expect.objectContaining({
          selection,
          mutation: { type: "remove-keyframe", animationId: "box-visual", percentage: 90 },
        }),
      ],
      expect.objectContaining({
        label: "Remove 2 keyframes",
        softReload: true,
        coalesceKey: "delete-keyframes:1",
        coalesceMs: Infinity,
      }),
    );
  });

  it("refuses a multi-key delete without batch support instead of partially writing", async () => {
    const commitMutation = vi.fn(async () => undefined);
    const trackGsapSaveFailure = vi.fn();
    const api = renderKeyframeOps({ commitMutation, trackGsapSaveFailure });

    await expect(
      api.removeKeyframes(selection, [
        { animationId: "box-position", percentage: 10 },
        { animationId: "box-position", percentage: 90 },
      ]),
    ).resolves.toBe(false);

    expect(commitMutation).not.toHaveBeenCalled();
    expect(trackGsapSaveFailure).toHaveBeenCalledOnce();
  });

  it("rolls back every optimistic removal when the atomic batch rejects", async () => {
    const batch = vi.fn().mockRejectedValue(new Error("batch write failed"));
    const commitMutation = Object.assign(vi.fn(async () => undefined), { batch });
    const api = renderKeyframeOps({ commitMutation, trackGsapSaveFailure: vi.fn() });
    const original: KeyframeCacheEntry = {
      format: "percentage",
      keyframes: [
        { percentage: 10, tweenPercentage: 10, animationId: "box-position", properties: { x: 10 } },
        { percentage: 90, tweenPercentage: 90, animationId: "box-position", properties: { x: 90 } },
      ],
    };
    usePlayerStore.setState({
      keyframeCache: new Map([["index.html#box", original]]),
      gsapAnimations: new Map([
        [
          "index.html#box",
          [
            {
              id: "box-position",
              targetSelector: "#box",
              method: "to",
              position: 0,
              properties: { x: 90 },
              keyframes: {
                format: "percentage",
                keyframes: [
                  { percentage: 10, properties: { x: 10 } },
                  { percentage: 90, properties: { x: 90 } },
                ],
              },
            },
          ],
        ],
      ]),
    });

    await expect(
      api.removeKeyframes(selection, [
        { animationId: "box-position", percentage: 10 },
        { animationId: "box-position", percentage: 90 },
      ]),
    ).resolves.toBe(false);

    expect(usePlayerStore.getState().keyframeCache.get("index.html#box")).toBe(original);
  });

  it("submits a layer reset as one batch and clears cache only after it succeeds", async () => {
    const batch = vi.fn(async (...args: unknown[]) => {
      (args[1] as CommitOptions).onResult?.({ ok: true, changed: true });
    });
    const commitMutation = Object.assign(vi.fn(async () => undefined), { batch });
    const api = renderKeyframeOps({ commitMutation, trackGsapSaveFailure: vi.fn() });
    usePlayerStore.setState({
      keyframeCache: new Map([
        ["index.html#box", { format: "percentage", keyframes: [{ percentage: 0, properties: { x: 0 } }] }],
      ]),
    });

    await expect(
      api.removeAllKeyframesBatch(selection, ["box-position", "box-visual"], {
        coalesceKey: "reset-keyframes:1",
        coalesceMs: Infinity,
      }),
    ).resolves.toBe(true);

    expect(commitMutation).not.toHaveBeenCalled();
    expect(batch).toHaveBeenCalledExactlyOnceWith(
      [
        expect.objectContaining({ mutation: { type: "remove-all-keyframes", animationId: "box-position" } }),
        expect.objectContaining({ mutation: { type: "remove-all-keyframes", animationId: "box-visual" } }),
      ],
      expect.objectContaining({ softReload: true, coalesceKey: "reset-keyframes:1" }),
    );
    expect(usePlayerStore.getState().keyframeCache.has("index.html#box")).toBe(false);
  });

  it("refuses a multi-animation reset without batch support instead of partially writing", async () => {
    const commitMutation = vi.fn(async () => undefined);
    const trackGsapSaveFailure = vi.fn();
    const api = renderKeyframeOps({ commitMutation, trackGsapSaveFailure });

    await expect(
      api.removeAllKeyframesBatch(selection, ["box-position", "box-visual"]),
    ).resolves.toBe(false);

    expect(commitMutation).not.toHaveBeenCalled();
    expect(trackGsapSaveFailure).toHaveBeenCalledOnce();
  });
});

describe("useGsapKeyframeOps — optimistic keyframe cache", () => {
  it("restores the original cache when concurrent optimistic removals both reject", async () => {
    let rejectFirst!: (error: Error) => void;
    let rejectSecond!: (error: Error) => void;
    const commitMutation = vi
      .fn<(...args: unknown[]) => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectSecond = reject;
          }),
      );
    const api = renderKeyframeOps({ commitMutation, trackGsapSaveFailure: vi.fn() });
    const original: KeyframeCacheEntry = {
      format: "percentage",
      keyframes: [
        {
          percentage: 10,
          tweenPercentage: 10,
          animationId: "box-position",
          properties: { x: 10 },
        },
        {
          percentage: 90,
          tweenPercentage: 90,
          animationId: "box-position",
          properties: { x: 90 },
        },
      ],
    };
    usePlayerStore.setState({
      keyframeCache: new Map([["index.html#box", original]]),
      gsapAnimations: new Map([
        [
          "index.html#box",
          [
            {
              id: "box-position",
              targetSelector: "#box",
              method: "to",
              position: 0,
              properties: { x: 90 },
              keyframes: {
                format: "percentage",
                keyframes: [
                  { percentage: 10, properties: { x: 10 } },
                  { percentage: 90, properties: { x: 90 } },
                ],
              },
            },
          ],
        ],
      ]),
    });

    const first = api.removeKeyframe(selection, "box-position", 10);
    const second = api.removeKeyframe(selection, "box-position", 90);
    rejectFirst(new Error("first write failed"));
    rejectSecond(new Error("second write failed"));

    await expect(Promise.all([first, second])).resolves.toEqual([false, false]);
    expect(usePlayerStore.getState().keyframeCache.get("index.html#box")).toBe(original);
  });

  it("does not remove a dense long-tween keyframe from a different rendered frame", () => {
    let leaveCommitPending: (() => void) | undefined;
    const api = renderKeyframeOps({
      commitMutation: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            leaveCommitPending = resolve;
          }),
      ),
      trackGsapSaveFailure: vi.fn(),
    });
    const cached: KeyframeCacheEntry = {
      format: "percentage",
      keyframes: [
        {
          percentage: 50,
          tweenPercentage: 50,
          animationId: "long-position",
          properties: { x: 120 },
        },
      ],
    };
    usePlayerStore.setState({
      keyframeCache: new Map([["index.html#box", cached]]),
      gsapAnimations: new Map<string, GsapAnimation[]>([
        [
          "index.html#box",
          [
            {
              id: "long-position",
              targetSelector: "#box",
              method: "to",
              position: 0,
              duration: 120,
              properties: { x: 120 },
              keyframes: {
                format: "percentage",
                keyframes: [
                  { percentage: 50, properties: { x: 120 } },
                  { percentage: 50.5, properties: { x: 121 } },
                ],
              },
            },
          ],
        ],
      ]),
    });

    api.removeKeyframe(selection, "long-position", 50.5);

    // 0.5% of a 120s tween spans eighteen output frames. An explicit source
    // identity therefore must never use the old ±2% writer tolerance.
    expect(usePlayerStore.getState().keyframeCache.get("index.html#box")).toBe(cached);
    leaveCommitPending?.();
  });

  it("uses output-frame identity for a legacy row only when source timing is valid", () => {
    let leaveCommitPending: (() => void) | undefined;
    const api = renderKeyframeOps({
      commitMutation: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            leaveCommitPending = resolve;
          }),
      ),
      trackGsapSaveFailure: vi.fn(),
    });
    const cached: KeyframeCacheEntry = {
      format: "percentage",
      keyframes: [{ percentage: 50, properties: { x: 120 } }],
    };
    usePlayerStore.setState({
      keyframeCache: new Map([["index.html#box", cached]]),
      gsapAnimations: new Map<string, GsapAnimation[]>([
        [
          "index.html#box",
          [
            {
              id: "legacy-position",
              targetSelector: "#box",
              method: "to",
              position: 0,
              duration: 120,
              properties: { x: 120 },
            },
          ],
        ],
      ]),
    });

    api.removeKeyframe(selection, "legacy-position", 50.03);

    // The row has no source pair, so it uses its target tween's output clock:
    // 0.03% is 0.036s / more than one Studio frame on this long tween.
    expect(usePlayerStore.getState().keyframeCache.get("index.html#box")).toBe(cached);
    leaveCommitPending?.();
  });

  it("requires an exact percentage for a legacy row without source timing", () => {
    let leaveCommitPending: (() => void) | undefined;
    const api = renderKeyframeOps({
      commitMutation: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            leaveCommitPending = resolve;
          }),
      ),
      trackGsapSaveFailure: vi.fn(),
    });
    const cached: KeyframeCacheEntry = {
      format: "percentage",
      keyframes: [{ percentage: 50, properties: { x: 120 } }],
    };
    usePlayerStore.setState({
      keyframeCache: new Map([["index.html#box", cached]]),
      gsapAnimations: new Map<string, GsapAnimation[]>([
        [
          "index.html#box",
          [
            {
              id: "durationless-legacy-position",
              targetSelector: "#box",
              method: "to",
              position: 0,
              properties: { x: 120 },
            },
          ],
        ],
      ]),
    });

    api.removeKeyframe(selection, "durationless-legacy-position", 50.01);

    expect(usePlayerStore.getState().keyframeCache.get("index.html#box")).toBe(cached);
    leaveCommitPending?.();
  });

  it("keeps a colliding row intact when its surviving source has no exact dense-stop match", () => {
    let leaveCommitPending: (() => void) | undefined;
    const api = renderKeyframeOps({
      commitMutation: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            leaveCommitPending = resolve;
          }),
      ),
      trackGsapSaveFailure: vi.fn(),
    });
    const cached: KeyframeCacheEntry = {
      format: "percentage",
      keyframes: [
        {
          percentage: 50,
          tweenPercentage: 50,
          animationId: "position",
          properties: { x: 120, opacity: 0.4 },
          collidingAnimationTargets: [
            { animationId: "position", tweenPercentage: 50 },
            { animationId: "visual", tweenPercentage: 75 },
          ],
        },
      ],
    };
    usePlayerStore.setState({
      keyframeCache: new Map([["index.html#box", cached]]),
      gsapAnimations: new Map<string, GsapAnimation[]>([
        [
          "index.html#box",
          [
            {
              id: "position",
              targetSelector: "#box",
              method: "to",
              position: 0,
              duration: 120,
              properties: { x: 120 },
              keyframes: { format: "percentage", keyframes: [{ percentage: 50, properties: { x: 120 } }] },
            },
            {
              id: "visual",
              targetSelector: "#box",
              method: "to",
              position: 0,
              duration: 120,
              properties: { opacity: 0.4 },
              // 74% is 36 frames from 75% on this tween. It is not the
              // surviving 75% source keyframe despite the former ±2% match.
              keyframes: { format: "percentage", keyframes: [{ percentage: 74, properties: { opacity: 0.4 } }] },
            },
          ],
        ],
      ]),
    });

    api.removeKeyframe(selection, "position", 50);

    expect(usePlayerStore.getState().keyframeCache.get("index.html#box")).toBe(cached);
    leaveCommitPending?.();
  });

  it("merges an added colliding secondary source into its existing collapsed row", () => {
    let leaveCommitPending: (() => void) | undefined;
    const api = renderKeyframeOps({
      commitMutation: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            leaveCommitPending = resolve;
          }),
      ),
      trackGsapSaveFailure: vi.fn(),
    });
    usePlayerStore.setState({
      keyframeCache: new Map([
        [
          "index.html#box",
          {
            format: "percentage",
            keyframes: [
              {
                percentage: 50,
                tweenPercentage: 50,
                animationId: "position",
                properties: { x: 120, opacity: 0.4 },
                collidingAnimationTargets: [
                  { animationId: "position", tweenPercentage: 50 },
                  { animationId: "visual", tweenPercentage: 75 },
                ],
              },
            ],
          },
        ],
      ]),
      gsapAnimations: new Map<string, GsapAnimation[]>([
        [
          "index.html#box",
          [
            {
              id: "position",
              targetSelector: "#box",
              method: "to",
              position: 0,
              duration: 2,
              properties: { x: 120 },
              keyframes: { format: "percentage", keyframes: [{ percentage: 50, properties: { x: 120 } }] },
            },
            {
              id: "visual",
              targetSelector: "#box",
              method: "to",
              position: 0.5,
              duration: 2 / 3,
              properties: { opacity: 0.4 },
              keyframes: { format: "percentage", keyframes: [{ percentage: 75, properties: { opacity: 0.4 } }] },
            },
          ],
        ],
      ]),
    });

    api.addKeyframe(selection, "visual", 75, "filter", "blur(2px)");

    expect(usePlayerStore.getState().keyframeCache.get("index.html#box")?.keyframes).toEqual([
      {
        percentage: 50,
        tweenPercentage: 50,
        animationId: "position",
        properties: { x: 120, opacity: 0.4, filter: "blur(2px)" },
        collidingAnimationTargets: [
          { animationId: "position", tweenPercentage: 50 },
          { animationId: "visual", tweenPercentage: 75 },
        ],
      },
    ]);
    leaveCommitPending?.();
  });

  it("removes only the requested source tween from a colliding cache row", () => {
    let leaveCommitPending: (() => void) | undefined;
    const commitMutation = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          leaveCommitPending = resolve;
        }),
    );
    const api = renderKeyframeOps({ commitMutation, trackGsapSaveFailure: vi.fn() });
    const cached: KeyframeCacheEntry = {
      format: "percentage",
      keyframes: [
        {
          percentage: 50,
          tweenPercentage: 50,
          animationId: "box-position",
          propertyGroup: "position",
          properties: { x: 120, opacity: 0.4 },
          collidingAnimationTargets: [
            { animationId: "box-position", tweenPercentage: 50 },
            { animationId: "box-visual", tweenPercentage: 75 },
          ],
        },
      ],
    };
    usePlayerStore.setState({
      keyframeCache: new Map([["index.html#box", cached]]),
      gsapAnimations: new Map<string, GsapAnimation[]>([
        [
          "index.html#box",
          [
            {
              id: "box-position",
              targetSelector: "#box",
              method: "to",
              position: 0,
              properties: { x: 120 },
              propertyGroup: "position",
              keyframes: { format: "percentage", keyframes: [{ percentage: 50, properties: { x: 120 } }] },
            },
            {
              id: "box-visual",
              targetSelector: "#box",
              method: "to",
              position: 0,
              properties: { opacity: 0.4 },
              propertyGroup: "visual",
              keyframes: {
                format: "percentage",
                keyframes: [{ percentage: 75, properties: { opacity: 0.4 } }],
              },
            },
          ],
        ],
      ]),
    });

    api.removeKeyframe(selection, "box-position", 50);

    expect(usePlayerStore.getState().keyframeCache.get("index.html#box")).toEqual({
      format: "percentage",
      keyframes: [
        {
          percentage: 50,
          tweenPercentage: 75,
          animationId: "box-visual",
          propertyGroup: "visual",
          properties: { opacity: 0.4 },
        },
      ],
    });

    leaveCommitPending?.();
  });
});

describe("useGsapKeyframeOps — keyframe transaction options", () => {
  it("routes a flat-lane add through the add-keyframe writer mutation", async () => {
    const commitMutation = successfulCommitMutation();
    const api = renderKeyframeOps({ commitMutation, trackGsapSaveFailure: vi.fn() });

    await act(async () => {
      await api.addKeyframeBatch(selection, "box-to-0-position", 50, { x: 210 });
    });

    expect(commitMutation).toHaveBeenCalledWith(
      selection,
      {
        type: "add-keyframe",
        animationId: "box-to-0-position",
        percentage: 50,
        properties: { x: 210 },
      },
      { label: "Add keyframe at 50%", softReload: true },
    );
  });

  it("soft-reloads a standalone convert when the SDK path is unavailable", async () => {
    const commitMutation = successfulCommitMutation();
    const api = renderKeyframeOps({ commitMutation, trackGsapSaveFailure: vi.fn() });

    await act(async () => {
      await api.convertToKeyframes(selection, "box-to-0-opacity");
    });

    expect(commitMutation).toHaveBeenCalledWith(
      selection,
      expect.objectContaining({
        type: "convert-to-keyframes",
        animationId: "box-to-0-opacity",
      }),
      { label: "Convert to keyframes", softReload: true },
    );
  });

  it("clears delete-all cache only when persistence confirms the change", async () => {
    let finishCommit: (() => void) | undefined;
    const commitMutation = vi.fn(
      (...args: unknown[]) =>
        new Promise<void>((resolve) => {
          const options = readCommitOptions(args);
          finishCommit = () => {
            options.onResult?.({ ok: true, changed: true });
            resolve();
          };
        }),
    );
    const api = renderKeyframeOps({
      commitMutation,
      trackGsapSaveFailure: vi.fn(),
    });
    const cached: KeyframeCacheEntry = {
      format: "percentage",
      keyframes: [
        { percentage: 0, properties: { x: 0 } },
        { percentage: 100, properties: { x: 200 } },
      ],
    };
    usePlayerStore.setState({ keyframeCache: new Map([["index.html#box", cached]]) });

    const pending = api.removeAllKeyframes(selection, "box-to-0-position");
    expect(commitMutation).toHaveBeenCalledWith(
      selection,
      { type: "remove-all-keyframes", animationId: "box-to-0-position" },
      expect.objectContaining({ label: "Remove all keyframes", softReload: true }),
    );
    expect(usePlayerStore.getState().keyframeCache.get("index.html#box")).toBe(cached);

    finishCommit?.();
    await pending;
    expect(usePlayerStore.getState().keyframeCache.has("index.html#box")).toBe(false);
  });

  it("clears the live DOM identity for a selector-only selection", async () => {
    const element = document.createElement("div");
    element.id = "box";
    const selectorOnlySelection: DomEditSelection = {
      ...selection,
      id: undefined,
      selector: ".box",
      element,
    };
    const commitMutationSafely = vi.fn(async (...args: unknown[]) => {
      const options = readCommitOptions(args);
      options.onResult?.({ ok: true, changed: true });
    });
    const api = renderKeyframeOps({
      commitMutation: successfulCommitMutation(),
      commitMutationSafely,
      trackGsapSaveFailure: vi.fn(),
    });
    const cached: KeyframeCacheEntry = {
      format: "percentage",
      keyframes: [{ percentage: 0, properties: { x: 0 } }],
    };
    usePlayerStore.setState({ keyframeCache: new Map([["index.html#box", cached]]) });

    await api.removeAllKeyframes(selectorOnlySelection, "box-to-0-position");

    expect(usePlayerStore.getState().keyframeCache.has("index.html#box")).toBe(false);
  });

  it("threads one coalesce key through skipped convert reload and terminal batch edit", async () => {
    const commitMutation = successfulCommitMutation();
    const api = renderKeyframeOps({ commitMutation, trackGsapSaveFailure: vi.fn() });
    const coalesceKey = "enable-keyframes:box-to-0-opacity:1";

    await act(async () => {
      await api.convertToKeyframes(selection, "box-to-0-opacity", undefined, undefined, {
        skipReload: true,
        coalesceKey,
        coalesceMs: Infinity,
      });
      await api.addKeyframeBatch(
        selection,
        "box-to-0-opacity",
        50,
        { opacity: 0.5 },
        {
          coalesceKey,
        },
      );
    });

    expect(commitMutation.mock.calls[0]?.[2]).toEqual({
      label: "Convert to keyframes",
      skipReload: true,
      coalesceKey,
      coalesceMs: Infinity,
    });
    expect(commitMutation.mock.calls[1]?.[2]).toEqual({
      label: "Add keyframe at 50%",
      softReload: true,
      coalesceKey,
    });
  });
});
