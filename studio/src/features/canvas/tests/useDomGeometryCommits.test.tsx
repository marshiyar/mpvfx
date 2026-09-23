// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { DomEditSelection } from "../domEditingTypes";
import {
  applyStudioBoxSize,
  applyStudioPathOffset,
  applyStudioRotation,
  applyStudioBoxSizeDraft,
  beginStudioManualEditGesture,
  readStudioBoxSize,
  readStudioPathOffset,
  readStudioRotation,
} from "../manualEdits";
import { useDomGeometryCommits } from "../useDomGeometryCommits";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function pendingGeometryCommit() {
  const element = document.createElement("div");
  element.id = "box";
  document.body.append(element);
  applyStudioPathOffset(element, { x: 10, y: 20 });
  applyStudioBoxSize(element, { width: 100, height: 80 });
  applyStudioRotation(element, { angle: 15 });
  const selection = {
    id: "box",
    selector: "#box",
    element,
  } as unknown as DomEditSelection;
  let rejectSave!: (error: Error) => void;
  const commitPositionPatchToHtml = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSave = reject;
        }),
    )
    .mockResolvedValue(undefined);
  let commits!: ReturnType<typeof useDomGeometryCommits>;
  const root = createRoot(document.createElement("div"));
  function Probe() {
    commits = useDomGeometryCommits({
      previewIframeRef: { current: null },
      showToast: vi.fn(),
      commitPositionPatchToHtml,
    });
    return null;
  }
  act(() => root.render(<Probe />));
  return {
    element,
    selection,
    commits,
    rejectSave: () => rejectSave(new Error("older save failed")),
    dispose: () => {
      act(() => root.unmount());
      element.remove();
    },
  };
}

describe("useDomGeometryCommits rollback", () => {
  it.each(["offset", "size", "rotation"] as const)(
    "does not restore an older failed %s over a newer commit",
    async (channel) => {
      const h = pendingGeometryCommit();
      try {
        const commit = (n: number) => {
          if (channel === "offset")
            return h.commits.handleDomPathOffsetCommit(h.selection, {
              x: n,
              y: n,
            });
          if (channel === "size")
            return h.commits.handleDomBoxSizeCommit(h.selection, {
              width: n,
              height: n,
            });
          return h.commits.handleDomRotationCommit(h.selection, { angle: n });
        };
        const first = commit(50);
        const rejected = expect(first).rejects.toThrow("older save failed");
        await commit(75);
        const newerGeometry = h.element.outerHTML;
        h.rejectSave();
        await rejected;
        expect(h.element.outerHTML).toBe(newerGeometry);
      } finally {
        h.dispose();
      }
    },
  );

  it("does not restore an older save over a newer uncommitted canvas draft", async () => {
    const h = pendingGeometryCommit();
    try {
      beginStudioManualEditGesture(h.element);
      const first = h.commits.handleDomBoxSizeCommit(h.selection, {
        width: 200,
        height: 160,
      });
      const rejected = expect(first).rejects.toThrow("older save failed");
      beginStudioManualEditGesture(h.element);
      applyStudioBoxSizeDraft(h.element, { width: 250, height: 190 });
      const newerDraft = h.element.outerHTML;
      h.rejectSave();
      await rejected;
      expect(h.element.outerHTML).toBe(newerDraft);
    } finally {
      h.dispose();
    }
  });

  it("rolls back a failed size while preserving an independent rotation and its origin", async () => {
    const h = pendingGeometryCommit();
    try {
      h.element.style.transformOrigin = "left top";
      const first = h.commits.handleDomBoxSizeCommit(h.selection, {
        width: 200,
        height: 160,
      });
      const rejected = expect(first).rejects.toThrow("older save failed");
      await h.commits.handleDomRotationCommit(h.selection, { angle: 75 });
      const rotationOrigin = h.element.style.transformOrigin;
      h.rejectSave();
      await rejected;
      expect(readStudioBoxSize(h.element)).toEqual({ width: 100, height: 80 });
      expect(readStudioRotation(h.element)).toEqual({ angle: 75 });
      expect(h.element.style.transformOrigin).toBe(rotationOrigin);
    } finally {
      h.dispose();
    }
  });

  it("restores only untouched channels after a failed reset", async () => {
    const h = pendingGeometryCommit();
    try {
      const first = h.commits.handleDomManualEditsReset(h.selection);
      const rejected = expect(first).rejects.toThrow("older save failed");
      await h.commits.handleDomRotationCommit(h.selection, { angle: 75 });
      const rotationOrigin = h.element.style.transformOrigin;
      h.rejectSave();
      await rejected;
      expect(readStudioPathOffset(h.element)).toEqual({ x: 10, y: 20 });
      expect(readStudioBoxSize(h.element)).toEqual({ width: 100, height: 80 });
      expect(readStudioRotation(h.element)).toEqual({ angle: 75 });
      expect(h.element.style.transformOrigin).toBe(rotationOrigin);
    } finally {
      h.dispose();
    }
  });

  it("restores every optimistic geometry mutation when persistence rejects", async () => {
    const element = document.createElement("div");
    element.id = "box";
    document.body.append(element);
    applyStudioPathOffset(element, { x: 10, y: 20 });
    applyStudioBoxSize(element, { width: 100, height: 80 });
    applyStudioRotation(element, { angle: 15 });
    const selection = {
      id: "box",
      selector: "#box",
      element,
    } as unknown as DomEditSelection;
    const failure = new Error("save failed");
    const commitPositionPatchToHtml = vi.fn().mockRejectedValue(failure);
    let commits: ReturnType<typeof useDomGeometryCommits> | null = null;
    const host = document.createElement("div");
    const root = createRoot(host);

    function Probe() {
      commits = useDomGeometryCommits({
        previewIframeRef: { current: null },
        showToast: vi.fn(),
        commitPositionPatchToHtml,
      });
      return null;
    }

    act(() => root.render(<Probe />));
    await expect(
      commits!.handleDomPathOffsetCommit(selection, { x: 50, y: 60 }),
    ).rejects.toBe(failure);
    await expect(
      commits!.handleDomBoxSizeCommit(
        selection,
        { width: 200, height: 160 },
        { x: 30, y: 40 },
      ),
    ).rejects.toBe(failure);
    await expect(
      commits!.handleDomRotationCommit(selection, { angle: 45 }),
    ).rejects.toBe(failure);
    await expect(commits!.handleDomManualEditsReset(selection)).rejects.toBe(
      failure,
    );

    expect(readStudioPathOffset(element)).toEqual({ x: 10, y: 20 });
    expect(readStudioBoxSize(element)).toEqual({ width: 100, height: 80 });
    expect(readStudioRotation(element)).toEqual({ angle: 15 });
    act(() => root.unmount());
  });

  it("marks every live geometry commit as refresh-free", async () => {
    const element = document.createElement("div");
    element.id = "box";
    document.body.append(element);
    applyStudioPathOffset(element, { x: 10, y: 20 });
    applyStudioBoxSize(element, { width: 100, height: 80 });
    applyStudioRotation(element, { angle: 15 });
    const selection = {
      id: "box",
      selector: "#box",
      element,
    } as unknown as DomEditSelection;
    const commitPositionPatchToHtml = vi.fn().mockResolvedValue(undefined);
    let commits: ReturnType<typeof useDomGeometryCommits> | null = null;
    const host = document.createElement("div");
    const root = createRoot(host);

    function Probe() {
      commits = useDomGeometryCommits({
        previewIframeRef: { current: null },
        showToast: vi.fn(),
        commitPositionPatchToHtml,
      });
      return null;
    }

    act(() => root.render(<Probe />));
    await commits!.handleDomPathOffsetCommit(selection, { x: 30, y: 40 });
    await commits!.handleDomBoxSizeCommit(selection, {
      width: 120,
      height: 90,
    });
    await commits!.handleDomRotationCommit(selection, { angle: 25 });
    await commits!.handleDomManualEditsReset(selection);

    expect(commitPositionPatchToHtml).toHaveBeenCalledTimes(4);
    for (const call of commitPositionPatchToHtml.mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({ skipRefresh: true }));
    }
    act(() => root.unmount());
  });
});
