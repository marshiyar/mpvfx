// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installReactActEnvironment, makeSelection } from "../domSelectionTestHarness";
import type { DomEditSelection } from "../domEditing";
import type { SelectElementOptions, TimelineElement } from "../../../player/index";
import { usePlayerStore } from "../../../player/index";

installReactActEnvironment();

// ── Module mocks ──
// Control the async selection-resolution ordering so the race guard can be
// exercised deterministically, and neutralise the DOM re-apply side effect.
vi.mock("../manualEdits", () => ({
  reapplyPositionEditsAfterSeek: () => undefined,
}));

const deferreds = new Map<string, { promise: Promise<DomEditSelection>; resolve: () => void }>();

function deferredFor(el: HTMLElement): Promise<DomEditSelection> {
  const id = el.id;
  let resolveFn: () => void = () => undefined;
  const promise = new Promise<DomEditSelection>((resolve) => {
    resolveFn = () => resolve(makeSelection(id.toUpperCase(), el));
  });
  deferreds.set(id, { promise, resolve: resolveFn });
  return promise;
}

vi.mock("../domEditing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../domEditing")>();
  return {
    ...actual,
    findElementForTimelineElement: (doc: Document, element: { id?: string }) =>
      element.id ? doc.getElementById(element.id) : null,
    resolveDomEditSelection: (startEl: HTMLElement | null) =>
      startEl ? deferredFor(startEl) : Promise.resolve(null),
  };
});

// Imported after the mocks so the hook picks up the mocked modules.
const { useDomSelection } = await import("../useDomSelection");

interface HarnessProps {
  projectId?: string;
  setRightPanelTab: (tab: "design") => void;
  setRightCollapsed?: (collapsed: boolean) => void;
  iframe: HTMLIFrameElement | null;
  timelineElements: TimelineElement[];
  setSelectedTimelineElementId?: (id: string | null, options?: SelectElementOptions) => void;
  setTimelineSelectionSet?: (ids: Set<string>) => void;
}

function renderHarness(props: HarnessProps) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let currentHook: ReturnType<typeof useDomSelection> | null = null;
  let mounted = true;

  function Harness() {
    currentHook = useDomSelection({
      projectId: props.projectId ?? "project-1",
      activeCompPath: "index.html",
      isMasterView: false,
      compIdToSrc: new Map(),
      captionEditMode: false,
      previewIframeRef: { current: props.iframe },
      timelineElements: props.timelineElements,
      getTimelineSelectionSet: () => usePlayerStore.getState().selectedElementIds,
      setSelectedTimelineElementId: props.setSelectedTimelineElementId ?? vi.fn(),
      setTimelineSelectionSet:
        props.setTimelineSelectionSet ?? usePlayerStore.getState().setSelectedElementIds,
      setRightCollapsed: props.setRightCollapsed ?? vi.fn(),
      setRightPanelTab: props.setRightPanelTab,
      previewIframe: props.iframe,
      refreshKey: 0,
    });
    return null;
  }

  act(() => root.render(React.createElement(Harness)));

  return {
    current: () => {
      if (!currentHook) throw new Error("Expected hook result");
      return currentHook;
    },
    cleanup: () => {
      if (!mounted) return;
      mounted = false;
      act(() => root.unmount());
      host.remove();
    },
    rerender: (updates: Partial<HarnessProps>) => {
      Object.assign(props, updates);
      act(() => root.render(React.createElement(Harness)));
    },
  };
}

describe("useDomSelection — inspector reveal", () => {
  it("reveals the inspector without replacing the user's active tab", () => {
    const setRightPanelTab = vi.fn();
    const setRightCollapsed = vi.fn();
    const el = document.createElement("div");
    el.id = "headline";
    const harness = renderHarness({
      setRightPanelTab,
      setRightCollapsed,
      iframe: null,
      timelineElements: [],
    });

    act(() => harness.current().applyDomSelection(makeSelection("Headline", el)));

    expect(setRightCollapsed).toHaveBeenCalledWith(false);
    expect(setRightPanelTab).not.toHaveBeenCalled();

    setRightCollapsed.mockClear();
    act(() => harness.current().applyDomSelection(makeSelection("Headline", el)));

    expect(setRightCollapsed).toHaveBeenCalledWith(false);
    expect(setRightPanelTab).not.toHaveBeenCalled();
    harness.cleanup();
  });
});

describe("useDomSelection — canvas-only targets replace timeline clips", () => {
  beforeEach(() => {
    deferreds.clear();
    usePlayerStore.getState().clearSelection();
  });
  afterEach(() => {
    deferreds.clear();
    usePlayerStore.getState().clearSelection();
  });

  it("deselects every clip when an audio bus is selected", () => {
    const store = usePlayerStore.getState();
    store.setSelectedElementId("voice-1");
    store.setSelectedElementIds(new Set(["voice-1", "voice-2"]));

    const bus = document.createElement("hf-audio-group");
    bus.id = "voiceover";
    const harness = renderHarness({
      setRightPanelTab: vi.fn(),
      iframe: null,
      timelineElements: [
        { id: "voice-1", tag: "audio", start: 0, duration: 1, track: 0 },
        { id: "voice-2", tag: "audio", start: 1, duration: 1, track: 1 },
      ],
      setSelectedTimelineElementId: usePlayerStore.getState().setSelectedElementId,
      setTimelineSelectionSet: usePlayerStore.getState().setSelectedElementIds,
    });

    act(() => harness.current().applyDomSelection(makeSelection("Voiceover", bus)));

    expect(harness.current().domEditSelection?.id).toBe("voiceover");
    expect(usePlayerStore.getState().selectedElementId).toBeNull();
    expect(usePlayerStore.getState().selectedElementIds).toEqual(new Set());
    harness.cleanup();
  });

  it("lets a bus supersede a clip selection that is still resolving", async () => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const doc = iframe.contentDocument!;
    const clipNode = doc.createElement("audio");
    clipNode.id = "voice-1";
    const busNode = doc.createElement("hf-audio-group");
    busNode.id = "voiceover";
    doc.body.append(clipNode, busNode);

    const clip: TimelineElement = {
      id: "voice-1",
      domId: "voice-1",
      tag: "audio",
      start: 0,
      duration: 1,
      track: 0,
    };
    const bus: TimelineElement = {
      id: "voiceover",
      domId: "voiceover",
      tag: "audio",
      start: 0,
      duration: 10,
      track: -0.5,
    };
    const harness = renderHarness({
      setRightPanelTab: vi.fn(),
      iframe,
      // The bus is a synthetic row target, not a clip in the store.
      timelineElements: [clip],
      setSelectedTimelineElementId: usePlayerStore.getState().setSelectedElementId,
      setTimelineSelectionSet: usePlayerStore.getState().setSelectedElementIds,
    });

    let pendingClip = Promise.resolve();
    let pendingBus = Promise.resolve();
    act(() => {
      pendingClip = harness.current().handleTimelineElementSelect(clip);
      pendingBus = harness.current().handleTimelineElementSelect(bus);
    });
    await act(async () => {
      deferreds.get("voiceover")?.resolve();
      await pendingBus;
      deferreds.get("voice-1")?.resolve();
      await pendingClip;
    });

    expect(harness.current().domEditSelection?.id).toBe("voiceover");
    expect(usePlayerStore.getState().selectedElementId).toBeNull();
    expect(usePlayerStore.getState().selectedElementIds).toEqual(new Set());
    harness.cleanup();
    iframe.remove();
  });

  it("preserves clip context for a non-bus canvas-only selection", () => {
    const store = usePlayerStore.getState();
    store.setSelectedElementId("voice-1");
    const decoration = document.createElement("div");
    decoration.id = "decoration";
    const harness = renderHarness({
      setRightPanelTab: vi.fn(),
      iframe: null,
      timelineElements: [{ id: "voice-1", tag: "audio", start: 0, duration: 1, track: 0 }],
      setSelectedTimelineElementId: usePlayerStore.getState().setSelectedElementId,
      setTimelineSelectionSet: usePlayerStore.getState().setSelectedElementIds,
    });

    act(() => harness.current().applyDomSelection(makeSelection("Decoration", decoration)));

    expect(usePlayerStore.getState().selectedElementId).toBe("voice-1");
    expect(usePlayerStore.getState().selectedElementIds).toEqual(new Set(["voice-1"]));
    harness.cleanup();
  });
});

describe("useDomSelection — timeline-select race guard", () => {
  beforeEach(() => deferreds.clear());
  afterEach(() => deferreds.clear());

  it("a stale async resolution never clobbers a newer selection", async () => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const doc = iframe.contentDocument!;
    const elA = doc.createElement("div");
    elA.id = "a";
    const elB = doc.createElement("div");
    elB.id = "b";
    doc.body.append(elA, elB);

    const elementA: TimelineElement = { id: "a", tag: "div", start: 0, duration: 1, track: 0 };
    const elementB: TimelineElement = { id: "b", tag: "div", start: 0, duration: 1, track: 0 };

    const harness = renderHarness({
      setRightPanelTab: vi.fn(),
      iframe,
      timelineElements: [elementA, elementB],
    });

    // Fire A then B; both suspend on their (pending) resolveDomEditSelection.
    let pA: Promise<void> = Promise.resolve();
    let pB: Promise<void> = Promise.resolve();
    act(() => {
      pA = harness.current().handleTimelineElementSelect(elementA);
      pB = harness.current().handleTimelineElementSelect(elementB);
    });

    // Resolve the NEWER select (B) first, then the older one (A) last.
    await act(async () => {
      deferreds.get("b")?.resolve();
      await pB;
    });
    await act(async () => {
      deferreds.get("a")?.resolve();
      await pA;
    });

    // The stale A resolution must be dropped: B wins.
    expect(harness.current().domEditSelection?.id).toBe("b");
    harness.cleanup();
    iframe.remove();
  });
});

describe("useDomSelection — marquee multi-select survives the late async primary", () => {
  beforeEach(() => {
    deferreds.clear();
    const store = usePlayerStore.getState();
    store.setSelectedElementId(null);
    store.clearSelectedElementIds();
  });
  afterEach(() => {
    deferreds.clear();
    const store = usePlayerStore.getState();
    store.setSelectedElementId(null);
    store.clearSelectedElementIds();
  });

  function timelineEl(id: string): TimelineElement {
    return { id, domId: id, tag: "div", start: 0, duration: 1, track: 0 };
  }

  // Reproduces the reported regression: a marquee over N clips leaves N members in
  // selectedElementIds, then the inspector-open notify (finishMarquee →
  // handleTimelineElementSelect → applyDomSelection) resolves LATE and writes the
  // primary again. Before the fix that late write collapsed the set to one clip.
  it("keeps all N members when a late primary-set targets a set member", async () => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const doc = iframe.contentDocument!;
    for (const id of ["a", "b", "c"]) {
      const el = doc.createElement("div");
      el.id = id;
      doc.body.append(el);
    }

    const store = usePlayerStore.getState();
    // Marquee end state: primary written first, then the full set (real ordering).
    store.setSelectedElementId("a");
    store.setSelectedElementIds(new Set(["a", "b", "c"]));

    const harness = renderHarness({
      setRightPanelTab: vi.fn(),
      iframe,
      timelineElements: [timelineEl("a"), timelineEl("b"), timelineEl("c")],
      // Wire the real store write so applyDomSelection's collapse decision is exercised.
      setSelectedTimelineElementId: usePlayerStore.getState().setSelectedElementId,
    });

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = harness.current().handleTimelineElementSelect(timelineEl("a"));
    });
    await act(async () => {
      deferreds.get("a")?.resolve();
      await pending;
    });

    expect(usePlayerStore.getState().selectedElementIds.size).toBe(3);
    expect(usePlayerStore.getState().selectedElementId).toBe("a");
    harness.cleanup();
    iframe.remove();
  });

  it("collapses the set to a fresh single-click target instead of publishing an empty set", async () => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const doc = iframe.contentDocument!;
    for (const id of ["a", "b", "d"]) {
      const el = doc.createElement("div");
      el.id = id;
      doc.body.append(el);
    }

    const store = usePlayerStore.getState();
    // Stale set left over from a previous gesture.
    store.setSelectedElementId("a");
    store.setSelectedElementIds(new Set(["a", "b"]));

    const harness = renderHarness({
      setRightPanelTab: vi.fn(),
      iframe,
      timelineElements: [timelineEl("a"), timelineEl("b"), timelineEl("d")],
      setSelectedTimelineElementId: usePlayerStore.getState().setSelectedElementId,
    });

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = harness.current().handleTimelineElementSelect(timelineEl("d"));
    });
    await act(async () => {
      deferreds.get("d")?.resolve();
      await pending;
    });

    expect([...usePlayerStore.getState().selectedElementIds]).toEqual(["d"]);
    expect(usePlayerStore.getState().selectedElementId).toBe("d");
    harness.cleanup();
    iframe.remove();
  });
});

describe.each(["single", "group"] as const)("useDomSelection — %s refresh ownership", (kind) => {
  beforeEach(() => deferreds.clear());
  afterEach(() => deferreds.clear());

  function setup(beforeRefresh?: "select" | "clear" | "recreate") {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const doc = iframe.contentDocument!;
    doc.body.innerHTML = '<div id="a"></div><div id="b"></div><div id="c"></div>';
    const selections = ["a", "b", "c"].map(id => makeSelection(id, doc.getElementById(id)!));
    const setTimelineSelectionSet = vi.fn();
    const harness = renderHarness({
      iframe, timelineElements: [], setRightPanelTab: vi.fn(), setTimelineSelectionSet,
    });
    act(() => {
      if (kind === "group") harness.current().applyMarqueeSelection(selections.slice(0, 2), false);
      else harness.current().applyDomSelection(selections[0]);
    });
    if (beforeRefresh === "select") {
      act(() => {
        if (kind === "group") {
          harness.current().applyMarqueeSelection([selections[0], selections[2]], false);
        } else harness.current().applyDomSelection(selections[2]);
      });
    }
    if (beforeRefresh === "clear") act(() => harness.current().clearDomSelection());
    if (beforeRefresh === "recreate") {
      doc.body.innerHTML = '<div id="a"></div><div id="b"></div><div id="c"></div>';
    }
    const pending = kind === "group"
      ? harness.current().refreshDomEditGroupSelectionsFromPreview(selections.slice(0, 2))
      : harness.current().refreshDomEditSelectionFromPreview(selections[0]);
    const complete = async () => {
      await act(async () => {
        deferreds.get("a")?.resolve();
        await Promise.resolve();
        deferreds.get("b")?.resolve();
        await pending;
      });
    };
    return { harness, iframe, selections, complete, setTimelineSelectionSet };
  }

  it("publishes a refreshed selection when ownership has not changed", async () => {
    const h = setup();
    try {
      const original = h.harness.current().domEditSelection;
      await h.complete();
      expect(h.harness.current().domEditSelection?.id).toBe("a");
      expect(h.harness.current().domEditSelection).not.toBe(original);
      expect(h.harness.current().domEditGroupSelections).toHaveLength(kind === "group" ? 2 : 1);
    } finally { h.harness.cleanup(); h.iframe.remove(); }
  });

  it.each(["select", "clear"] as const)(
    "refuses a stale save refresh requested after %s has already changed the selection",
    async change => {
      const h = setup(change);
      try {
        const selected = h.harness.current().domEditSelectionRef.current;
        const group = h.harness.current().domEditGroupSelectionsRef.current;
        h.setTimelineSelectionSet.mockClear();
        await h.complete();
        expect(h.harness.current().domEditSelectionRef.current).toBe(selected);
        expect(h.harness.current().domEditGroupSelectionsRef.current).toBe(group);
        expect(h.setTimelineSelectionSet).not.toHaveBeenCalled();
      } finally { h.harness.cleanup(); h.iframe.remove(); }
    },
  );

  it("refreshes the current targets after their DOM nodes have been recreated", async () => {
    const h = setup("recreate");
    try {
      await h.complete();
      expect(h.harness.current().domEditSelection?.element)
        .toBe(h.iframe.contentDocument!.getElementById("a"));
      expect(h.harness.current().domEditSelection?.element).not.toBe(h.selections[0].element);
      expect(h.harness.current().domEditGroupSelections).toHaveLength(kind === "group" ? 2 : 1);
    } finally { h.harness.cleanup(); h.iframe.remove(); }
  });

  it.each(["select", "clear", "project", "document", "unmount"] as const)(
    "does not publish the pending refresh after %s supersedes it",
    async change => {
      const h = setup();
      try {
        if (change === "select") act(() => h.harness.current().applyDomSelection(h.selections[2]));
        if (change === "clear") act(() => h.harness.current().clearDomSelection());
        if (change === "project") h.harness.rerender({ projectId: "project-2" });
        if (change === "document") {
          Object.defineProperty(h.iframe, "contentDocument", {
            configurable: true, value: document.implementation.createHTMLDocument("replacement"),
          });
        }
        if (change === "unmount") h.harness.cleanup();
        h.setTimelineSelectionSet.mockClear();
        const currentSelection = h.harness.current().domEditSelectionRef.current;
        const currentGroup = h.harness.current().domEditGroupSelectionsRef.current;
        await h.complete();
        expect(h.harness.current().domEditSelectionRef.current).toBe(currentSelection);
        expect(h.harness.current().domEditGroupSelectionsRef.current).toBe(currentGroup);
        expect(h.setTimelineSelectionSet).not.toHaveBeenCalled();
      } finally { h.harness.cleanup(); h.iframe.remove(); }
    },
  );
});

describe("useDomSelection — picking a clip with no canvas node", () => {
  function timelineEl(id: string): TimelineElement {
    return { id, domId: id, tag: "div", start: 0, duration: 1, track: 0 };
  }

  it("drops the canvas selection without deselecting the clip", async () => {
    // Delete acts on the canvas first, so a canvas selection left pointing at
    // the previous element removed THAT element when the user pressed Delete
    // right after picking an audio clip. Clearing it has to stay quiet, though:
    // announcing the clear back would deselect the clip that was just picked.
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const doc = iframe.contentDocument!;
    const onCanvas = doc.createElement("div");
    onCanvas.id = "on-canvas";
    doc.body.append(onCanvas);

    const setSelectedTimelineElementId = vi.fn();
    const setTimelineSelectionSet = vi.fn();
    const harness = renderHarness({
      setRightPanelTab: vi.fn(),
      iframe,
      timelineElements: [timelineEl("on-canvas"), timelineEl("audio-only")],
      setSelectedTimelineElementId,
      setTimelineSelectionSet,
    });

    await act(async () => {
      const pending = harness.current().handleTimelineElementSelect(timelineEl("on-canvas"));
      deferreds.get("on-canvas")?.resolve();
      await pending;
    });
    expect(harness.current().domEditSelectionRef.current).not.toBeNull();

    setSelectedTimelineElementId.mockClear();
    setTimelineSelectionSet.mockClear();
    await act(async () => {
      await harness.current().handleTimelineElementSelect(timelineEl("audio-only"));
    });

    expect(harness.current().domEditSelectionRef.current).toBeNull();
    expect(setSelectedTimelineElementId).not.toHaveBeenCalled();
    expect(setTimelineSelectionSet).not.toHaveBeenCalled();

    harness.cleanup();
  });
});
