import { describe, expect, it, vi } from "vitest";
import {
  createDesktopAppController,
  shouldQuitWhenAllWindowsClosed,
} from "./appLifecycle";

describe("desktop application lifecycle", () => {
  it("starts the loopback server before loading a window and shuts every resource down once", async () => {
    const events: string[] = [];
    const closeServer = vi.fn(async () => events.push("server:close"));
    const closeBrowser = vi.fn(async () => events.push("browser:close"));
    const destroyWindow = vi.fn(() => events.push("window:destroy"));
    const loadURL = vi.fn(async (url: string) => events.push(`window:${url}`));
    const controller = createDesktopAppController({
      startServer: vi.fn(async () => {
        events.push("server:start");
        return { origin: "http://127.0.0.1:43117", close: closeServer };
      }),
      prepareRenderer: vi.fn(async () => events.push("renderer:prepare")),
      createWindow: vi.fn(() => ({
        loadURL,
        isDestroyed: () => false,
        destroy: destroyWindow,
      })),
      closeSharedBrowser: closeBrowser,
    });

    await controller.start();
    expect(events.slice(0, 3)).toEqual([
      "server:start",
      "renderer:prepare",
      "window:http://127.0.0.1:43117",
    ]);

    await Promise.all([controller.close(), controller.close()]);
    expect(destroyWindow).toHaveBeenCalledOnce();
    expect(closeServer).toHaveBeenCalledOnce();
    expect(closeBrowser).toHaveBeenCalledOnce();
    expect(events.indexOf("window:destroy")).toBeLessThan(events.indexOf("server:close"));
  });

  it("reopens a window on activation without starting a second server", async () => {
    const startServer = vi.fn(async () => ({
      origin: "http://127.0.0.1:43117",
      close: vi.fn(async () => {}),
    }));
    const createWindow = vi.fn(() => ({
      loadURL: vi.fn(async () => {}),
      isDestroyed: () => false,
      destroy: vi.fn(),
    }));
    const prepareRenderer = vi.fn(async () => {});
    const controller = createDesktopAppController({
      startServer,
      prepareRenderer,
      createWindow,
      closeSharedBrowser: vi.fn(async () => {}),
    });

    await controller.start();
    controller.forgetWindow();
    await controller.activate();

    expect(startServer).toHaveBeenCalledOnce();
    expect(prepareRenderer).toHaveBeenCalledOnce();
    expect(createWindow).toHaveBeenCalledTimes(2);
  });

  it("cancels startup without leaking a late server or opening a window", async () => {
    let releaseServer!: (server: {
      origin: string;
      close(): Promise<void>;
    }) => void;
    const closeServer = vi.fn(async () => {});
    const startServer = vi.fn(
      () =>
        new Promise<{ origin: string; close(): Promise<void> }>((resolve) => {
          releaseServer = resolve;
        }),
    );
    const createWindow = vi.fn(() => ({
      loadURL: vi.fn(async () => {}),
      isDestroyed: () => false,
      destroy: vi.fn(),
    }));
    const closeBrowser = vi.fn(async () => {});
    const controller = createDesktopAppController({
      startServer,
      prepareRenderer: vi.fn(async () => {}),
      createWindow,
      closeSharedBrowser: closeBrowser,
    });

    const starting = controller.start();
    const closing = controller.close();
    releaseServer({ origin: "http://127.0.0.1:43117", close: closeServer });
    await Promise.all([starting, closing]);

    expect(createWindow).not.toHaveBeenCalled();
    expect(closeServer).toHaveBeenCalledOnce();
    expect(closeBrowser).toHaveBeenCalledOnce();
    expect(controller.origin()).toBeNull();
  });

  it("uses native macOS lifetime semantics", () => {
    expect(shouldQuitWhenAllWindowsClosed("darwin")).toBe(false);
    expect(shouldQuitWhenAllWindowsClosed("win32")).toBe(true);
    expect(shouldQuitWhenAllWindowsClosed("linux")).toBe(true);
  });
});
