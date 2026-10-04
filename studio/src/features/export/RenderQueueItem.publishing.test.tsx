// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { RenderQueueItem } from "./RenderQueueItem";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
describe("completed export publishing", () => {
  it("opens the existing publisher only on click and reports missing setup", async () => {
    const previous = window.mpvfx;
    const openCrosspost = vi.fn().mockRejectedValue(new Error("Publishing requires Python"));
    window.mpvfx = { ...previous, openCrosspost };
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    try {
      act(() => root.render(<RenderQueueItem job={{ id: "export", status: "complete", progress: 100, filename: "movie.mp4", createdAt: Date.now() }} projectId="project" onDelete={vi.fn()} onCancel={vi.fn()} />));
      expect(openCrosspost).not.toHaveBeenCalled();
      const button = Array.from(host.querySelectorAll("button")).find(item => item.textContent === "Publish…")!;
      await act(async () => { button.click(); });
      expect(openCrosspost).toHaveBeenCalledWith("project", "movie.mp4");
      expect(host.querySelector('[role="alert"]')?.textContent).toBe("Publishing requires Python");
    } finally {
      act(() => root.unmount()); host.remove(); window.mpvfx = previous;
    }
  });
});
