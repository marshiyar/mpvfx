// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { useCropToolStore } from "./cropToolStore";

afterEach(() => {
  useCropToolStore.getState().deactivate();
  document.body.innerHTML = "";
});

describe("crop tool transaction", () => {
  it("keeps the original inline crop immutable while draft insets change", () => {
    const element = document.createElement("video");
    element.style.setProperty("clip-path", "inset(16px round 12px)");
    useCropToolStore.getState().activate(
      "clip-a",
      element,
      { top: 16, right: 16, bottom: 16, left: 16 },
      "inset(16px round 12px)",
    );

    useCropToolStore
      .getState()
      .previewInsets({ top: 24, right: 8, bottom: 4, left: 2 });

    expect(useCropToolStore.getState().originalClipPath).toBe("inset(16px round 12px)");
    expect(useCropToolStore.getState().insets).toEqual({
      top: 24,
      right: 8,
      bottom: 4,
      left: 2,
    });
    expect(element.style.getPropertyValue("clip-path")).toBe(
      "inset(24px 8px 4px 2px)",
    );
  });

  it("cancels without persistence and restores the exact original inline value", () => {
    const element = document.createElement("video");
    element.style.setProperty("clip-path", "inset(16px round 12px)");
    useCropToolStore.getState().activate(
      "clip-a",
      element,
      { top: 16, right: 16, bottom: 16, left: 16 },
      "inset(16px round 12px)",
    );
    useCropToolStore
      .getState()
      .previewInsets({ top: 0, right: 0, bottom: 0, left: 0 });

    useCropToolStore.getState().cancel("clip-a");

    expect(element.style.getPropertyValue("clip-path")).toBe("inset(16px round 12px)");
    expect(useCropToolStore.getState().targetKey).toBeNull();
  });

  it("persists the final draft once and exits only after success", async () => {
    const element = document.createElement("video");
    useCropToolStore.getState().activate(
      "clip-a",
      element,
      { top: 0, right: 0, bottom: 0, left: 0 },
      "",
    );
    useCropToolStore
      .getState()
      .previewInsets({ top: 12, right: 4, bottom: 3, left: 2 });
    const persist = vi.fn().mockResolvedValue({ ok: true });

    await expect(useCropToolStore.getState().apply("clip-a", persist)).resolves.toBe(true);

    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith("clip-path", "inset(12px 4px 3px 2px)");
    expect(useCropToolStore.getState().targetKey).toBeNull();
  });

  it("keeps ownership of a pending Apply when another clip tries to start cropping", async () => {
    const firstElement = document.createElement("video");
    const secondElement = document.createElement("video");
    useCropToolStore.getState().activate("clip-a", firstElement);
    useCropToolStore
      .getState()
      .previewInsets({ top: 12, right: 4, bottom: 3, left: 2 });

    let resolvePersist: ((value: unknown) => void) | undefined;
    const pendingApply = useCropToolStore.getState().apply(
      "clip-a",
      () =>
        new Promise((resolve) => {
          resolvePersist = resolve;
        }),
    );

    expect(useCropToolStore.getState().applying).toBe(true);
    useCropToolStore.getState().activate("clip-b", secondElement);

    expect(useCropToolStore.getState().targetKey).toBe("clip-a");
    expect(useCropToolStore.getState().targetElement).toBe(firstElement);
    expect(useCropToolStore.getState().applying).toBe(true);

    resolvePersist?.({ ok: false });
    await expect(pendingApply).resolves.toBe(false);
    expect(useCropToolStore.getState().targetKey).toBe("clip-a");
    expect(useCropToolStore.getState().applying).toBe(false);
  });

  it("exits without a history write when Apply has no crop change", async () => {
    const element = document.createElement("video");
    element.style.setProperty("clip-path", "inset(10px)");
    useCropToolStore.getState().activate(
      "clip-a",
      element,
      { top: 10, right: 10, bottom: 10, left: 10 },
      "inset(10px)",
    );
    const persist = vi.fn();

    await expect(useCropToolStore.getState().apply("clip-a", persist)).resolves.toBe(true);

    expect(persist).not.toHaveBeenCalled();
    expect(element.style.getPropertyValue("clip-path")).toBe("inset(10px)");
    expect(useCropToolStore.getState().targetKey).toBeNull();
  });
});
