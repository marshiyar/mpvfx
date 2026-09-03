// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DomEditOverlay } from "./DomEditOverlay";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// happy-dom (20.x) holds each MutationObserver's delivery callback ONLY via a
// WeakRef (MutationObserverListener: `callback: new WeakRef(...)` — the arrow
// has no strong referent). If V8 runs a GC between observe() and a mutation,
// deref() returns undefined and mutation delivery silently stops — the
// indicator-refresh loop never sees its dirty flag and these tests flake under
// full-suite memory pressure (passing in isolation). Pin WeakRef to a strong
// ref for this file so the real observer path stays deterministic.
const RealWeakRef = globalThis.WeakRef;
class StrongRef<T extends WeakKey> {
  #value: T;
  constructor(value: T) {
    this.#value = value;
  }
  deref(): T {
    return this.#value;
  }
}
beforeAll(() => {
  (globalThis as { WeakRef: unknown }).WeakRef = StrongRef;
});
afterAll(() => {
  globalThis.WeakRef = RealWeakRef;
});

const LEGACY_INDICATOR =
  '[role="button"][aria-label^="Select off-canvas element"], [title^="Off-canvas:"]';

function domRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

// The refresh rebuilds at most every RECOMPUTE_INTERVAL_MS — it walks the whole
// preview and reads layout per element, which is too much to do per frame while
// animation is writing inline styles. Waiting past that window is what makes
// consecutive frames here represent consecutive rebuilds.
async function flushAnimationFrames(): Promise<void> {
  // Give any delayed overlay work a chance to run. The removed implementation
  // rebuilt these indicators on a throttled animation loop.
  await new Promise<void>((resolve) => setTimeout(resolve, 125));
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

interface OverlayHarness {
  host: HTMLElement;
  movedElement: HTMLElement;
  cleanup: () => void;
}

// Mount DomEditOverlay over an iframe whose #headline sits at `initialLeft`, with a
// getBoundingClientRect stub that reads the element's live inline geometry (so a
// style mutation moves it) and reports the composition/overlay as 800x450 at origin.
function mountOverlayWithHeadline(initialLeft: number): OverlayHarness {
  const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  const iframe = document.createElement("iframe");
  document.body.append(iframe);
  const doc = iframe.contentDocument;
  if (!doc) throw new Error("Expected iframe content document");

  doc.body.innerHTML = `
    <div data-composition-id="root" data-width="800" data-height="450">
      <div id="headline" style="position:absolute; left:${initialLeft}px; top:40px; width:100px; height:40px;">Headline</div>
    </div>
  `;
  const movedElement = doc.getElementById("headline");
  if (!movedElement) throw new Error("Expected test element");

  Element.prototype.getBoundingClientRect = function (): DOMRect {
    if (this === movedElement) {
      return domRect(
        Number.parseFloat(movedElement.style.left),
        Number.parseFloat(movedElement.style.top),
        Number.parseFloat(movedElement.style.width),
        Number.parseFloat(movedElement.style.height),
      );
    }
    return domRect(0, 0, 800, 450);
  };

  act(() => {
    root.render(
      <DomEditOverlay
        iframeRef={{ current: iframe }}
        activeCompositionPath={null}
        selection={null}
        hoverSelection={null}
        groupSelections={[]}
        onCanvasMouseDown={() => {}}
        onCanvasPointerMove={() => Promise.resolve(null)}
        onCanvasPointerLeave={() => {}}
        onSelectionChange={() => {}}
        onBlockedMove={() => {}}
        onPathOffsetCommit={() => {}}
        onGroupPathOffsetCommit={() => {}}
        onBoxSizeCommit={() => {}}
        onRotationCommit={() => {}}
      />,
    );
  });

  return {
    host,
    movedElement,
    cleanup: () => {
      act(() => root.unmount());
      Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
      iframe.remove();
      host.remove();
    },
  };
}

describe("program-frame containment", () => {
  it("does not draw an editor affordance for unselected media outside the canvas", async () => {
    const h = mountOverlayWithHeadline(760);
    try {
      await act(async () => {
        await flushAnimationFrames();
      });
      expect(h.host.querySelector(LEGACY_INDICATOR)).toBeNull();
    } finally {
      h.cleanup();
    }
  });

});
