import { describe, expect, it, vi } from "vitest";
import {
  createDesktopAppController,
  shouldQuitWhenAllWindowsClosed,
} from "../appLifecycle";

describe("desktop application lifecycle", () => {
  it("starts the loopback runtime before loading a window and shuts every resource down once", async () => {
    const events: string[] = [];
    const closeRuntime = vi.fn(async () => events.push("runtime:close"));
    const closeBrowser = vi.fn(async () => events.push("browser:close"));
    const destroyWindow = vi.fn(() => events.push("window:destroy"));
    const loadURL = vi.fn(async (url: string) => events.push(`window:${url}`));
    const controller = createDesktopAppController({
      startRuntime: vi.fn(async () => {
        events.push("runtime:start");
        return { origin: "http://127.0.0.1:43117", close: closeRuntime };
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
      "runtime:start",
      "renderer:prepare",
      "window:http://127.0.0.1:43117",
    ]);

    await Promise.all([controller.close(), controller.close()]);
    expect(destroyWindow).toHaveBeenCalledOnce();
    expect(closeRuntime).toHaveBeenCalledOnce();
    expect(closeBrowser).toHaveBeenCalledOnce();
    expect(events.indexOf("window:destroy")).toBeLessThan(events.indexOf("runtime:close"));
  });

  it("reopens a window on activation without starting a second runtime", async () => {
    const startRuntime = vi.fn(async () => ({
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
      startRuntime,
      prepareRenderer,
      createWindow,
      closeSharedBrowser: vi.fn(async () => {}),
    });

    await controller.start();
    controller.forgetWindow();
    await controller.activate();

    expect(startRuntime).toHaveBeenCalledOnce();
    expect(prepareRenderer).toHaveBeenCalledOnce();
    expect(createWindow).toHaveBeenCalledTimes(2);
  });

  it("cancels startup without leaking a late runtime or opening a window", async () => {
    let releaseRuntime!: (runtime: {
      origin: string;
      close(): Promise<void>;
    }) => void;
    const closeRuntime = vi.fn(async () => {});
    const startRuntime = vi.fn(
      () =>
        new Promise<{ origin: string; close(): Promise<void> }>((resolve) => {
          releaseRuntime = resolve;
        }),
    );
    const createWindow = vi.fn(() => ({
      loadURL: vi.fn(async () => {}),
      isDestroyed: () => false,
      destroy: vi.fn(),
    }));
    const closeBrowser = vi.fn(async () => {});
    const controller = createDesktopAppController({
      startRuntime,
      prepareRenderer: vi.fn(async () => {}),
      createWindow,
      closeSharedBrowser: closeBrowser,
    });

    const starting = controller.start();
    const closing = controller.close();
    releaseRuntime({ origin: "http://127.0.0.1:43117", close: closeRuntime });
    await Promise.all([starting, closing]);

    expect(createWindow).not.toHaveBeenCalled();
    expect(closeRuntime).toHaveBeenCalledOnce();
    expect(closeBrowser).toHaveBeenCalledOnce();
    expect(controller.origin()).toBeNull();
  });

  it("uses native macOS lifetime semantics", () => {
    expect(shouldQuitWhenAllWindowsClosed("darwin")).toBe(false);
    expect(shouldQuitWhenAllWindowsClosed("win32")).toBe(true);
    expect(shouldQuitWhenAllWindowsClosed("linux")).toBe(true);
  });
});
