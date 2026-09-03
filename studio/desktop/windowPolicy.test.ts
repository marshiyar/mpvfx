import { describe, expect, it, vi } from "vitest";
import { createWindowOptions, installWindowGuards } from "./windowPolicy";

describe("desktop window security policy", () => {
  it("runs the editor in an isolated sandbox without Node access", () => {
    const options = createWindowOptions();

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
    expect(options.webPreferences).not.toHaveProperty("preload");
  });

  it("denies popup windows and navigation outside the embedded loopback origin", () => {
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
    installWindowGuards(contents, "http://127.0.0.1:43117");

    expect(openHandler?.({ url: "https://example.com" })).toEqual({ action: "deny" });
    const allowed = { preventDefault: vi.fn() };
    handlers.get("will-navigate")?.(
      allowed,
      "http://127.0.0.1:43117/#project/MpVFX",
    );
    expect(allowed.preventDefault).not.toHaveBeenCalled();

    for (const target of ["https://example.com", "file:///tmp/editor.html", "javascript:alert(1)"]) {
      const blocked = { preventDefault: vi.fn() };
      handlers.get("will-navigate")?.(blocked, target);
      expect(blocked.preventDefault, target).toHaveBeenCalledOnce();
    }
  });
});
