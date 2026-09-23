import { describe, expect, it, vi } from "vitest";
import { createWindowOptions, installWindowGuards, isEditorFullscreenRequest } from "../windowPolicy";

describe("desktop window security policy", () => {
  it("allows fullscreen only for the editor's own document", () => {
    const main = { isMainFrame: true, requestingUrl: "mpvfx://editor/#project/Demo" };
    expect(isEditorFullscreenRequest("fullscreen", main, "mpvfx://editor")).toBe(true);
    expect(isEditorFullscreenRequest("fullscreen", main, undefined)).toBe(false);
    expect(isEditorFullscreenRequest("fullscreen", { ...main, isMainFrame: false }, "mpvfx://editor")).toBe(false);
    for (const permission of ["automatic-fullscreen", "media", "clipboard-read", "display-capture", "fileSystem"]) {
      expect(isEditorFullscreenRequest(permission, main, "mpvfx://editor")).toBe(false);
    }
    for (const requestingUrl of [undefined, "https://example.com", "mpvfx://other/", "mpvfx://editor/api/projects/Demo/preview"]) {
      expect(isEditorFullscreenRequest("fullscreen", { isMainFrame: true, requestingUrl }, "mpvfx://editor")).toBe(false);
    }
  });

  it("runs the editor in an isolated sandbox without Node access", () => {
    const options = createWindowOptions("/app/preload.cjs");

    expect(options).toMatchObject({
      show: false,
      backgroundColor: "#0a0a0a",
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        v8CacheOptions: "none",
      },
    });
    expect(options.webPreferences.preload).toBe("/app/preload.cjs");
  });

  it("denies popup windows and navigation outside the editor document", () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    let openHandler: ((details: { url: string }) => { action: "allow" | "deny" }) | undefined;
    const contents = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler);
      }),
      setWindowOpenHandler: vi.fn(
        (handler: (details: { url: string }) => { action: "allow" | "deny" }) => {
          openHandler = handler;
        },
      ),
    };
    installWindowGuards(contents, "mpvfx://editor");

    expect(openHandler?.({ url: "https://example.com" })).toEqual({ action: "deny" });
    const allowed = { preventDefault: vi.fn() };
    handlers.get("will-navigate")?.(
      allowed,
      "mpvfx://editor/#project/MpVFX",
    );
    expect(allowed.preventDefault).not.toHaveBeenCalled();

    for (const target of ["https://example.com", "file:///tmp/editor.html", "javascript:alert(1)", "mpvfx://other/", "mpvfx://editor/index.html", "mpvfx://editor/api/projects/MpVFX/preview"]) {
      const blocked = { preventDefault: vi.fn() };
      handlers.get("will-navigate")?.(blocked, target);
      expect(blocked.preventDefault, target).toHaveBeenCalledOnce();
    }
  });
});
