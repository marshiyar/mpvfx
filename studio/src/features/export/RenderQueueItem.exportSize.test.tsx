// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { RenderQueueItem } from "./RenderQueueItem";
import { AssetPreviewOverlay } from "../media/AssetPreviewOverlay";
import { useAssetPreviewStore } from "../media/assetPreviewStore";
import { usePlayerStore } from "../../player/store/playerStore";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("completed export size", () => {
  it("requests a transport pause and opens the completed export inside the app", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    usePlayerStore.setState({ isPlaying: false, requestedSeekTime: 0.5 });
    act(() => {
      root.render(<>
        <RenderQueueItem job={{ id: "render-1", status: "complete", progress: 100,
          filename: "render-1.mp4", createdAt: Date.now() }} projectId="demo"
          onDelete={vi.fn()} onCancel={vi.fn()} />
        <AssetPreviewOverlay />
      </>);
    });
    try {
      act(() => host.querySelector<HTMLButtonElement>('button[aria-label^="Open render-1.mp4"]')!.click());
      expect(open).not.toHaveBeenCalled();
      expect(host.querySelector('[role="dialog"] video')?.getAttribute("src"))
        .toBe("/api/projects/demo/renders/file/render-1.mp4");
      expect(usePlayerStore.getState().playbackRequest?.playing).toBe(false);
      expect(usePlayerStore.getState().requestedSeekTime).toBeNull();
      act(() => host.querySelector<HTMLButtonElement>('[aria-label="Close preview"]')!.click());
      expect(host.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
      open.mockRestore();
      useAssetPreviewStore.getState().clearPreviewAsset();
      usePlayerStore.getState().reset();
      usePlayerStore.getState().clearSeekRequest();
    }
  });

  it("shows the actual file size returned by render history", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <RenderQueueItem
          job={{
            id: "render-1",
            status: "complete",
            progress: 100,
            filename: "render-1.mp4",
            createdAt: Date.now(),
            sizeBytes: 2.5 * 1024 * 1024,
          }}
          projectId="demo"
          onDelete={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
    });

    expect(host.textContent).toContain("2.5 MB");
    act(() => root.unmount());
    host.remove();
  });
});
