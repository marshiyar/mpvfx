// @vitest-environment happy-dom

import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

import { useNativeProjectSession, type NativeProjectSessionState } from "./useNativeProjectSession";
import { NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION, serializeNativeProjectDocument, type NativeProjectDocument } from "../project/nativeProjectDocument";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function project(id: string): NativeProjectDocument {
  return {
    schemaVersion: NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
    id,
    revision: 0,
    frameRate: { numerator: 30, denominator: 1 },
    canvas: { width: 100, height: 100, background: "#000000" },
    assets: [{ id: "asset:a", kind: "video", name: "a.mov", durationFrames: 30 }],
    sequence: {
      id: "sequence:main",
      name: "Main",
      tracks: [{ id: "track:v", kind: "video", clips: [{
        id: "clip:a", assetId: "asset:a", startFrame: 0, durationFrames: 30, sourceInFrame: 0,
        muted: false, effects: [], parameterTracks: [],
      }] }],
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

let roots: Root[] = [];
afterEach(() => {
  roots.forEach((root) => act(() => root.unmount()));
  roots = [];
  document.body.replaceChildren();
});

function renderSession(props: Parameters<typeof useNativeProjectSession>[0], onState: (state: NativeProjectSessionState) => void) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  function Harness({ next }: { next: Parameters<typeof useNativeProjectSession>[0] }) {
    onState(useNativeProjectSession(next));
    return null;
  }
  act(() => root.render(<Harness next={props} />));
  return { root, rerender: (next: Parameters<typeof useNativeProjectSession>[0]) => act(() => root.render(<Harness next={next} />)) };
}

describe("useNativeProjectSession", () => {
  it("reinstalls the native runtime when the same iframe navigates to a new document", async () => {
    const native = project("project:navigation");
    native.sequence.tracks[0]!.clips[0]!.binding = {
      sourceFile: "index.html",
      domId: "media",
    };
    const firstDocument = document.implementation.createHTMLDocument("first");
    const secondDocument = document.implementation.createHTMLDocument("second");
    const firstMedia = firstDocument.createElement("video");
    const secondMedia = secondDocument.createElement("video");
    firstMedia.id = "media";
    secondMedia.id = "media";
    firstDocument.body.append(firstMedia);
    secondDocument.body.append(secondMedia);

    const events = new EventTarget();
    const iframeWindow = {} as Window;
    let activeDocument = firstDocument;
    const iframe = {
      get contentWindow() {
        return iframeWindow;
      },
      get contentDocument() {
        return activeDocument;
      },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    } as unknown as HTMLIFrameElement;
    let latest!: NativeProjectSessionState;
    renderSession(
      {
        projectId: "navigation",
        readOptionalProjectFile: vi.fn(async () => serializeNativeProjectDocument(native)),
        iframe,
      },
      (state) => (latest = state),
    );
    await act(async () => {});

    expect(latest.status).toBe("ready");
    expect(firstMedia.getAttribute("data-studio-clip-id")).toBe("clip:a");
    const firstPlayer = (iframeWindow as unknown as { __studioNativePlayer?: unknown })
      .__studioNativePlayer;

    activeDocument = secondDocument;
    await act(async () => {
      events.dispatchEvent(new Event("load"));
    });

    expect(firstMedia.hasAttribute("data-studio-clip-id")).toBe(false);
    expect(secondMedia.getAttribute("data-studio-clip-id")).toBe("clip:a");
    expect((iframeWindow as unknown as { __studioNativePlayer?: unknown }).__studioNativePlayer)
      .not.toBe(firstPlayer);
  });

  it("keeps the last valid adapter live during a same-project refresh, then replaces it only after valid data arrives", async () => {
    const replacement = deferred<string | null>();
    const read = vi
      .fn<(_: string) => Promise<string | null>>()
      .mockResolvedValueOnce(serializeNativeProjectDocument(project("project:a")))
      .mockImplementationOnce(() => replacement.promise);
    const iframeWindow = {} as Window;
    const iframe = { contentWindow: iframeWindow, contentDocument: document } as HTMLIFrameElement;
    let latest!: NativeProjectSessionState;
    const view = renderSession(
      { projectId: "a", reloadToken: 0, readOptionalProjectFile: read, iframe },
      (state) => (latest = state),
    );
    await act(async () => {});
    const firstPlayer = (iframeWindow as unknown as { __studioNativePlayer?: unknown }).__studioNativePlayer;

    view.rerender({ projectId: "a", reloadToken: 1, readOptionalProjectFile: read, iframe });
    await act(async () => {});
    expect(latest.status).toBe("loading");
    expect(latest.document?.id).toBe("project:a");
    expect((iframeWindow as unknown as { __studioNativePlayer?: unknown }).__studioNativePlayer).toBe(
      firstPlayer,
    );

    replacement.resolve(serializeNativeProjectDocument({ ...project("project:a"), revision: 1 }));
    await act(async () => {});
    expect(latest.status).toBe("ready");
    expect(latest.document?.revision).toBe(1);
    expect((iframeWindow as unknown as { __studioNativePlayer?: unknown }).__studioNativePlayer).not.toBe(
      firstPlayer,
    );
  });

  it("keeps a last-known-good native document and adapter when a refresh is malformed or fails", async () => {
    const malformed = deferred<string | null>();
    const read = vi
      .fn<(_: string) => Promise<string | null>>()
      .mockResolvedValueOnce(serializeNativeProjectDocument(project("project:a")))
      .mockImplementationOnce(() => malformed.promise);
    const iframeWindow = {} as Window;
    const iframe = { contentWindow: iframeWindow, contentDocument: document } as HTMLIFrameElement;
    let latest!: NativeProjectSessionState;
    const view = renderSession(
      { projectId: "a", reloadToken: 0, readOptionalProjectFile: read, iframe },
      (state) => (latest = state),
    );
    await act(async () => {});
    const player = (iframeWindow as unknown as { __studioNativePlayer?: unknown }).__studioNativePlayer;

    view.rerender({ projectId: "a", reloadToken: 1, readOptionalProjectFile: read, iframe });
    malformed.resolve("{");
    await act(async () => {});

    expect(latest.status).toBe("error");
    expect(latest.error).toBeInstanceOf(Error);
    expect(latest.document?.id).toBe("project:a");
    expect((iframeWindow as unknown as { __studioNativePlayer?: unknown }).__studioNativePlayer).toBe(player);
  });

  it("retains last-known-good playback when the replacement read rejects", async () => {
    const read = vi
      .fn<(_: string) => Promise<string | null>>()
      .mockResolvedValueOnce(serializeNativeProjectDocument(project("project:a")))
      .mockRejectedValueOnce(new Error("temporary disk error"));
    const iframeWindow = {} as Window;
    const iframe = { contentWindow: iframeWindow, contentDocument: document } as HTMLIFrameElement;
    let latest!: NativeProjectSessionState;
    const view = renderSession(
      { projectId: "a", reloadToken: 0, readOptionalProjectFile: read, iframe },
      (state) => (latest = state),
    );
    await act(async () => {});
    const player = (iframeWindow as unknown as { __studioNativePlayer?: unknown }).__studioNativePlayer;

    view.rerender({ projectId: "a", reloadToken: 1, readOptionalProjectFile: read, iframe });
    await act(async () => {});

    expect(latest.status).toBe("error");
    expect(latest.error?.message).toBe("temporary disk error");
    expect(latest.document?.id).toBe("project:a");
    expect((iframeWindow as unknown as { __studioNativePlayer?: unknown }).__studioNativePlayer).toBe(player);
  });

  it("does not retain a native document across a different project boundary", async () => {
    const second = deferred<string | null>();
    const read = vi
      .fn<(_: string) => Promise<string | null>>()
      .mockResolvedValueOnce(serializeNativeProjectDocument(project("project:first")))
      .mockImplementationOnce(() => second.promise);
    const iframeWindow = {} as Window;
    const iframe = { contentWindow: iframeWindow, contentDocument: document } as HTMLIFrameElement;
    let latest!: NativeProjectSessionState;
    const view = renderSession(
      { projectId: "first", reloadToken: 0, readOptionalProjectFile: read, iframe },
      (state) => (latest = state),
    );
    await act(async () => {});
    expect(latest.document?.id).toBe("project:first");

    view.rerender({ projectId: "second", reloadToken: 0, readOptionalProjectFile: read, iframe });
    await act(async () => {});
    expect(latest.status).toBe("loading");
    expect(latest.document).toBeNull();
    expect((iframeWindow as unknown as { __studioNativePlayer?: unknown }).__studioNativePlayer).toBeUndefined();
    await act(async () => {
      second.resolve(serializeNativeProjectDocument(project("project:second")));
    });
    expect(latest.document?.id).toBe("project:second");
  });

  it("leaves legacy playback untouched when the optional sidecar is absent", async () => {
    const legacy = { play() {}, pause() {}, seek() {}, getTime: () => 0, getDuration: () => 3, isPlaying: () => false };
    const iframeWindow = { __player: legacy } as unknown as Window;
    let latest!: NativeProjectSessionState;
    renderSession({ projectId: "a", readOptionalProjectFile: async () => null, iframe: { contentWindow: iframeWindow, contentDocument: document } as HTMLIFrameElement }, (state) => (latest = state));
    await act(async () => {});

    expect(latest.status).toBe("absent");
    expect((iframeWindow as unknown as { __player: unknown }).__player).toBe(legacy);
    expect((iframeWindow as unknown as { __studioNativePlayer?: unknown }).__studioNativePlayer).toBeUndefined();
  });

  it("exposes malformed sidecars as errors without replacing legacy playback", async () => {
    const legacy = { play() {}, pause() {}, seek() {}, getTime: () => 0, getDuration: () => 3, isPlaying: () => false };
    const iframeWindow = { __player: legacy } as unknown as Window;
    let latest!: NativeProjectSessionState;
    renderSession({ projectId: "a", readOptionalProjectFile: async () => "{", iframe: { contentWindow: iframeWindow, contentDocument: document } as HTMLIFrameElement }, (state) => (latest = state));
    await act(async () => {});

    expect(latest.status).toBe("error");
    expect(latest.error).toBeInstanceOf(Error);
    expect((iframeWindow as unknown as { __player: unknown }).__player).toBe(legacy);
    expect((iframeWindow as unknown as { __studioNativePlayer?: unknown }).__studioNativePlayer).toBeUndefined();
  });

  it("ignores a stale sidecar response after the user switches projects", async () => {
    const first = deferred<string | null>();
    const read = vi.fn((_: string) => first.promise);
    let latest!: NativeProjectSessionState;
    const view = renderSession({ projectId: "first", readOptionalProjectFile: read, iframe: null }, (state) => (latest = state));
    view.rerender({ projectId: "second", readOptionalProjectFile: async () => serializeNativeProjectDocument(project("project:second")), iframe: null });
    await act(async () => {});
    first.resolve(serializeNativeProjectDocument(project("project:first")));
    await act(async () => {});

    expect(latest.status).toBe("ready");
    expect(latest.document?.id).toBe("project:second");
  });

  it("reloads the native sidecar for the same project when its reload token changes", async () => {
    const read = vi
      .fn<(_: string) => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(serializeNativeProjectDocument(project("project:updated")));
    let latest!: NativeProjectSessionState;
    const base = {
      projectId: "same-project",
      readOptionalProjectFile: read,
      iframe: null,
    };
    const view = renderSession({ ...base, reloadToken: 0 }, (state) => (latest = state));
    await act(async () => {});
    expect(latest.status).toBe("absent");

    view.rerender({ ...base, reloadToken: 1 });
    await act(async () => {});

    expect(read).toHaveBeenCalledTimes(2);
    expect(latest.status).toBe("ready");
    expect(latest.document?.id).toBe("project:updated");
  });
});
