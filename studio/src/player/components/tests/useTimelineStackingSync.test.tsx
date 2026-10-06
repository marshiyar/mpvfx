// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { TimelineElement } from "../../store/playerStore";
import { mountReactHarness } from "../../../features/canvas/domSelectionTestHarness";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  actions: null as null | {
    previewIframeRef: { current: HTMLIFrameElement | null };
    handleDomZIndexReorderCommit: ReturnType<typeof vi.fn>;
  },
}));

vi.mock("../../../features/canvas/DomEditContext", () => ({
  useDomEditActionsContextOptional: () => mocks.actions,
}));
vi.mock("../../../app/StudioContext", () => ({
  useStudioShellContextOptional: () => ({ activeCompPath: "nested.html" }),
}));

import { useTimelineStackingSync } from "../useTimelineStackingSync";

describe("useTimelineStackingSync", () => {
  it("forwards resolved entries and the lane gesture coalesce key", async () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const node = iframe.contentDocument!.createElement("div");
    node.setAttribute("data-hf-id", "hf-a");
    iframe.contentDocument!.body.appendChild(node);
    const commit = vi.fn().mockResolvedValue(undefined);
    mocks.actions = { previewIframeRef: { current: iframe }, handleDomZIndexReorderCommit: commit };
    const element: TimelineElement = {
      id: "a",
      key: "a",
      hfId: "hf-a",
      tag: "div",
      start: 0,
      duration: 2,
      track: 0,
    };
    let apply: ((patches: Array<{ key: string; zIndex: number }>, key?: string) => unknown) | null =
      null;
    function Harness() {
      apply = useTimelineStackingSync({
        expandedElementsRef: { current: [element] },
      }).applyStackingPatches;
      return null;
    }
    const root = mountReactHarness(<Harness />);

    await act(async () => {
      await apply!([{ key: "a", zIndex: 8 }], "clip-lane-move:7");
    });

    expect(commit).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          element: node,
          zIndex: 8,
          sourceFile: "nested.html",
          // The patch's store key rides along so the commit updates the store
          // zIndex synchronously on the lane-sync path (and rolls it back on
          // failure) instead of waiting for a preview reload.
          key: "a",
        }),
      ],
      "clip-lane-move:7",
    );
    act(() => root.unmount());
    mocks.actions = null;
    iframe.remove();
  });

  it("preserves authored stacking on initial load even when it differs from lane order", async () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const photoNode = iframe.contentDocument!.createElement("img");
    photoNode.id = "photo";
    photoNode.style.zIndex = "3";
    const videoNode = iframe.contentDocument!.createElement("video");
    videoNode.id = "video";
    videoNode.style.zIndex = "0";
    iframe.contentDocument!.body.append(photoNode, videoNode);
    const commit = vi.fn().mockResolvedValue(undefined);
    mocks.actions = { previewIframeRef: { current: iframe }, handleDomZIndexReorderCommit: commit };
    const elements: TimelineElement[] = [
      {
        id: "photo",
        domId: "photo",
        tag: "img",
        kind: "image",
        start: 0,
        duration: 4,
        track: 1,
        sourceFile: "nested.html",
      },
      {
        id: "video",
        domId: "video",
        tag: "video",
        kind: "video",
        start: 0,
        duration: 8,
        track: 0,
        sourceFile: "nested.html",
      },
    ];
    function Harness() {
      useTimelineStackingSync({
        expandedElementsRef: { current: elements },
      });
      return null;
    }
    const root = mountReactHarness(<Harness />);

    await act(async () => {});

    expect(commit).not.toHaveBeenCalled();
    expect(photoNode.style.zIndex).toBe("3");
    expect(videoNode.style.zIndex).toBe("0");
    act(() => root.unmount());
    mocks.actions = null;
    iframe.remove();
  });

  it("does not reinterpret later timing edits or history reloads as imported stacking", async () => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const doc = iframe.contentDocument!;
    const upper = doc.createElement("video");
    upper.id = "upper";
    upper.style.zIndex = "0";
    const lower = doc.createElement("img");
    lower.id = "lower";
    lower.style.zIndex = "3";
    doc.body.append(upper, lower);
    const commit = vi.fn().mockResolvedValue(undefined);
    mocks.actions = { previewIframeRef: { current: iframe }, handleDomZIndexReorderCommit: commit };
    const initial = [upper, lower].map((node, track): TimelineElement => ({
      id: node.id, domId: node.id, tag: node.tagName.toLowerCase(),
      start: track * 3, duration: 2, track, sourceFile: "nested.html",
    }));
    function Harness({ moved = false }) {
      const elements = moved ? initial.map((element) => ({ ...element, start: 0 })) : initial;
      useTimelineStackingSync({ expandedElementsRef: { current: elements } });
      return null;
    }
    const root = mountReactHarness(<Harness />);
    try {
      await act(async () => {});
      expect(commit).not.toHaveBeenCalled();
      await act(async () => root.render(<Harness moved />));
      await act(async () => root.render(<Harness moved key="history-reload" />));
      expect(commit).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      mocks.actions = null;
      iframe.remove();
    }
  });

});
