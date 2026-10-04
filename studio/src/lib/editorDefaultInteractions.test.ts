// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { shouldBlockChromeSelection, shouldBlockNativeGhostDrag } from "./editorDefaultInteractions";

describe("editor browser defaults", () => {
  it("blocks chrome text selection but preserves editable fields", () => {
    const label = document.createElement("span");
    const input = document.createElement("input");
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    const nested = document.createElement("span");
    editor.append(nested);
    expect(shouldBlockChromeSelection(label)).toBe(true);
    expect(shouldBlockChromeSelection(input)).toBe(false);
    expect(shouldBlockChromeSelection(nested)).toBe(false);
  });

  it("blocks native image/link ghosts, preserving deliberate DnD and inline edits", () => {
    const image = document.createElement("img");
    const link = document.createElement("a");
    link.href = "#help";
    const card = document.createElement("div");
    card.setAttribute("draggable", "true");
    card.append(image);
    expect(shouldBlockNativeGhostDrag(image)).toBe(false);
    image.remove();
    expect(shouldBlockNativeGhostDrag(image)).toBe(true);
    expect(shouldBlockNativeGhostDrag(link)).toBe(true);
    const input = document.createElement("input");
    expect(shouldBlockNativeGhostDrag(input)).toBe(false);
  });
});
