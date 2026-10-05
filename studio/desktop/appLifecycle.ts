export interface DesktopRuntimeHandle {
  origin: string;
  close(): Promise<void>;
}

export interface DesktopWindowHandle {
  loadURL(url: string): Promise<unknown>;
  isDestroyed(): boolean;
  destroy(): void;
}

export interface DesktopAppController {
  start(): Promise<void>;
  activate(): Promise<void>;
  forgetWindow(): void;
  close(): Promise<void>;
  origin(): string | null;
}

interface DesktopAppDependencies {
  startRuntime(): Promise<DesktopRuntimeHandle>;
  prepareRenderer(): Promise<void>;
  createWindow(): DesktopWindowHandle;
  closeSharedBrowser(): Promise<void>;
  flushRenderer?(): Promise<void>;
}

export function shouldQuitWhenAllWindowsClosed(platform: NodeJS.Platform): boolean {
  return platform !== "darwin";
}

/** Owns the one runtime and current window; Electron event wiring lives in main.ts. */
export function createDesktopAppController(
  dependencies: DesktopAppDependencies,
): DesktopAppController {
  let runtime: DesktopRuntimeHandle | null = null;
  let window: DesktopWindowHandle | null = null;
  let startPromise: Promise<void> | null = null;
  let closePromise: Promise<void> | null = null;
  let rendererPreparePromise: Promise<void> | null = null;
  let rendererPrepared = false;
  let stopping = false;

  const prepareRenderer = async () => {
    if (rendererPrepared) return;
    if (rendererPreparePromise) return rendererPreparePromise;
    const pending = dependencies.prepareRenderer();
    rendererPreparePromise = pending;
    try {
      await pending;
      rendererPrepared = true;
    } finally {
      if (rendererPreparePromise === pending) rendererPreparePromise = null;
    }
  };

  const openWindow = async () => {
    if (stopping) return;
    if (!runtime) throw new Error("Desktop runtime is not running");
    await prepareRenderer();
    if (stopping) return;
    const nextWindow = dependencies.createWindow();
    if (stopping) {
      nextWindow.destroy();
      return;
    }
    window = nextWindow;
    await nextWindow.loadURL(runtime.origin);
    if (stopping && !nextWindow.isDestroyed()) nextWindow.destroy();
  };

  const start = async () => {
    if (stopping) return;
    if (runtime && window && !window.isDestroyed()) return;
    if (startPromise) return startPromise;
    const pending = (async () => {
      if (!runtime) {
        const startedRuntime = await dependencies.startRuntime();
        if (stopping) {
          await startedRuntime.close();
          return;
        }
        runtime = startedRuntime;
      }
      try {
        if (!window || window.isDestroyed()) await openWindow();
      } catch (error) {
        const partiallyStarted = runtime;
        runtime = null;
        await partiallyStarted?.close();
        throw error;
      }
    })();
    startPromise = pending;
    try {
      await pending;
    } finally {
      if (startPromise === pending) startPromise = null;
    }
  };

  return {
    start,
    async activate() {
      if (stopping) return;
      if (!runtime) await start();
      else if (!window || window.isDestroyed()) await openWindow();
    },
    forgetWindow() {
      window = null;
    },
    async close() {
      if (closePromise) return closePromise;
      // Close must claim the lifetime before yielding to a pending startup.
      // Otherwise startRuntime can resolve while close waits and open a window
      // that teardown did not intend to show.
      stopping = true;
      const pending = (async () => {
        await startPromise?.catch(() => {});
        await dependencies.flushRenderer?.();
        let windowCloseError: unknown;
        const destroyActiveWindow = () => {
          const activeWindow = window;
          window = null;
          if (activeWindow && !activeWindow.isDestroyed()) activeWindow.destroy();
        };
        try {
          destroyActiveWindow();
        } catch (error) {
          windowCloseError = error;
        }
        await startPromise?.catch(() => {});
        const activeRuntime = runtime;
        runtime = null;
        try {
          destroyActiveWindow();
        } catch (error) {
          windowCloseError ??= error;
        }
        const results = await Promise.allSettled([
          activeRuntime?.close() ?? Promise.resolve(),
          dependencies.closeSharedBrowser(),
        ]);
        if (windowCloseError) throw windowCloseError;
        const rejected = results.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (rejected) throw rejected.reason;
      })();
      closePromise = pending;
      try { return await pending; }
      catch (error) {
        closePromise = null;
        if (runtime) stopping = false;
        throw error;
      }
    },
    origin() {
      return runtime?.origin ?? null;
    },
  };
}
