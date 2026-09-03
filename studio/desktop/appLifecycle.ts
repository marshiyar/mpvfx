export interface DesktopServerHandle {
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
  startServer(): Promise<DesktopServerHandle>;
  prepareRenderer(): Promise<void>;
  createWindow(): DesktopWindowHandle;
  closeSharedBrowser(): Promise<void>;
}

export function shouldQuitWhenAllWindowsClosed(platform: NodeJS.Platform): boolean {
  return platform !== "darwin";
}

/** Owns the one server and current window; Electron event wiring lives in main.ts. */
export function createDesktopAppController(
  dependencies: DesktopAppDependencies,
): DesktopAppController {
  let server: DesktopServerHandle | null = null;
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
    if (!server) throw new Error("Desktop server is not running");
    await prepareRenderer();
    if (stopping) return;
    const nextWindow = dependencies.createWindow();
    if (stopping) {
      nextWindow.destroy();
      return;
    }
    window = nextWindow;
    await nextWindow.loadURL(server.origin);
    if (stopping && !nextWindow.isDestroyed()) nextWindow.destroy();
  };

  const start = async () => {
    if (stopping) return;
    if (server && window && !window.isDestroyed()) return;
    if (startPromise) return startPromise;
    const pending = (async () => {
      if (!server) {
        const startedServer = await dependencies.startServer();
        if (stopping) {
          await startedServer.close();
          return;
        }
        server = startedServer;
      }
      try {
        if (!window || window.isDestroyed()) await openWindow();
      } catch (error) {
        const partiallyStarted = server;
        server = null;
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
      if (!server) await start();
      else if (!window || window.isDestroyed()) await openWindow();
    },
    forgetWindow() {
      window = null;
    },
    async close() {
      if (closePromise) return closePromise;
      stopping = true;
      const pending = (async () => {
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
        const activeServer = server;
        server = null;
        try {
          destroyActiveWindow();
        } catch (error) {
          windowCloseError ??= error;
        }
        const results = await Promise.allSettled([
          activeServer?.close() ?? Promise.resolve(),
          dependencies.closeSharedBrowser(),
        ]);
        if (windowCloseError) throw windowCloseError;
        const rejected = results.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (rejected) throw rejected.reason;
      })();
      closePromise = pending;
      return pending;
    },
    origin() {
      return server?.origin ?? null;
    },
  };
}
