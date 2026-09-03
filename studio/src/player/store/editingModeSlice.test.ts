import { describe, expect, it, vi } from "vitest";
import { createEditingModeSlice } from "./editingModeSlice";

describe("editing mode defaults", () => {
  it("does not auto-record manual edits as keyframes until the user enables it", () => {
    const slice = createEditingModeSlice(vi.fn() as never);

    expect(slice.autoKeyframeEnabled).toBe(false);
  });
});
