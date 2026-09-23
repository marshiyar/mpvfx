import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopBridge, DesktopEvent, DesktopRequest, DesktopResponse } from "../../../shared/desktopBridge";

vi.unmock("../desktopClient");
import { desktopRequest, DesktopEvents } from "../desktopClient";

const reply: DesktopResponse = {
  status: 200, statusText: "OK", headers: [["content-type", "application/json"]],
  body: new TextEncoder().encode('{"ok":true}').buffer,
};
let bridge: DesktopBridge;
beforeEach(() => {
  bridge = { request: vi.fn(async () => reply), cancel: vi.fn(), subscribe: vi.fn(() => () => {}) };
  vi.stubGlobal("window", { mpvfx: bridge });
});
afterEach(() => vi.unstubAllGlobals());

describe("desktop command transport", () => {
  it("preserves method, query, headers, body and response status through IPC", async () => {
    const response = await desktopRequest("/api/projects/MpVFX/files/a.html?optional=1", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: '{"content":"new"}',
    });
    const request = vi.mocked(bridge.request).mock.calls[0][0];
    expect(request).toMatchObject({ path: "/api/projects/MpVFX/files/a.html?optional=1", method: "PUT" });
    expect(new TextDecoder().decode(request.body)).toBe('{"content":"new"}');
    expect(await response.json()).toEqual({ ok: true });
  });

  it("serializes file uploads with the matching multipart boundary", async () => {
    const body = new FormData();
    body.append("files", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "image.png");
    await desktopRequest("/api/projects/MpVFX/upload", { method: "POST", body });
    const request = vi.mocked(bridge.request).mock.calls[0][0];
    const decoded = await new Request("https://test.invalid", {
      method: request.method, headers: request.headers, body: request.body,
    }).formData();
    const file = decoded.get("files") as File;
    expect(file.name).toBe("image.png");
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it("rejects external and non-command targets before crossing the bridge", async () => {
    for (const target of ["https://example.com/api/projects", "file:///api/projects", "/index.html"]) {
      await expect(desktopRequest(target)).rejects.toThrow("local /api/");
    }
    expect(bridge.request).not.toHaveBeenCalled();
  });

  it("forwards cancellation and does not publish an aborted response", async () => {
    const controller = new AbortController();
    let resolve!: (value: DesktopResponse) => void;
    bridge.request = vi.fn(() => new Promise<DesktopResponse>((done) => { resolve = done; }));
    const result = desktopRequest("/api/projects", { signal: controller.signal });
    const rejected = expect(result).rejects.toThrow();
    controller.abort();
    await rejected;
    resolve(reply);
    expect(bridge.cancel).toHaveBeenCalledWith((vi.mocked(bridge.request).mock.calls[0][0] as DesktopRequest).id);
  });

  it("handles bodyless responses", async () => {
    vi.mocked(bridge.request).mockResolvedValue({ ...reply, status: 204, body: null });
    expect((await desktopRequest("/api/projects")).status).toBe(204);
  });

  it("delivers progress and releases the subscription on close", () => {
    let publish!: (event: DesktopEvent) => void;
    const stop = vi.fn();
    bridge.subscribe = vi.fn((_path, callback) => { publish = callback; return stop; });
    const events = new DesktopEvents("/api/render/job/progress");
    const listener = vi.fn();
    events.addEventListener("progress", listener);
    publish({ type: "progress", data: '{"progress":50}' });
    expect(listener.mock.calls[0][0].data).toBe('{"progress":50}');
    events.close();
    publish({ type: "progress", data: "late" });
    expect(listener).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });
});
