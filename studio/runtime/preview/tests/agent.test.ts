// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installPreviewAgent } from "../agent";
import { PREVIEW_AGENT_CHANNEL, PREVIEW_AGENT_VERSION } from "../../../shared/preview/agentProtocol";

const origin = "mpvfx://editor";
const token = "channel-token-123456789";
const envelope = { channel: PREVIEW_AGENT_CHANNEL, version: PREVIEW_AGENT_VERSION };
let dispose: () => void;
let sent: ReturnType<typeof vi.spyOn>;

function deliver(data: unknown, from = origin, source: MessageEventSource = window): void {
  window.dispatchEvent(new MessageEvent("message", { data, origin: from, source }));
}
function init(): void {
  deliver({ ...envelope, type: "init", token });
}
function request(id: number, command: unknown): void {
  deliver({ ...envelope, type: "request", token, id, command });
}
function reply(): Record<string, unknown> {
  return sent.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

beforeEach(() => {
  document.body.innerHTML = '<div id="one" class="card" data-composition-file="scene.html" style="color: red">Hello</div>';
  sent = vi.spyOn(window, "postMessage").mockImplementation(() => undefined);
  dispose = installPreviewAgent(window, document, { parentOrigin: origin });
});
afterEach(() => {
  dispose();
  sent.mockRestore();
});

describe("preview agent message boundary", () => {
  it("requires the exact parent origin and frame source", () => {
    deliver({ ...envelope, type: "init", token }, "https://other.example");
    deliver({ ...envelope, type: "init", token }, origin, new MessageChannel().port1);
    expect(sent).not.toHaveBeenCalled();
    init();
    expect(reply()).toMatchObject({ type: "ready", token });
    expect(sent.mock.calls.at(-1)?.[1]).toBe(origin);
  });

  it("returns bounded metadata and stable handles, then invalidates them on re-init", () => {
    init();
    request(1, { kind: "snapshot", offset: 0, limit: 1 });
    const first = (reply().result as Record<string, unknown>[])[0];
    expect(first).toMatchObject({ handle: "e1", selector: "#one", sourceFile: "scene.html", text: "Hello" });
    request(2, { kind: "readElement", handle: "e1" });
    expect((reply().result as Record<string, unknown>).handle).toBe("e1");
    init();
    request(1, { kind: "readElement", handle: "e1" });
    expect(reply()).toMatchObject({ ok: false, error: "stale-handle" });
    request(2, { kind: "snapshot" });
    expect((reply().result as Record<string, unknown>[])[0].handle).toBe("e1");
  });

  it("only accepts allowlisted edits on issued handles", () => {
    init();
    request(1, { kind: "snapshot" });
    request(2, { kind: "setStyle", handle: "e1", property: "left", value: "10px" });
    expect(document.getElementById("one")?.style.left).toBe("10px");
    request(3, { kind: "setStyle", handle: "e1", property: "background-image", value: "url(https://example.test/x)" });
    expect(reply()).toMatchObject({ ok: false, error: "unsupported-action" });
    request(4, { kind: "setAttribute", handle: "e1", name: "onclick", value: "alert(1)" });
    expect(reply()).toMatchObject({ ok: false, error: "unsupported-action" });
    request(5, { kind: "fetch", url: "https://example.test" });
    expect(reply()).toMatchObject({ id: 4 });
    request(6, { kind: "setText", handle: "e1", text: "Updated" });
    expect(document.getElementById("one")?.textContent).toBe("Updated");
  });

  it("rejects stale request IDs, stale nodes, and unbounded payloads", () => {
    init();
    request(1, { kind: "snapshot" });
    const count = sent.mock.calls.length;
    request(1, { kind: "snapshot" });
    expect(sent).toHaveBeenCalledTimes(count);
    document.getElementById("one")?.remove();
    request(2, { kind: "readElement", handle: "e1" });
    expect(reply()).toMatchObject({ error: "stale-handle" });
    request(3, { kind: "snapshot", limit: 301 });
    expect(reply()).toMatchObject({ id: 2 });
  });
});
