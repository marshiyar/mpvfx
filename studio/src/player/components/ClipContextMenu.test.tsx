// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePlayerStore, type TimelineElement } from "../store/playerStore";
import { ClipContextMenu } from "./ClipContextMenu";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  usePlayerStore.setState({ thumbnailMode: "adaptive" });
});

function renderMenu(element: TimelineElement) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const onClose = vi.fn();
  const onToggleMuted = vi.fn();
  act(() => {
    root!.render(
      <ClipContextMenu
        x={20}
        y={20}
        element={element}
        currentTime={1}
        onClose={onClose}
        onSplit={vi.fn()}
        onDelete={vi.fn()}
        onToggleMuted={onToggleMuted}
      />,
    );
  });
  return { onClose, onToggleMuted };
}

const video: TimelineElement = {
  id: "clip-video",
  tag: "video",
  src: "assets/clip.mp4",
  start: 0,
  duration: 4,
  track: 0,
};

describe("ClipContextMenu thumbnail setting", () => {
  it("shows the checked Show thumbnails action for the default adaptive mode", () => {
    renderMenu(video);

    const action = document.body.querySelector<HTMLButtonElement>(
      'button[role="menuitemcheckbox"]',
    );
    expect(action?.textContent).toContain("Show thumbnails");
    expect(action?.getAttribute("aria-checked")).toBe("true");
  });

  it("toggles hidden thumbnails back on exactly once", () => {
    usePlayerStore.setState({ thumbnailMode: "hidden" });
    const { onClose } = renderMenu(video);
    const action = document.body.querySelector<HTMLButtonElement>(
      'button[role="menuitemcheckbox"]',
    );

    expect(action?.textContent).toContain("Show thumbnails");
    expect(action?.getAttribute("aria-checked")).toBe("false");
    act(() => action?.click());

    expect(usePlayerStore.getState().thumbnailMode).toBe("adaptive");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not offer a visual-thumbnail setting for an audio-only clip", () => {
    renderMenu({ ...video, id: "voice", tag: "audio", src: "assets/voice.wav" });

    expect(
      Array.from(document.body.querySelectorAll('[role="menuitemcheckbox"]')).some((action) =>
        action.textContent?.includes("Show thumbnails"),
      ),
    ).toBe(false);
  });
});

describe("ClipContextMenu mute action", () => {
  it("offers Mute for an unmuted video and toggles only that clip", () => {
    const { onClose, onToggleMuted } = renderMenu(video);
    const action = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button[role="menuitemcheckbox"]'))
      .find((button) => button.textContent?.includes("Mute"));

    expect(action?.textContent).toContain("Mute");
    expect(action?.getAttribute("aria-checked")).toBe("false");
    act(() => action?.click());

    expect(onToggleMuted).toHaveBeenCalledExactlyOnceWith(video, true);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("offers Unmute for a muted audio clip", () => {
    const audio = {
      ...video,
      id: "voice",
      tag: "audio",
      src: "assets/voice.wav",
      muted: true,
    } satisfies TimelineElement;
    const { onToggleMuted } = renderMenu(audio);
    const action = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button[role="menuitemcheckbox"]'))
      .find((button) => button.textContent?.includes("Unmute"));

    expect(action?.getAttribute("aria-checked")).toBe("true");
    act(() => action?.click());

    expect(onToggleMuted).toHaveBeenCalledExactlyOnceWith(audio, false);
  });

  it("does not offer mute for an image", () => {
    renderMenu({ ...video, id: "still", tag: "img", src: "assets/still.png" });

    expect(document.body.textContent).not.toContain("Mute");
    expect(document.body.textContent).not.toContain("Unmute");
  });

  it("does not offer mute for a composition host whose preview tag resolves to video", () => {
    renderMenu({
      ...video,
      id: "scene",
      kind: "composition",
      compositionSrc: "scenes/scene.html",
    });

    expect(document.body.textContent).not.toContain("Mute");
    expect(document.body.textContent).not.toContain("Unmute");
  });
});
