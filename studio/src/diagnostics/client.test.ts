// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installInteractionCapture } from "./interactions";

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach((close) => close()); document.body.innerHTML = ""; });
describe("diagnostic interactions", () => {
  it("captures semantic clicks and gestures without recording text, values or user DOM ids", () => {
    const record = vi.fn();
    cleanups.push(installInteractionCapture(window, record));
    document.body.innerHTML = '<button data-diagnostic-action="export-video"><span>Private project title</span></button><input id="CANARY_ID" value="CANARY_PASSWORD" type="password">';
    document.querySelector("span")!.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 20 }));
    const input = document.querySelector("input")!;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "p", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true }));
    const serialized = JSON.stringify(record.mock.calls);
    expect(serialized).toContain("export-video");
    expect(serialized).toContain("ui.click");
    expect(serialized).toContain("ui.change");
    expect(serialized).not.toMatch(/CANARY|Private project|ui.shortcut/);
  });
  it("records shortcuts outside editable controls and tears down listeners", () => {
    const record = vi.fn();
    const stop = installInteractionCapture(window, record);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true }));
    expect(record).toHaveBeenCalledWith("ui.shortcut", expect.objectContaining({ key: "z", meta: true }));
    stop();
    record.mockClear();
    document.body.click();
    expect(record).not.toHaveBeenCalled();
  });
});
