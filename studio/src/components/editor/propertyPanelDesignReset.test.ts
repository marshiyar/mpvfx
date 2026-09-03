import { describe, expect, it, vi } from "vitest";
import type { DomEditSelection } from "./domEditingTypes";
import { resetDesignWithAnimatedLayout } from "./propertyPanelDesignReset";

const selection = {} as DomEditSelection;

describe("resetDesignWithAnimatedLayout", () => {
  it("resets the DOM batch first, then all non-default 3D Layout values in one commit", async () => {
    const order: string[] = [];
    const resetDom = vi.fn(async () => {
      order.push("dom");
      return { ok: true as const };
    });
    const resetAnimated = vi.fn(async (_selection, properties) => {
      order.push("animated");
      expect(properties).toEqual({
        z: 0,
        scale: 1,
        rotationX: 0,
        rotationY: 0,
        rotationZ: 0,
        transformPerspective: 0,
      });
    });

    await resetDesignWithAnimatedLayout({
      selection,
      runtimeValues: {
        z: 80,
        scale: 1.3,
        rotationX: 12,
        rotationY: -8,
        rotationZ: 3,
        transformPerspective: 900,
        x: 140,
        rotation: 22,
      },
      resetDom,
      resetAnimated,
    });

    expect(order).toEqual(["dom", "animated"]);
    expect(resetAnimated).toHaveBeenCalledTimes(1);
  });

  it("does not create an animated write for identity 3D values", async () => {
    const resetAnimated = vi.fn();
    await resetDesignWithAnimatedLayout({
      selection,
      runtimeValues: {
        z: 0,
        scale: 1,
        rotationX: 0,
        rotationY: 0,
        rotationZ: 0,
        transformPerspective: 0,
      },
      resetDom: async () => ({ ok: true }),
      resetAnimated,
    });
    expect(resetAnimated).not.toHaveBeenCalled();
  });

  it("does not reset animated Layout state when the atomic DOM reset fails", async () => {
    const resetAnimated = vi.fn();
    const result = await resetDesignWithAnimatedLayout({
      selection,
      runtimeValues: { rotationY: 35 },
      resetDom: async () => ({ ok: false, reason: "persist-failed" }),
      resetAnimated,
    });
    expect(result).toEqual({ ok: false, reason: "persist-failed" });
    expect(resetAnimated).not.toHaveBeenCalled();
  });
});
