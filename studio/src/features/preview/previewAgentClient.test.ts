// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewAgentClient, clientPointToPreview, isPreviewElementState, previewRectToClient } from "./previewAgentClient";

const clients: PreviewAgentClient[] = [];
const frames: HTMLIFrameElement[] = [];

afterEach(() => {
  clients.splice(0).forEach(client => client.dispose());
  frames.splice(0).forEach(frame => frame.remove());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function setup() {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  Object.defineProperty(frame, "src", { configurable: true, value: "mpvfx://616263.preview/api/projects/abc/preview" });
  frames.push(frame);
  const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
  const client = new PreviewAgentClient(frame);
  clients.push(client);
  client.connect();
  const init = post.mock.calls[0]![0] as { token: string };
  const send = (data: unknown, origin = "mpvfx://616263.preview", source: Window | null = frame.contentWindow) => {
    window.dispatchEvent(new MessageEvent("message", { data, origin, source }));
  };
  const ready = () => send({ channel: "mpvfx.preview-agent", version: 1, type: "ready", token: init.token });
  return { client, frame, post, init, send, ready };
}

describe("PreviewAgentClient", () => {
  it("accepts a bounded full color grade without widening ordinary metadata", () => {
    const element = {
      handle: "e1", tag: "img", id: "grade", className: "", text: "",
      textEditable: false, rect: { x: 0, y: 0, width: 10, height: 10 }, visible: true, parent: null,
      sourceFile: "index.html", compositionPath: "index.html",
      dataAttributes: { "color-grading": "x".repeat(2048) }, inlineStyles: {}, computedStyles: {},
    };
    expect(isPreviewElementState(element)).toBe(true);
    expect(isPreviewElementState({ ...element, dataAttributes: { title: "x".repeat(513) } })).toBe(false);
    expect(isPreviewElementState({ ...element, dataAttributes: { "color-grading": "x".repeat(4097) } })).toBe(false);
  });

  it("retries a warm-frame init until the runtime listener responds", () => {
    vi.useFakeTimers();
    const { client, post, ready } = setup();
    expect(post).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);
    expect(post).toHaveBeenCalledTimes(3);
    ready();
    expect(client.isReady).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("maps hit tests and overlay boxes through the scaled frame", () => {
    const frame = document.createElement("iframe");
    Object.defineProperty(frame, "clientWidth", { value: 200 });
    Object.defineProperty(frame, "clientHeight", { value: 100 });
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue({
      left: 10, top: 20, right: 410, bottom: 220, width: 400, height: 200,
    } as DOMRect);
    expect(clientPointToPreview(frame, 210, 120)).toEqual({ x: 100, y: 50 });
    expect(clientPointToPreview(frame, 500, 120)).toBeNull();
    expect(previewRectToClient(frame, { x: 25, y: 10, width: 50, height: 20 })).toEqual({
      x: 60, y: 40, width: 100, height: 40,
    });
  });

  it("requires the active frame, expected origin, token and matching request id", async () => {
    const { client, frame, post, init, send, ready } = setup();
    send({ channel: "mpvfx.preview-agent", version: 1, type: "ready", token: init.token }, "mpvfx://editor");
    expect(client.isReady).toBe(false);
    send({ channel: "mpvfx.preview-agent", version: 1, type: "ready", token: init.token }, "mpvfx://616263.preview", window);
    expect(client.isReady).toBe(false);
    ready();
    expect(client.isReady).toBe(true);

    const result = client.request({ kind: "hitTest", x: 5, y: 9 });
    const request = post.mock.calls[1]![0] as { id: number; token: string };
    const element = {
      handle: "e1", tag: "DIV", id: "heading", className: "title", text: "Hello",
      textEditable: true, rect: { x: 1, y: 2, width: 30, height: 40 }, visible: true, parent: null,
      sourceFile: "index.html", compositionPath: "index.html",
      dataAttributes: {}, inlineStyles: {}, computedStyles: {},
    };
    const reply = { channel: "mpvfx.preview-agent", version: 1, type: "reply", token: request.token, id: request.id, ok: true, result: element };
    send({ ...reply, id: request.id + 1 });
    send({ ...reply, token: "wrong-token-long-enough" });
    send(reply, "mpvfx://editor");
    expect(await Promise.race([result.then(() => "settled"), Promise.resolve("pending")])).toBe("pending");
    send(reply);
    expect(await result).toEqual(element);
    expect(frame.contentWindow).toBeTruthy();
  });

  it("rejects malformed element data and revokes requests on navigation", async () => {
    const { client, post, send, ready, frame } = setup();
    ready();
    const bad = client.request({ kind: "readElement", handle: "e1" });
    const request = post.mock.calls[1]![0] as { token: string; id: number };
    send({ channel: "mpvfx.preview-agent", version: 1, type: "reply", token: request.token, id: request.id, ok: true, result: { handle: "e1", rect: { x: "NaN" } } });
    await expect(bad).rejects.toThrow("Invalid preview agent reply");

    const pending = client.request({ kind: "snapshot" });
    frame.dispatchEvent(new Event("load"));
    await expect(pending).rejects.toThrow("Preview navigated");
    expect(client.isReady).toBe(false);
    await expect(client.request({ kind: "snapshot" })).rejects.toThrow("not ready");
  });

  it("accepts bounded GSAP replies only for the active request and frame", async () => {
    const { client, post, send, ready } = setup();
    ready();
    const result = client.observeGsap("e1", ["x"], "main");
    const request = post.mock.calls[1]![0] as { token: string; id: number; command: unknown };
    expect(request.command).toEqual({ kind: "readGsap", handle: "e1", channels: ["x"], compositionId: "main" });
    const observed = { handle: "e1", id: "one", hfId: "hf-one", sourceFile: "scene.html",
      compositionPath: "scene.html", values: { x: 25 }, tweens: [] };
    send({ channel: "mpvfx.preview-agent", version: 1, type: "reply", token: request.token,
      id: request.id, ok: true, result: observed });
    expect(await result).toEqual(observed);

    const bad = client.observeGsap("e1", ["x"]);
    const second = post.mock.calls[2]![0] as { token: string; id: number };
    send({ channel: "mpvfx.preview-agent", version: 1, type: "reply", token: second.token,
      id: second.id, ok: true, result: { ...observed, values: { opacity: 1 } } });
    await expect(bad).rejects.toThrow("Invalid preview agent reply");
  });

  it("forwards only active-frame transport keys", () => {
    const { client, init, send, ready } = setup();
    const observed = vi.fn();
    client.onTransportKey(observed);
    const key = { channel: "mpvfx.preview-agent", version: 1, type: "transport-key",
      token: init.token, phase: "down", key: "j", shiftKey: false, repeat: false };
    send(key);
    expect(observed).not.toHaveBeenCalled();
    ready();
    send(key, "mpvfx://editor");
    send(key, "mpvfx://616263.preview", window);
    send({ ...key, key: "Delete" });
    send({ ...key, repeat: "yes" });
    expect(observed).not.toHaveBeenCalled();
    send(key);
    send({ ...key, phase: "up", repeat: true });
    expect(observed.mock.calls.map(([value]) => value)).toEqual([
      { phase: "down", key: "j", shiftKey: false, repeat: false },
      { phase: "up", key: "j", shiftKey: false, repeat: true },
    ]);
  });
});
