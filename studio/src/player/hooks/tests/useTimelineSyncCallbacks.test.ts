// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import {
  resolveReloadSeekTime,
  resolveTimelineTotalDuration,
  revealIframe,
  useTimelineSyncCallbacks,
} from "../useTimelineSyncCallbacks";
import { readTimelineDurationFromDocument } from "../../lib/timelineDOM";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function mountPendingPreviewSync() {
  const added = vi.spyOn(window, "addEventListener");
  const removed = vi.spyOn(window, "removeEventListener");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const probeIntervalRef = { current: undefined as ReturnType<typeof setInterval> | undefined };
  const params: Parameters<typeof useTimelineSyncCallbacks>[0] = {
    iframeRef: { current: document.createElement("iframe") },
    probeIntervalRef,
    pendingSeekRef: { current: null },
    isRefreshingRef: { current: false },
    getAdapter: () => null,
    syncTimelineElements: vi.fn(),
    setDuration: vi.fn(),
    setCurrentTime: vi.fn(),
    setTimelineReady: vi.fn(),
    setIsPlaying: vi.fn(),
    attachIframeShortcutListeners: vi.fn(),
    applyPreviewAudioState: vi.fn(),
  };
  let load: (() => void) | undefined;
  function Harness() {
    load = useTimelineSyncCallbacks(params).onIframeLoad;
    return null;
  }
  act(() => root.render(React.createElement(Harness)));
  const activeReadinessListeners = () => {
    const removedListeners = new Set(
      removed.mock.calls.filter(([type]) => type === "message").map(([, listener]) => listener),
    );
    return added.mock.calls
      .filter(([type, listener]) => type === "message" && !removedListeners.has(listener))
      .map(([, listener]) => listener);
  };
  let unmounted = false;
  const unmount = () => {
    if (unmounted) return;
    unmounted = true;
    act(() => root.unmount());
  };
  return {
    load: () => act(() => load?.()),
    activeReadinessListeners,
    unmount,
    cleanup: () => {
      unmount();
      // Keep a failed cleanup regression from leaking listeners into other tests.
      for (const listener of activeReadinessListeners()) {
        window.removeEventListener("message", listener);
      }
      if (probeIntervalRef.current) clearInterval(probeIntervalRef.current);
      added.mockRestore();
      removed.mockRestore();
      host.remove();
    },
  };
}

describe("preview readiness listener ownership", () => {
  it("replaces a pending readiness listener when the next iframe load begins", () => {
    vi.useFakeTimers();
    const harness = mountPendingPreviewSync();
    try {
      harness.load();
      expect(harness.activeReadinessListeners()).toHaveLength(1);
      harness.load();
      expect(harness.activeReadinessListeners()).toHaveLength(1);
      act(() => vi.advanceTimersByTime(5000));
      expect(harness.activeReadinessListeners()).toHaveLength(0);
    } finally {
      harness.cleanup();
      vi.useRealTimers();
    }
  });

  it("releases a pending readiness listener when the owning hook unmounts", () => {
    vi.useFakeTimers();
    const harness = mountPendingPreviewSync();
    try {
      harness.load();
      harness.unmount();
      expect(harness.activeReadinessListeners()).toHaveLength(0);
    } finally {
      harness.cleanup();
      vi.useRealTimers();
    }
  });
});

// Minimal stand-in — revealIframe only touches `style.visibility`. Avoids
// depending on a DOM environment (this test file runs under node).
function fakeIframe(visibility: string): HTMLIFrameElement {
  return { style: { visibility } } as unknown as HTMLIFrameElement;
}

describe("revealIframe", () => {
  it("clears a hidden iframe's visibility (undoes refreshPlayer's hide)", () => {
    const iframe = fakeIframe("hidden");
    revealIframe(iframe);
    expect(iframe.style.visibility).toBe("");
  });

  it("leaves an already-visible iframe untouched (idempotent)", () => {
    const iframe = fakeIframe("");
    revealIframe(iframe);
    expect(iframe.style.visibility).toBe("");
  });

  it("no-ops on a null iframe", () => {
    expect(() => revealIframe(null)).not.toThrow();
  });
});

describe("resolveReloadSeekTime", () => {
  it("restores the pending seek saved by refreshPlayer (the primary reload path)", () => {
    expect(
      resolveReloadSeekTime({
        pendingSeek: 7.2,
        requestedSeek: null,
        storeCurrentTime: 7.2,
        duration: 20,
      }),
    ).toBe(7.2);
  });

  it("honors a deep-link seek request when no pending seek exists", () => {
    expect(
      resolveReloadSeekTime({
        pendingSeek: null,
        requestedSeek: 12.5,
        storeCurrentTime: 0,
        duration: 20,
      }),
    ).toBe(12.5);
  });

  it("THE BUG: a second overlapping reload (pending seek already consumed) restores the store playhead, not 0", () => {
    // Drop → reload #1 consumes pendingSeek and seeks/syncs to 7.2. A staggered
    // second reload (refreshPreviewDocumentVersion 80/300ms bumps) then finds the
    // slot empty — the old code reset the playhead to 0 here.
    expect(
      resolveReloadSeekTime({
        pendingSeek: null,
        requestedSeek: null,
        storeCurrentTime: 7.2,
        duration: 20,
      }),
    ).toBe(7.2);
  });

  it("fresh project load starts at 0 (store resets currentTime on project switch)", () => {
    expect(
      resolveReloadSeekTime({
        pendingSeek: null,
        requestedSeek: null,
        storeCurrentTime: 0,
        duration: 20,
      }),
    ).toBe(0);
  });

  it("clamps to duration when content shrank past the playhead (the one sanctioned move)", () => {
    expect(
      resolveReloadSeekTime({
        pendingSeek: 18,
        requestedSeek: null,
        storeCurrentTime: 18,
        duration: 9,
      }),
    ).toBe(9);
  });

  it("a pending seek of 0 is an explicit position, not a missing value", () => {
    expect(
      resolveReloadSeekTime({
        pendingSeek: 0,
        requestedSeek: 12,
        storeCurrentTime: 5,
        duration: 20,
      }),
    ).toBe(0);
  });

  it("returns the guarded target unclamped when the duration is non-finite (no seek(NaN))", () => {
    // Mid-reload the adapter can report a NaN duration; Math.min(target, NaN) would
    // be NaN and seek(NaN). The guarded target must pass through unclamped instead.
    expect(
      resolveReloadSeekTime({
        pendingSeek: 7.2,
        requestedSeek: null,
        storeCurrentTime: 7.2,
        duration: Number.NaN,
      }),
    ).toBe(7.2);
    // A zero/negative duration is equally unusable — pass the target through.
    expect(
      resolveReloadSeekTime({
        pendingSeek: 7.2,
        requestedSeek: null,
        storeCurrentTime: 7.2,
        duration: 0,
      }),
    ).toBe(7.2);
  });

  it("guards against non-finite and negative targets", () => {
    expect(
      resolveReloadSeekTime({
        pendingSeek: Number.NaN,
        requestedSeek: null,
        storeCurrentTime: 5,
        duration: 20,
      }),
    ).toBe(0);
    expect(
      resolveReloadSeekTime({
        pendingSeek: -3,
        requestedSeek: null,
        storeCurrentTime: 5,
        duration: 20,
      }),
    ).toBe(0);
  });
});

describe("resolveTimelineTotalDuration", () => {
  it("THE BUG: a clip-manifest total shorter than the authored root duration never wins (stale '0:44/0:40')", () => {
    // Fixture shape: root data-duration=44.5, furthest clip ends at 40. A runtime
    // that measures the manifest from the furthest clip end reports 40s; playback
    // still runs the full 44.5s, so the transport total must stay 44.5, not 40.
    expect(
      resolveTimelineTotalDuration({
        manifestDurationSeconds: 40,
        authoredRootDurationSeconds: 44.5,
      }),
    ).toBe(44.5);
  });

  it("lets clips extend the total PAST the authored root (content can grow the timeline)", () => {
    expect(
      resolveTimelineTotalDuration({
        manifestDurationSeconds: 50,
        authoredRootDurationSeconds: 44.5,
      }),
    ).toBe(50);
  });

  it("falls back to the manifest total when the root authors no duration", () => {
    expect(
      resolveTimelineTotalDuration({
        manifestDurationSeconds: 40,
        authoredRootDurationSeconds: 0,
      }),
    ).toBe(40);
  });

  it("uses the authored root when the manifest is loop-inflated / non-finite", () => {
    expect(
      resolveTimelineTotalDuration({
        manifestDurationSeconds: Number.POSITIVE_INFINITY,
        authoredRootDurationSeconds: 44.5,
      }),
    ).toBe(44.5);
    expect(
      resolveTimelineTotalDuration({
        manifestDurationSeconds: 9000, // beyond the 7200s sanity cap
        authoredRootDurationSeconds: 44.5,
      }),
    ).toBe(44.5);
  });

  it("returns 0 when neither source yields a usable duration", () => {
    expect(
      resolveTimelineTotalDuration({
        manifestDurationSeconds: Number.NaN,
        authoredRootDurationSeconds: -1,
      }),
    ).toBe(0);
  });

  it("floors the manifest at the authored root read from the fixture's DOM shape", () => {
    // Reconstruct the fixture: root authored at 44.5s, last clip (v-letters)
    // ends at 34 + 6 = 40s. readTimelineDurationFromDocument must report the
    // authored 44.5, and flooring the 40s manifest total against it yields 44.5.
    const doc = document.implementation.createHTMLDocument("fixture");
    doc.body.innerHTML =
      '<div id="main" data-composition-id="main" data-duration="44.5">' +
      '<video class="clip" data-start="34" data-duration="6"></video>' +
      "</div>";
    const authoredRootDurationSeconds = readTimelineDurationFromDocument(doc);
    expect(authoredRootDurationSeconds).toBe(44.5);
    expect(
      resolveTimelineTotalDuration({
        manifestDurationSeconds: 1200 / 30, // durationInFrames measured from clip end
        authoredRootDurationSeconds,
      }),
    ).toBe(44.5);
  });
});
