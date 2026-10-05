// @vitest-environment happy-dom

import React, { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePlaybackKeyboard } from "../usePlaybackKeyboard";
import { usePlayerStore } from "../../store/playerStore";

const agentMocks = vi.hoisted(() => ({ previewAgentForIframe: vi.fn() }));
vi.mock("../../../features/preview/previewAgentClient", () => ({
  previewAgentForIframe: agentMocks.previewAgentForIframe,
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
  usePlayerStore.getState().reset();
  agentMocks.previewAgentForIframe.mockReset();
});

interface Spies {
  seek: ReturnType<typeof vi.fn>;
  play: ReturnType<typeof vi.fn>;
  playBackward: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
}

interface HookHandle {
  dispatch: (event: KeyboardEvent) => void;
  release: (event: KeyboardEvent) => void;
  spies: Spies;
  attach: () => void;
  cleanup: () => void;
}

function setupHook(iframe: HTMLIFrameElement | null = null): HookHandle {
  const spies: Spies = {
    seek: vi.fn(),
    play: vi.fn(),
    playBackward: vi.fn(),
    pause: vi.fn(),
  };

  let captured: ReturnType<typeof usePlaybackKeyboard> | null = null;

  function Harness() {
    const iframeRef = React.useRef<HTMLIFrameElement | null>(iframe);
    const shuttleDirectionRef = React.useRef<"forward" | "backward" | null>(null);
    const shuttleSpeedIndexRef = React.useRef(0);
    const iframeShortcutCleanupRef = React.useRef<(() => void) | null>(null);
    const result = usePlaybackKeyboard({
      iframeRef,
      shuttleDirectionRef,
      shuttleSpeedIndexRef,
      iframeShortcutCleanupRef,
      getAdapter: () => null,
      ...spies,
    });
    useEffect(() => {
      captured = result;
      return () => iframeShortcutCleanupRef.current?.();
    });
    return null;
  }

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(React.createElement(Harness));
  });

  if (!captured) throw new Error("usePlaybackKeyboard harness did not capture handlers");

  return {
    dispatch: (event) => captured!.playbackKeyDownRef.current(event),
    release: (event) => captured!.playbackKeyUpRef.current(event),
    spies,
    attach: () => captured!.attachIframeShortcutListeners(),
    cleanup: () => act(() => root.unmount()),
  };
}

function keydown(init: { code: string; key: string; shiftKey?: boolean }): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    code: init.code,
    key: init.key,
    shiftKey: init.shiftKey ?? false,
    cancelable: true,
  });
}

function keyup(init: { code: string; key: string }): KeyboardEvent {
  return new KeyboardEvent("keyup", { code: init.code, key: init.key });
}

describe("usePlaybackKeyboard — keyboard layout independence (#834)", () => {
  it("'Jump to in-point' fires on physical KeyA in a QWERTY layout", () => {
    const { dispatch, spies } = setupHook();
    usePlayerStore.setState({ inPoint: 1.5 });

    act(() => {
      dispatch(keydown({ code: "KeyA", key: "a" }));
    });

    expect(spies.seek).toHaveBeenCalledWith(1.5, { keepPlaying: true });
  });

  it("'Jump to in-point' fires on AZERTY (physical KeyQ produces e.key='a')", () => {
    const { dispatch, spies } = setupHook();
    usePlayerStore.setState({ inPoint: 2.5 });

    act(() => {
      dispatch(keydown({ code: "KeyQ", key: "a" }));
    });

    expect(spies.seek).toHaveBeenCalledWith(2.5, { keepPlaying: true });
  });

  it("AZERTY 'A' physical key (e.key='q') no longer triggers in-point seek", () => {
    const { dispatch, spies } = setupHook();
    usePlayerStore.setState({ inPoint: 4.0 });

    act(() => {
      dispatch(keydown({ code: "KeyA", key: "q" }));
    });

    expect(spies.seek).not.toHaveBeenCalled();
  });

  it("Shift+I clears the in-point (e.key='I' is matched after lowercasing)", () => {
    const { dispatch } = setupHook();
    usePlayerStore.setState({ inPoint: 3.0 });

    act(() => {
      dispatch(keydown({ code: "KeyI", key: "I", shiftKey: true }));
    });

    expect(usePlayerStore.getState().inPoint).toBeNull();
  });

  it("K-held + L steps forward one frame (combo uses character, not physical position)", () => {
    const { dispatch, spies } = setupHook();
    usePlayerStore.setState({ currentTime: 0 });

    act(() => {
      dispatch(keydown({ code: "KeyK", key: "k" }));
    });
    act(() => {
      dispatch(keydown({ code: "KeyL", key: "l" }));
    });

    expect(spies.seek).toHaveBeenCalledTimes(1);
    expect(spies.play).not.toHaveBeenCalled();
  });

  it("releasing K removes it from the pressed set so subsequent L resumes forward shuttle", () => {
    const { dispatch, release, spies } = setupHook();

    act(() => {
      dispatch(keydown({ code: "KeyK", key: "k" }));
    });
    act(() => {
      release(keyup({ code: "KeyK", key: "k" }));
    });
    act(() => {
      dispatch(keydown({ code: "KeyL", key: "l" }));
    });

    expect(spies.play).toHaveBeenCalledTimes(1);
    expect(spies.seek).not.toHaveBeenCalled();
  });

  it("Space (universal e.code) still toggles play", () => {
    const { dispatch, spies } = setupHook();
    usePlayerStore.setState({ isPlaying: false });

    act(() => {
      dispatch(keydown({ code: "Space", key: " " }));
    });

    expect(spies.play).toHaveBeenCalledTimes(1);
  });
});

describe("usePlaybackKeyboard — mute & loop shortcuts (#905)", () => {
  it("M toggles audioMuted", () => {
    const { dispatch } = setupHook();
    expect(usePlayerStore.getState().audioMuted).toBe(false);

    act(() => {
      dispatch(keydown({ code: "KeyM", key: "m" }));
    });
    expect(usePlayerStore.getState().audioMuted).toBe(true);

    act(() => {
      dispatch(keydown({ code: "KeyM", key: "m" }));
    });
    expect(usePlayerStore.getState().audioMuted).toBe(false);
  });

  it("M toggles audioMuted above 1x playback too", () => {
    const { dispatch } = setupHook();
    usePlayerStore.setState({ playbackRate: 2, audioMuted: false });

    act(() => {
      dispatch(keydown({ code: "KeyM", key: "m" }));
    });

    expect(usePlayerStore.getState().audioMuted).toBe(true);
  });

  it("Shift+L toggles loopEnabled without starting forward shuttle", () => {
    const { dispatch, spies } = setupHook();
    expect(usePlayerStore.getState().loopEnabled).toBe(false);

    act(() => {
      dispatch(keydown({ code: "KeyL", key: "L", shiftKey: true }));
    });
    expect(usePlayerStore.getState().loopEnabled).toBe(true);
    expect(spies.play).not.toHaveBeenCalled();

    act(() => {
      dispatch(keydown({ code: "KeyL", key: "L", shiftKey: true }));
    });
    expect(usePlayerStore.getState().loopEnabled).toBe(false);
  });

  it("Plain L still starts forward shuttle (regression guard)", () => {
    const { dispatch, spies } = setupHook();

    act(() => {
      dispatch(keydown({ code: "KeyL", key: "l" }));
    });

    expect(spies.play).toHaveBeenCalledTimes(1);
    expect(usePlayerStore.getState().loopEnabled).toBe(false);
  });
});

describe("usePlaybackKeyboard — isolated preview transport", () => {
  it("handles validated agent keydown and keyup without a readable iframe document", () => {
    const iframe = document.createElement("iframe");
    Object.defineProperty(iframe, "contentDocument", { value: null });
    document.body.append(iframe);
    let transport: ((event: { phase: "down" | "up"; key: "k" | "l" | " "; shiftKey: boolean }) => void) | null = null;
    const unsubscribe = vi.fn();
    agentMocks.previewAgentForIframe.mockReturnValue({
      onTransportKey: vi.fn((listener) => { transport = listener; return unsubscribe; }),
    });
    const { cleanup, spies } = setupHook(iframe);
    if (!transport) throw new Error("Expected isolated transport listener");
    usePlayerStore.setState({ isPlaying: false });
    act(() => {
      transport!({ phase: "down", key: " ", shiftKey: false });
      transport!({ phase: "down", key: "k", shiftKey: false });
      transport!({ phase: "down", key: "l", shiftKey: false });
    });
    expect(spies.play).toHaveBeenCalledTimes(1);
    expect(spies.pause).toHaveBeenCalledTimes(1);
    expect(spies.seek).toHaveBeenCalledTimes(1);
    act(() => {
      transport!({ phase: "up", key: "k", shiftKey: false });
      transport!({ phase: "down", key: "l", shiftKey: false });
    });
    expect(spies.play).toHaveBeenCalledTimes(2);
    cleanup();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
