// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlaybackAdapter } from "../lib/playbackTypes";
import { usePlayerStore } from "../store/playerStore";
import { hydrateTimelineFromPreview } from "./timelineSyncHydration";

describe("empty media project timeline hydration", () => {
  afterEach(() => usePlayerStore.getState().reset());

  it("does not expose the structural composition container as a deletable clip", () => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    iframe.contentDocument?.open();
    iframe.contentDocument?.write(`<!doctype html><html><body>
      <div id="root" data-composition-id="main" data-start="0" data-duration="5"></div>
    </body></html>`);
    iframe.contentDocument?.close();
    if (iframe.contentWindow) vi.spyOn(iframe.contentWindow, "scrollTo").mockImplementation(() => {});
    const syncTimelineElements = vi.fn();
    const adapter: PlaybackAdapter = {
      play: vi.fn(),
      pause: vi.fn(),
      seek: vi.fn(),
      getTime: () => 0,
      getDuration: () => 5,
      isPlaying: () => false,
    };

    hydrateTimelineFromPreview({
      iframe,
      adapter,
      processTimelineMessage: vi.fn(),
      enrichMissingCompositions: vi.fn(),
      applyPreviewAudioState: vi.fn(),
      attachIframeShortcutListeners: vi.fn(),
      syncTimelineElements,
    });

    expect(syncTimelineElements).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().elements).toEqual([]);
    iframe.remove();
  });
});
