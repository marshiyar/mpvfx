// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import {
  notifyMediaSourceChange,
  projectMediaSourcePath,
  subscribeMediaSourceChange,
} from "../mediaSourceChanges";

describe("project media source ownership", () => {
  it.each([
    ["assets/a #100%.mp4", "assets/a #100%.mp4"],
    ["./assets/a.mp4", "assets/a.mp4"],
    ["/api/projects/p/preview/assets/a%20%23100%25.mp4?revision=x", "assets/a #100%.mp4"],
    [`${window.location.origin}/api/projects/p/preview/assets/a.mp4`, "assets/a.mp4"],
    ["https://foreign.example/api/projects/p/preview/assets/a.mp4", null],
    ["/api/projects/other/preview/assets/a.mp4", null],
    ["../assets/a.mp4", null],
  ])("resolves %s without crossing ownership boundaries", (source, expected) => {
    expect(projectMediaSourcePath(source, "p")).toBe(expected);
  });

  it("notifies only the exact project's mounted source consumers", () => {
    const affected = vi.fn();
    const neighbor = vi.fn();
    const foreign = vi.fn();
    const subscriptions = [
      subscribeMediaSourceChange("p", "/api/projects/p/preview/assets/a.mp4", affected),
      subscribeMediaSourceChange("p", "assets/a.mp4.copy", neighbor),
      subscribeMediaSourceChange("other", "assets/a.mp4", foreign),
    ];
    notifyMediaSourceChange("p", "assets/a.mp4");
    expect(affected).toHaveBeenCalledOnce();
    expect(neighbor).not.toHaveBeenCalled();
    expect(foreign).not.toHaveBeenCalled();
    subscriptions.forEach((unsubscribe) => unsubscribe());
    notifyMediaSourceChange("p", "assets/a.mp4");
    expect(affected).toHaveBeenCalledOnce();
  });
});
