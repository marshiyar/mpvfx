// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installPreviewAgent } from "./agent";
import { PREVIEW_AGENT_CHANNEL, PREVIEW_AGENT_VERSION } from "../../../shared/preview/agentProtocol";
import { isPreviewElementState } from "./previewAgentClient";
import { installVkfEngine, uninstallVkfEngine, vkfEngine, vkfEngineInstalled, type VkfEngine } from "../../../shared/engine/vkfEngine";

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
    expect(first).toMatchObject({ handle: "e1", selector: "#one", sourceFile: "index.html", text: "Hello" });
    request(2, { kind: "readElement", handle: "e1" });
    expect((reply().result as Record<string, unknown>).handle).toBe("e1");
    init();
    request(1, { kind: "readElement", handle: "e1" });
    expect(reply()).toMatchObject({ ok: false, error: "stale-handle" });
    request(2, { kind: "snapshot" });
    expect((reply().result as Record<string, unknown>[])[0].handle).toBe("e1");
  });

  it("emits snapshots accepted by the editor client for a legacy composition", () => {
    document.body.innerHTML = '<main data-composition-id="main" data-duration="4"><div id="attack-clip" data-hf-id="hf-attack" data-start="0" data-duration="4" style="position:absolute;left:80px;top:80px;width:200px;height:100px">Preview fixture</div></main>';
    init();
    request(1, { kind: "snapshot", offset: 0, limit: 300 });
    const states = reply().result as unknown[];
    expect(states.map(state => isPreviewElementState(state))).toEqual([true, true]);
  });

  it("reports a composition host in its parent file and expanded children in its own file", () => {
    document.body.innerHTML = '<main data-composition-id="main"><div id="scene" data-composition-file="compositions/scene.html"><div id="title-card">Title</div></div></main>';
    init();
    request(1, { kind: "snapshot", limit: 300 });
    const states = reply().result as Array<{ id: string; sourceFile: string }>;
    expect(states.find(state => state.id === "scene")?.sourceFile).toBe("index.html");
    expect(states.find(state => state.id === "title-card")?.sourceFile).toBe("compositions/scene.html");
  });

  it("observes bounded authored appearance styles without exposing new write properties", () => {
    const element = document.getElementById("one") as HTMLElement;
    element.style.borderColor = "rgb(10, 20, 30)";
    element.style.boxShadow = "0 1px 2px black";
    element.style.objectFit = "cover";
    element.style.textTransform = "uppercase";
    init();
    request(1, { kind: "snapshot", limit: 1 });
    expect((reply().result as Array<Record<string, unknown>>)[0]).toMatchObject({ inlineStyles: {
      "border-color": "rgb(10, 20, 30)", "box-shadow": "0 1px 2px black",
      "object-fit": "cover", "text-transform": "uppercase",
    } });
    request(2, { kind: "setStyle", handle: "e1", property: "background-image", value: "url(https://example.test/x)" });
    expect(reply()).toMatchObject({ ok: false, error: "unsupported-action" });
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
    request(7, { kind: "setStyle", handle: "e1", property: "clip-path", value: "inset(1px 2px 3px 4px)" });
    expect((document.getElementById("one") as HTMLElement).style.clipPath).toBe("inset(1px 2px 3px 4px)");
    request(8, { kind: "setStyle", handle: "e1", property: "clip-path", value: "path('M0 0')" });
    expect(reply()).toMatchObject({ ok: false, error: "unsupported-action" });
  });

  it("previews only bounded attributes on one exact audio bus", () => {
    document.body.innerHTML = '<hf-audio-group id="voice"></hf-audio-group>';
    init();
    request(1, { kind: "previewAudioGroup", groupId: "voice", attribute: "data-volume", value: "0.5" });
    expect(reply()).toMatchObject({ ok: true, result: null });
    expect(document.getElementById("voice")?.getAttribute("data-volume")).toBe("0.5");
    request(2, { kind: "previewAudioGroup", groupId: "voice", attribute: "data-hidden", value: "" });
    expect(document.getElementById("voice")?.hasAttribute("data-hidden")).toBe(true);
    request(3, { kind: "previewAudioGroup", groupId: "voice", attribute: "data-hidden", value: null });
    expect(document.getElementById("voice")?.hasAttribute("data-hidden")).toBe(false);
    request(4, { kind: "previewAudioGroup", groupId: "voice", attribute: "data-fx-chain",
      value: '{"version":1,"nodes":[]}' });
    expect(reply()).toMatchObject({ ok: true, result: null });
    request(5, { kind: "previewAudioGroup", groupId: "voice", attribute: "data-fx-chain",
      value: '{"version":1,"nodes":[{"type":"unknown"}]}' });
    expect(reply()).toMatchObject({ ok: false, error: "unsupported-action" });
    request(6, { kind: "previewAudioGroup", groupId: "voice", attribute: "data-volume", value: "100" });
    expect(reply()).toMatchObject({ id: 5 });
    request(7, { kind: "previewAudioGroup", groupId: "voice", attribute: "onclick", value: "alert(1)" });
    expect(reply()).toMatchObject({ id: 5 });
    document.body.innerHTML += '<hf-audio-group id="voice"></hf-audio-group>';
    request(8, { kind: "previewAudioGroup", groupId: "voice", attribute: "data-volume", value: "0.2" });
    expect(reply()).toMatchObject({ ok: false, error: "unsupported-action" });
  });

  it("scrubs only one exact audio element briefly and restores its media state", () => {
    document.body.innerHTML = '<audio id="music"></audio>';
    const audio = document.getElementById("music") as HTMLAudioElement;
    audio.muted = true;
    audio.volume = 0.8;
    const play = vi.spyOn(audio, "play").mockResolvedValue(undefined);
    const pause = vi.spyOn(audio, "pause").mockImplementation(() => undefined);
    init();
    request(1, { kind: "scrubAudio", audioId: "music", timeSeconds: 2, volume: 0.8 });
    expect(reply()).toMatchObject({ ok: true, result: null });
    expect(audio.currentTime).toBe(2);
    expect(audio.muted).toBe(false);
    expect(audio.volume).toBeCloseTo(0.2);
    expect(play).toHaveBeenCalledOnce();
    request(2, { kind: "scrubAudio", audioId: "music", timeSeconds: null, volume: 0 });
    expect(pause).toHaveBeenCalledOnce();
    expect(audio.muted).toBe(true);
    expect(audio.volume).toBe(0.8);
    request(3, { kind: "scrubAudio", audioId: "missing", timeSeconds: 1, volume: 1 });
    expect(reply()).toMatchObject({ ok: false, error: "unsupported-action" });
    request(4, { kind: "scrubAudio", audioId: "music", timeSeconds: -1, volume: 1 });
    expect(reply()).toMatchObject({ id: 3 });
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

  it("installs a parsed native frame evaluator without granting a DOM bridge", () => {
    document.body.innerHTML = '<main data-composition-id="main" data-duration="4"><div id="one" data-hf-id="hf-one" style="position:absolute;left:10px;top:10px;width:20px;height:20px"></div></main>';
    init();
    const project = {
      schemaVersion: 1, id: "project:test", revision: 1,
      frameRate: { numerator: 30, denominator: 1 },
      canvas: { width: 640, height: 360, background: "#fff" },
      assets: [{ id: "asset:one", kind: "element", name: "One", durationFrames: 120 }],
      sequence: { id: "sequence:main", name: "Main", tracks: [{ id: "track:one", kind: "mixed",
        clips: [{ id: "clip:one", assetId: "asset:one", binding: { sourceFile: "index.html", domId: "one", hfId: "hf-one" },
          startFrame: 0, durationFrames: 120, sourceInFrame: 0, effects: [], parameterTracks: [],
          staticParameters: { "transform.position.x": 25 } }] }] },
    };
    request(1, { kind: "installNativeProject", project, bakedTracks: [], activeSourceFile: "index.html", timeSeconds: 0, playing: false });
    expect(reply()).toMatchObject({ ok: true, result: null });
    expect(document.getElementById("one")?.getAttribute("data-studio-clip-id")).toBe("clip:one");
    expect((document.getElementById("one") as HTMLElement).style.transform).toContain("25px");
    request(2, { kind: "installNativeProject", project: { ...project, revision: -1 }, bakedTracks: [], activeSourceFile: "index.html", timeSeconds: 0, playing: false });
    expect(reply()).toMatchObject({ ok: false, error: "invalid-request" });
  });

  it("installs bounded baked C++ samples for an animated native clip", () => {
    document.body.innerHTML = '<main data-composition-id="main" data-duration="4"><div id="one" data-hf-id="hf-one" style="width:20px;height:20px"></div></main>';
    init();
    const project = {
      schemaVersion: 1, id: "project:test", revision: 1,
      frameRate: { numerator: 30, denominator: 1 },
      canvas: { width: 640, height: 360, background: "#fff" },
      assets: [{ id: "asset:one", kind: "element", name: "One", durationFrames: 120 }],
      sequence: { id: "sequence:main", name: "Main", tracks: [{ id: "track:one", kind: "mixed",
        clips: [{ id: "clip:one", assetId: "asset:one", binding: { sourceFile: "index.html", domId: "one", hfId: "hf-one" },
          startFrame: 0, durationFrames: 120, sourceInFrame: 0, effects: [], parameterTracks: [{
            schemaVersion: 1, id: "track:opacity", parameterId: "transform.opacity", valueType: "number",
            frameRate: { numerator: 30, denominator: 1 },
            keyframes: [
              { id: "opacity:start", frame: 0, value: 1, outgoing: { type: "linear" } },
              { id: "opacity:end", frame: 90, value: 0.4, outgoing: { type: "linear" } },
            ],
          }] }] }] },
    };
    const bakedTracks = [{ clipId: "clip:one", trackId: "track:opacity", valueType: "number", samples: Array.from({ length: 120 }, (_, frame) => 1 - 0.6 * Math.min(frame, 90) / 90) }];
    request(1, { kind: "installNativeProject", project, bakedTracks, activeSourceFile: "index.html", timeSeconds: 2, playing: false });
    expect(reply()).toMatchObject({ ok: true, result: null });
    expect(Number.parseFloat((document.getElementById("one") as HTMLElement).style.opacity)).toBeCloseTo(0.6);
  });

  it("reads only allowlisted GSAP numbers for an issued handle", () => {
    const element = document.getElementById("one")!;
    const tween = {
      targets: () => [element], startTime: () => 1, duration: () => 2,
      vars: { id: "move", x: 40, opacity: 0.5, keyframes: [{ x: 10 }, { x: 40 }] },
    };
    const runtime = window as Window & { gsap?: unknown; __timelines?: unknown };
    runtime.gsap = { getProperty: (_target: Element, property: string) => property === "x" ? 25 : 0.5 };
    runtime.__timelines = { main: { time: () => 1.5, getChildren: () => [tween] } };
    try {
      init();
      request(1, { kind: "snapshot", limit: 1 });
      request(2, { kind: "readGsap", handle: "e1", channels: ["x", "opacity"], compositionId: "main" });
      expect(reply()).toMatchObject({ ok: true, result: {
        handle: "e1", id: "one", sourceFile: "index.html", values: { x: 25, opacity: 0.5 },
        tweens: [{ timelineId: "main", animationId: "move", targetIndex: 0,
          properties: { x: 40, opacity: 0.5 }, complete: true }],
      } });
      request(3, { kind: "readGsap", handle: "e1", channels: ["onclick"] });
      expect(reply()).toMatchObject({ id: 2 });
      element.remove();
      request(4, { kind: "readGsap", handle: "e1", channels: ["x"] });
      expect(reply()).toMatchObject({ ok: false, error: "stale-handle" });
    } finally {
      delete runtime.gsap;
      delete runtime.__timelines;
    }
  });

  it("restores the preexisting engine after a rejected baked install", () => {
    const original = { version: "sentinel" } as VkfEngine;
    const prior = vkfEngineInstalled() ? vkfEngine() : null;
    installVkfEngine(original);
    try {
      init();
      request(1, { kind: "installNativeProject", project: { invalid: true }, bakedTracks: [],
        activeSourceFile: "index.html", timeSeconds: 0, playing: false });
      expect(reply()).toMatchObject({ ok: false, error: "invalid-request" });
      expect(vkfEngine()).toBe(original);
    } finally {
      if (prior) installVkfEngine(prior);
      else uninstallVkfEngine();
    }
  });

  it("restores an absent engine after a rejected baked install", () => {
    const prior = vkfEngineInstalled() ? vkfEngine() : null;
    uninstallVkfEngine();
    try {
      init();
      request(1, { kind: "installNativeProject", project: { invalid: true }, bakedTracks: [],
        activeSourceFile: "index.html", timeSeconds: 0, playing: false });
      expect(reply()).toMatchObject({ ok: false, error: "invalid-request" });
      expect(vkfEngineInstalled()).toBe(false);
    } finally {
      if (prior) installVkfEngine(prior);
    }
  });

  it("emits only bounded transport keys after exact-origin handshake", () => {
    document.body.innerHTML += '<input id="entry">';
    const press = (target: Element, type: "keydown" | "keyup", key: string, modifiers = {}) => {
      const event = new KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...modifiers });
      target.dispatchEvent(event);
      return event;
    };
    expect(press(document.body, "keydown", "j").defaultPrevented).toBe(false);
    expect(sent).not.toHaveBeenCalled();
    init();
    expect(press(document.body, "keydown", "j").defaultPrevented).toBe(true);
    expect(reply()).toMatchObject({ type: "transport-key", phase: "down", key: "j", shiftKey: false, repeat: false, token });
    press(document.body, "keydown", "j", { repeat: true });
    expect(reply()).toMatchObject({ type: "transport-key", phase: "down", key: "j", repeat: true });
    press(document.body, "keyup", "j");
    expect(reply()).toMatchObject({ type: "transport-key", phase: "up", key: "j" });
    const count = sent.mock.calls.length;
    press(document.getElementById("entry")!, "keydown", "a");
    press(document.body, "keydown", "Delete");
    press(document.body, "keydown", "j", { metaKey: true });
    expect(sent).toHaveBeenCalledTimes(count);
  });
});
