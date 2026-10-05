// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { usePlayerStore } from "../../player/store/playerStore";
import { thumbnailScheduler } from "../../player/lib/thumbnailScheduler";
import * as metadata from "../../player/lib/timelineMediaMetadata";

vi.unmock("../../lib/desktopClient");
import { useExternalFileChangeCoordinator } from "./useExternalFileChangeCoordinator";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  usePlayerStore.getState().reset();
  delete (window as unknown as { mpvfx?: unknown }).mpvfx;
});

it("reconciles the open project after a desktop file-change subscription reconnects", async () => {
  vi.useFakeTimers();
  const listeners: Array<(event: { type: string; data: string }) => void> = [];
  const stops: Array<ReturnType<typeof vi.fn>> = [];
  const subscribe = vi.fn((_path: string, listener: (event: { type: string; data: string }) => void) => {
    listeners.push(listener);
    const stop = vi.fn();
    stops.push(stop);
    return stop;
  });
  (window as unknown as { mpvfx: { subscribe: typeof subscribe } }).mpvfx = { subscribe };
  const drainPendingChanges = vi.fn(async () => ({ status: "clean" as const }));
  const reloadPreview = vi.fn();
  const reloadSdkSession = vi.fn();
  const invalidateProject = vi.spyOn(thumbnailScheduler, "invalidateProject").mockImplementation(() => {});
  const enrich = vi.spyOn(metadata, "enrichTimelineSourceDurations").mockImplementation(() => {});
  usePlayerStore.setState({ timelineProjectId: "project-a", elements: [{
    id: "clip", tag: "video", src: "assets/clip.mp4", start: 0, duration: 5,
    track: 0, sourceDuration: 5,
  }] });
  const root = createRoot(document.createElement("div"));

  function Probe() {
    useExternalFileChangeCoordinator({
      projectId: "project-a",
      activeCompPath: "index.html",
      pendingTimelineEditPathRef: { current: new Set<string>() },
      drainPendingChanges,
      discardPendingChanges: vi.fn(),
      reloadPreview,
      reloadSdkSession,
      persistConflictSnapshot: vi.fn(async () => undefined),
      overwriteConflict: vi.fn(async () => undefined),
      readProjectFile: vi.fn(async () => "external"),
    });
    return null;
  }
  try {
    await act(async () => root.render(<Probe />));
    expect(subscribe).toHaveBeenCalledWith("/api/events", expect.any(Function));
    await act(async () => listeners[0]!({ type: "ready", data: "" }));
    expect(reloadPreview).not.toHaveBeenCalled();
    await act(async () => listeners[0]!({ type: "error", data: "Subscription failed" }));
    expect(stops[0]).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTime(1000));
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(reloadPreview).not.toHaveBeenCalled();
    await act(async () => listeners[1]!({ type: "ready", data: "" }));
    expect(invalidateProject).toHaveBeenCalledWith("project-a");
    expect(usePlayerStore.getState().elements[0]?.sourceDuration).toBeUndefined();
    expect(enrich).toHaveBeenCalledOnce();
    expect(drainPendingChanges).toHaveBeenCalledOnce();
    expect(reloadPreview).toHaveBeenCalledOnce();
    expect(reloadSdkSession).toHaveBeenCalledWith("index.html");
  } finally {
    await act(async () => root.unmount());
    expect(stops[1]).toHaveBeenCalledOnce();
  }
});
