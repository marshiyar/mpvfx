// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePlayerStore, type TimelineElement } from "../../player/store/playerStore";
import { AssetsTab } from "./AssetsTab";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("./AudioRow", () => ({
  AudioRow: ({ asset, used }: { asset: string; used: boolean }) => (
    <div data-testid="media-item">{asset}{used ? " Used" : ""}</div>
  ),
}));
vi.mock("./AssetCard", () => ({
  AssetCard: ({ asset, used }: { asset: string; used: boolean }) => (
    <div data-testid="media-item">{asset}{used ? " Used" : ""}</div>
  ),
  FontRow: ({ asset, used }: { asset: string; used: boolean }) => (
    <div data-testid="media-item">{asset}{used ? " Used" : ""}</div>
  ),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  usePlayerStore.getState().reset();
});

describe("AssetsTab media controls", () => {
  it("shows search and grouped media without redundant count/filter pills", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 })),
    );
    usePlayerStore.setState({
      elements: [{ id: "used-video", src: "clip-one.mp4" } as TimelineElement],
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => {
      root.render(
        <AssetsTab
          projectId="test-project"
          assets={["clip-one.mp4", "clip-two.mp4", "voice-one.mp3", "voice-two.mp3"]}
        />,
      );
    });

    expect(host.querySelector('[aria-label="Search assets"]')).not.toBeNull();
    const buttonLabels = Array.from(host.querySelectorAll("button"), (button) =>
      button.textContent?.trim(),
    );
    for (const redundantPill of ["All 4", "Audio 2", "Video 2", "In use 1", "Unused 3"]) {
      expect(buttonLabels).not.toContain(redundantPill);
    }
    expect(Array.from(host.querySelectorAll("h3"), (heading) => heading.textContent)).toEqual([
      "Audio",
      "Video",
    ]);
    expect(Array.from(host.querySelectorAll('[data-testid="media-item"]'), (item) => item.textContent))
      .toEqual(["voice-one.mp3", "voice-two.mp3", "clip-one.mp4 Used", "clip-two.mp4"]);

    act(() => root.unmount());
  });
});
