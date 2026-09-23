// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioFileConflictError } from "./studioSaveDiagnostics";
import { usePlayerStore } from "../../player/store/playerStore";
import * as metadata from "../../player/lib/timelineMediaMetadata";
import { subscribeMediaSourceChange } from "../../player/lib/mediaSourceChanges";
import { thumbnailScheduler, type ThumbnailRequest } from "../../player/lib/thumbnailScheduler";
import {
  markStudioWriteToken,
  resetStudioWriteTokens,
} from "./studioFileVersion";
import {
  useExternalFileChangeCoordinator,
  type ExternalFileChangeCoordinatorHandle,
} from "./useExternalFileChangeCoordinator";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type HotHandler = (payload?: unknown) => void;
type CoordinatorOptions = Parameters<
  typeof useExternalFileChangeCoordinator
>[0];
const roots: Array<ReturnType<typeof createRoot>> = [];
let handler: HotHandler | null;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function mountCoordinator(overrides: Partial<CoordinatorOptions> = {}) {
  const captured: { handle: ExternalFileChangeCoordinatorHandle | null } = {
    handle: null,
  };
  const defaults: CoordinatorOptions = {
    projectId: "project-a",
    activeCompPath: "index.html",
    pendingTimelineEditPathRef: { current: new Set() },
    drainPendingChanges: vi.fn(async () => ({ status: "clean" as const })),
    reloadPreview: vi.fn(),
    reloadSdkSession: vi.fn(),
    persistConflictSnapshot: vi.fn(async () => undefined),
    discardPendingChanges: vi.fn(),
    overwriteConflict: vi.fn(async () => undefined),
    readProjectFile: vi.fn(async () => "external"),
  };
  const options = { ...defaults, ...overrides };
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  function Probe() {
    captured.handle = useExternalFileChangeCoordinator(options);
    return null;
  }
  await act(async () => root.render(<Probe />));
  return {
    captured,
    options,
    rerender: async (next: Partial<CoordinatorOptions>) => {
      Object.assign(options, next);
      await act(async () => root.render(<Probe />));
    },
  };
}

describe("external file change coordinator", () => {
  beforeEach(() => {
    handler = null;
    resetStudioWriteTokens();
    vi.stubGlobal("__HF_STUDIO_HOT_TEST_ADAPTER__", {
      on: (_event: string, next: HotHandler) => {
        handler = next;
      },
      off: () => {
        handler = null;
      },
    });
  });

  afterEach(async () => {
    while (roots.length > 0) await act(async () => roots.pop()?.unmount());
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    usePlayerStore.getState().reset();
  });

  it("invalidates media facts without draining or reloading document edits", async () => {
    const enrich = vi.spyOn(metadata, "enrichTimelineSourceDurations").mockImplementation(() => {});
    const changed = { id: "clip", tag: "video", src: "assets/clip.mp4", start: 2, duration: 4, track: 1, sourceDuration: 12 };
    const neighbor = { ...changed, id: "neighbor", src: "assets/other.mp4" };
    const foreign = { ...changed, id: "foreign", src: "/api/projects/other/preview/assets/clip.mp4" };
    usePlayerStore.setState({ timelineProjectId: "project-a", elements: [changed, neighbor, foreign] });
    const notify = vi.fn();
    const unsubscribe = subscribeMediaSourceChange("project-a", changed.src, notify);
    const { options, captured } = await mountCoordinator();
    try {
      await act(async () => handler?.({ projectId: "project-a", kind: "media", path: "assets/clip.mp4", version: "replacement" }));
      expect(usePlayerStore.getState().elements).toEqual([
        { ...changed, sourceDuration: undefined }, neighbor, foreign,
      ]);
      expect(enrich).toHaveBeenCalledWith([{ ...changed, sourceDuration: undefined }]);
      expect(notify).toHaveBeenCalledOnce();
      expect(options.drainPendingChanges).not.toHaveBeenCalled();
      expect(options.reloadPreview).not.toHaveBeenCalled();
      expect(options.reloadSdkSession).not.toHaveBeenCalled();
      expect(options.readProjectFile).not.toHaveBeenCalled();
      expect(captured.handle?.blocked).toBeNull();
    } finally { unsubscribe(); }
  });

  it("evicts an inactive project's changed media so reopening it cannot reuse old frames", async () => {
    const request: ThumbnailRequest = {
      projectId: "project-b", sessionEpoch: 1, source: "assets/clip.mp4", key: "inactive-project-frame",
      kind: "video", priority: "visible",
      load: async () => ({ value: { kind: "image", url: "blob:old-inactive", aspect: 1 }, weight: 1 }),
    };
    const lease = thumbnailScheduler.acquire(request, () => {});
    await vi.waitFor(() => expect(thumbnailScheduler.getSnapshot(request).status).toBe("ready"));
    lease.release();
    const elements = [{ id: "active", tag: "video", src: "assets/clip.mp4", start: 0, duration: 4, track: 0, sourceDuration: 12 }];
    usePlayerStore.setState({ timelineProjectId: "project-a", elements });
    const { options } = await mountCoordinator();
    await act(async () => handler?.({ projectId: "project-b", kind: "media", path: "assets/clip.mp4", version: "replacement" }));
    expect(thumbnailScheduler.getSnapshot(request).status).toBe("idle");
    expect(usePlayerStore.getState().elements).toBe(elements);
    expect(options.drainPendingChanges).not.toHaveBeenCalled();
    expect(options.reloadPreview).not.toHaveBeenCalled();
  });

  it("receives media changes with no active project and reloads fresh frames when that project reopens", async () => {
    const load = vi.fn(async () => ({
      value: { kind: "image" as const, url: "blob:before-home", aspect: 1 }, weight: 1,
    }));
    const request: ThumbnailRequest = {
      projectId: "project-home", sessionEpoch: 1, source: "assets/clip.mp4", key: "home-media-frame",
      kind: "video", priority: "visible", load,
    };
    const first = thumbnailScheduler.acquire(request, () => {});
    await vi.waitFor(() => expect(thumbnailScheduler.getSnapshot(request).status).toBe("ready"));
    first.release();
    usePlayerStore.getState().reset();
    const { options, rerender } = await mountCoordinator({ projectId: null, activeCompPath: null });
    expect(handler).toBeTypeOf("function");
    await act(async () => handler?.({
      projectId: "project-home", kind: "media", path: "assets/clip.mp4", version: "changed-at-home",
    }));
    expect(thumbnailScheduler.getSnapshot(request).status).toBe("idle");
    expect(options.drainPendingChanges).not.toHaveBeenCalled();
    expect(options.reloadPreview).not.toHaveBeenCalled();
    await rerender({ projectId: "project-home", activeCompPath: "index.html" });
    load.mockResolvedValue({ value: { kind: "image", url: "blob:after-home", aspect: 1 }, weight: 1 });
    const reopened = thumbnailScheduler.acquire(request, () => {});
    await vi.waitFor(() => expect(thumbnailScheduler.getSnapshot(request)).toMatchObject({
      status: "ready", value: { url: "blob:after-home" },
    }));
    expect(load).toHaveBeenCalledTimes(2);
    reopened.release();
    thumbnailScheduler.invalidateProject("project-home");
  });

  it("ignores another project's write before consuming tokens or draining this project's edits", async () => {
    const { options } = await mountCoordinator();
    await act(async () =>
      handler?.({
        projectId: "project-b",
        path: "index.html",
        version: "other",
      }),
    );
    expect(options.drainPendingChanges).not.toHaveBeenCalled();
    expect(options.reloadPreview).not.toHaveBeenCalled();
    await act(async () =>
      handler?.({
        data: JSON.stringify({
          projectId: "project-a",
          path: "index.html",
          version: "ours",
        }),
      }),
    );
    expect(options.reloadPreview).toHaveBeenCalledOnce();
  });

  it("drains before reloading Preview and SDK exactly once", async () => {
    const order: string[] = [];
    const { captured } = await mountCoordinator({
      drainPendingChanges: async () => {
        order.push("drain");
        return { status: "clean" };
      },
      reloadPreview: () => order.push("preview"),
      reloadSdkSession: () => order.push("sdk"),
    });
    await act(async () =>
      handler?.({ path: "index.html", content: "external", version: "v2" }),
    );
    expect(order).toEqual(["drain", "preview", "sdk"]);
    expect(captured.handle?.blocked).toBeNull();
  });

  it("suppresses an exact Studio write receipt", async () => {
    const drainPendingChanges = vi.fn(async () => ({
      status: "clean" as const,
    }));
    const reloadPreview = vi.fn();
    const reloadSdkSession = vi.fn();
    await mountCoordinator({
      drainPendingChanges,
      reloadPreview,
      reloadSdkSession,
    });
    markStudioWriteToken("studio-write-1");
    await act(async () =>
      handler?.({
        path: "index.html",
        content: "studio",
        writeToken: "studio-write-1",
      }),
    );
    expect(drainPendingChanges).not.toHaveBeenCalled();
    expect(reloadPreview).not.toHaveBeenCalled();
    expect(reloadSdkSession).not.toHaveBeenCalled();
  });

  it("suppresses its own write when production EventSource delivers JSON in MessageEvent.data", async () => {
    const drainPendingChanges = vi.fn(async () => ({
      status: "clean" as const,
    }));
    const reloadPreview = vi.fn();
    const reloadSdkSession = vi.fn();
    await mountCoordinator({
      drainPendingChanges,
      reloadPreview,
      reloadSdkSession,
    });
    markStudioWriteToken("studio-write-event-source");

    await act(async () =>
      handler?.({
        data: JSON.stringify({
          path: "index.html",
          version: '"sha256:studio"',
          writeToken: "studio-write-event-source",
        }),
      }),
    );

    expect(drainPendingChanges).not.toHaveBeenCalled();
    expect(reloadPreview).not.toHaveBeenCalled();
    expect(reloadSdkSession).not.toHaveBeenCalled();
  });

  it("does not suppress a racing external write by path alone", async () => {
    const pendingTimelineEditPathRef = { current: new Set(["index.html"]) };
    const drainPendingChanges = vi.fn(async () => ({
      status: "clean" as const,
    }));
    const reloadPreview = vi.fn();
    const reloadSdkSession = vi.fn();
    await mountCoordinator({
      pendingTimelineEditPathRef,
      drainPendingChanges,
      reloadPreview,
      reloadSdkSession,
    });
    await act(async () =>
      handler?.({ path: "index.html", content: "agent edit", version: "v2" }),
    );
    expect(pendingTimelineEditPathRef.current).not.toContain("index.html");
    expect(drainPendingChanges).toHaveBeenCalledOnce();
    expect(reloadPreview).toHaveBeenCalledOnce();
    expect(reloadSdkSession).toHaveBeenCalledOnce();
  });

  it("blocks both reloads and retains a complete conflict", async () => {
    const conflict = new StudioFileConflictError({
      filePath: "index.html",
      currentVersion: "v2",
      currentContent: "external",
      attemptedContent: "studio",
    });
    const persistConflictSnapshot = vi.fn(async () => undefined);
    const { captured, options } = await mountCoordinator({
      drainPendingChanges: async () => ({
        status: "conflict",
        error: conflict,
      }),
      persistConflictSnapshot,
    });
    await act(async () =>
      handler?.({ path: "index.html", content: "external", version: "v2" }),
    );
    expect(persistConflictSnapshot).toHaveBeenCalledWith("project-a", conflict);
    expect(captured.handle?.blocked).toMatchObject({
      status: "conflict",
      error: conflict,
    });
    expect(options.reloadPreview).not.toHaveBeenCalled();
    expect(options.reloadSdkSession).not.toHaveBeenCalled();
  });

  it("ignores stale drain completion after a newer generation", async () => {
    const drains: Array<(result: { status: "clean" }) => void> = [];
    const { options } = await mountCoordinator({
      drainPendingChanges: () => new Promise((resolve) => drains.push(resolve)),
    });
    act(() => {
      handler?.({ path: "index.html", content: "first", version: "v2" });
      handler?.({ path: "index.html", content: "second", version: "v3" });
    });
    await act(async () => drains[0]?.({ status: "clean" }));
    expect(options.reloadPreview).not.toHaveBeenCalled();
    await act(async () => drains[1]?.({ status: "clean" }));
    expect(options.reloadPreview).toHaveBeenCalledOnce();
    expect(options.reloadSdkSession).toHaveBeenCalledOnce();
  });

  it("restores a durable unresolved conflict after remount", async () => {
    const { captured } = await mountCoordinator({
      recoveryFilePath: "index.html",
      loadConflictSnapshot: vi.fn(async () => ({
        kind: "conflict" as const,
        projectId: "project-a",
        filePath: "index.html",
        externalVersion: "v2",
        externalContent: "external",
        studioContent: "studio",
        createdAt: 100,
      })),
    });
    await vi.waitFor(() =>
      expect(captured.handle?.blocked?.status).toBe("conflict"),
    );
    expect(captured.handle?.blocked).toMatchObject({
      error: { currentContent: "external", attemptedContent: "studio" },
    });
  });

  it("retains the final local candidate when a drain fails", async () => {
    const failure = new Error("network unavailable");
    const persistFailureSnapshot = vi.fn(async () => undefined);
    const deleteConflictSnapshot = vi.fn(async () => undefined);
    const { captured } = await mountCoordinator({
      drainPendingChanges: vi
        .fn()
        .mockResolvedValueOnce({ status: "failed" as const, error: failure })
        .mockResolvedValueOnce({ status: "clean" as const }),
      getPendingCandidate: () => ({
        path: "index.html",
        content: "final local candidate",
      }),
      persistFailureSnapshot,
      deleteConflictSnapshot,
    });
    await act(async () => handler?.({ path: "index.html" }));
    expect(captured.handle?.blocked).toMatchObject({
      status: "failed",
      error: failure,
      studioContent: "final local candidate",
    });
    expect(persistFailureSnapshot).toHaveBeenCalledWith(
      "project-a",
      "index.html",
      "final local candidate",
      null,
      null,
      failure,
    );
    await act(async () => captured.handle?.retry());
    expect(deleteConflictSnapshot).toHaveBeenCalledWith(
      "project-a",
      "index.html",
    );
  });

  it("restores and overwrites from a durable failed draft", async () => {
    const overwriteConflict = vi.fn(async () => undefined);
    const { captured } = await mountCoordinator({
      recoveryFilePath: "index.html",
      overwriteConflict,
      loadConflictSnapshot: vi.fn(async () => ({
        kind: "failed" as const,
        projectId: "project-a",
        filePath: "index.html",
        externalVersion: "v2",
        externalContent: "external",
        studioContent: "recover me",
        failureMessage: "network unavailable",
        createdAt: 100,
      })),
    });
    await vi.waitFor(() =>
      expect(captured.handle?.blocked?.status).toBe("failed"),
    );
    expect(captured.handle?.blocked).toMatchObject({
      studioContent: "recover me",
      recovered: true,
    });
    await act(async () => captured.handle?.keepStudioFile());
    expect(overwriteConflict).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptedContent: "recover me",
        currentVersion: "v2",
      }),
    );
  });

  it.each(["useExternalFile", "keepStudioFile"] as const)(
    "%s cannot reload the next project after delayed recovery cleanup",
    async (action) => {
      const cleanup = deferred<void>();
      const conflict = new StudioFileConflictError({
        filePath: "index.html", currentVersion: "v2", currentContent: "external", attemptedContent: "studio",
      });
      const { captured, options, rerender } = await mountCoordinator({
        drainPendingChanges: async () => ({ status: "conflict", error: conflict }),
        deleteConflictSnapshot: vi.fn(() => cleanup.promise),
      });
      await act(async () => handler?.({ path: "index.html", version: "v2" }));
      let resolving!: Promise<void>;
      await act(async () => { resolving = captured.handle![action](); });
      expect(options.deleteConflictSnapshot).toHaveBeenCalledOnce();

      await rerender({ projectId: "project-b" });
      await act(async () => { cleanup.resolve(); await resolving; });

      expect(options.reloadPreview).not.toHaveBeenCalled();
      expect(options.reloadSdkSession).not.toHaveBeenCalled();
    },
  );

  it.each(["useExternalFile", "keepStudioFile"] as const)(
    "%s leaves a newer conflict and its durable recovery snapshot intact",
    async (action) => {
      const cleanup = deferred<void>();
      const conflict = (version: string) => new StudioFileConflictError({
        filePath: "index.html", currentVersion: version, currentContent: version, attemptedContent: "studio",
      });
      const initial = conflict("v2");
      const newer = conflict("v3");
      let stored: StudioFileConflictError | null = null;
      const { captured, options } = await mountCoordinator({
        drainPendingChanges: vi.fn().mockResolvedValueOnce({ status: "conflict", error: initial })
          .mockResolvedValueOnce({ status: "conflict", error: newer }),
        persistConflictSnapshot: async (_projectId, value) => { stored = value; },
        deleteConflictSnapshot: async () => { await cleanup.promise; stored = null; },
      });
      await act(async () => handler?.({ path: "index.html", version: "v2" }));
      let resolving!: Promise<void>;
      await act(async () => { resolving = captured.handle![action](); });
      let newerEvent: unknown;
      await act(async () => { newerEvent = handler?.({ path: "index.html", version: "v3" }); });
      await act(async () => { cleanup.resolve(); await resolving; await newerEvent; });

      expect(captured.handle?.blocked).toMatchObject({ status: "conflict", error: newer });
      expect(stored).toBe(newer);
      expect(options.reloadPreview).not.toHaveBeenCalled();
      expect(options.reloadSdkSession).not.toHaveBeenCalled();
    },
  );

  it("does not overwrite a recovered draft after its file read outlives the project", async () => {
    const read = deferred<string>();
    const { captured, options, rerender } = await mountCoordinator({
      loadConflictSnapshot: async () => ({
        kind: "failed", projectId: "project-a", filePath: "index.html", externalVersion: null,
        externalContent: null, studioContent: "recovered", failureMessage: "offline", createdAt: 100,
      }),
      readProjectFile: () => read.promise,
    });
    let resolving!: Promise<void>;
    await act(async () => { resolving = captured.handle!.keepStudioFile(); });
    await rerender({ projectId: "project-b", loadConflictSnapshot: undefined });
    await act(async () => { read.resolve("external"); await resolving; });

    expect(options.overwriteConflict).not.toHaveBeenCalled();
    expect(options.reloadPreview).not.toHaveBeenCalled();
  });
});
