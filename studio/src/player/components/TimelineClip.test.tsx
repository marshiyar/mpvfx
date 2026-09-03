// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TimelineElement } from "../store/playerStore";
import { TimelineClip } from "./TimelineClip";
import type { TimelineEditCapabilities } from "./timelineEditing";

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  value: true,
});

afterEach(() => {
  document.body.innerHTML = "";
});

const capabilities: TimelineEditCapabilities = {
  canMove: true,
  canTrimStart: true,
  canTrimEnd: true,
};

function renderClip({
  element,
  pps = 100,
  isSelected = false,
  hasCustomContent = true,
}: {
  element: TimelineElement;
  pps?: number;
  isSelected?: boolean;
  hasCustomContent?: boolean;
}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onClick = vi.fn();

  act(() => {
    root.render(
      <TimelineClip
        el={element}
        pps={pps}
        clipY={0}
        isSelected={isSelected}
        isHovered={false}
        hasCustomContent={hasCustomContent}
        capabilities={capabilities}
        isComposition={false}
        onHoverStart={vi.fn()}
        onHoverEnd={vi.fn()}
        onClick={onClick}
        onDoubleClick={vi.fn()}
      >
        <div data-custom-content="true" />
      </TimelineClip>,
    );
  });

  return { host, onClick, root };
}

describe("TimelineClip", () => {
  it("squares only the leading corners of media that starts at the timeline origin", () => {
    const { host, root } = renderClip({
      element: { id: "media", label: "Media", tag: "video", start: 0, duration: 2, track: 0 },
    });
    const clip = host.querySelector<HTMLElement>(".timeline-clip");

    expect(clip?.style.borderTopLeftRadius).toBe("0px");
    expect(clip?.style.borderBottomLeftRadius).toBe("0px");
    expect(clip?.style.borderTopRightRadius).toBe("3px");
    expect(clip?.style.borderBottomRightRadius).toBe("3px");

    act(() => root.unmount());
  });

  it("keeps all four compact corners on media that starts after the origin", () => {
    const { host, root } = renderClip({
      element: { id: "later", label: "Later", tag: "video", start: 1, duration: 2, track: 0 },
    });
    const clip = host.querySelector<HTMLElement>(".timeline-clip");

    expect(clip?.style.borderTopLeftRadius).toBe("3px");
    expect(clip?.style.borderBottomLeftRadius).toBe("3px");
    expect(clip?.style.borderTopRightRadius).toBe("3px");
    expect(clip?.style.borderBottomRightRadius).toBe("3px");

    act(() => root.unmount());
  });

  it("treats a subpixel start offset as visually joined to the origin", () => {
    const { host, root } = renderClip({
      element: {
        id: "near-zero",
        label: "Near zero",
        tag: "video",
        start: 0.06,
        duration: 2,
        track: 0,
      },
      pps: 20,
    });

    expect(
      host.querySelector<HTMLElement>(".timeline-clip")?.style.borderTopLeftRadius,
    ).toBe("0px");

    act(() => root.unmount());
  });

  it("renders the clip label above custom content without showing default timecode", () => {
    const { host, root } = renderClip({
      element: { id: "hero", label: "Hero", tag: "div", start: 1, duration: 0.5, track: 0 },
    });

    expect(host.querySelector(".timeline-clip__label")?.textContent).toBe("Hero");
    expect(host.querySelector(".timeline-clip__timecode")).toBeNull();

    act(() => root.unmount());
  });

  it("caps visible thumbnail text while preserving the full accessible name", () => {
    const label = "A very long imported media filename that should not flood the thumbnail";
    const { host, root } = renderClip({
      element: { id: "long", label, tag: "video", start: 0, duration: 4, track: 0 },
    });

    const clip = host.querySelector<HTMLButtonElement>(".timeline-clip")!;
    const visibleLabel = host.querySelector(".timeline-clip__label")?.textContent ?? "";
    expect(visibleLabel).toBe("A very long imported me…");
    expect(visibleLabel).toHaveLength(24);
    expect(clip.getAttribute("aria-label")).toContain(label);
    expect(clip.title).toContain(label);
    act(() => root.unmount());
  });

  it("keeps selected narrow clips labeled even when they render custom content", () => {
    const { host, root } = renderClip({
      element: { id: "fx", label: "FX", tag: "div", start: 0, duration: 0.1, track: 0 },
      isSelected: true,
    });

    expect(host.querySelector(".timeline-clip__label")?.textContent).toBe("FX");
    expect(host.querySelector(".timeline-clip__timecode")).toBeNull();

    act(() => root.unmount());
  });

  it("marks hidden clips for active-state suppression", () => {
    const { host, root } = renderClip({
      element: {
        id: "hidden",
        label: "Hidden",
        tag: "div",
        start: 0,
        duration: 1,
        track: 0,
        hidden: true,
      },
    });

    expect(host.querySelector(".timeline-clip")?.getAttribute("data-clip-hidden")).toBe("true");

    act(() => root.unmount());
  });

  it("applies selected styling when rendered as selected", () => {
    const { host, root } = renderClip({
      element: { id: "selected", label: "Selected", tag: "div", start: 0, duration: 1, track: 0 },
      isSelected: true,
    });

    expect(host.querySelector(".timeline-clip")?.classList.contains("is-selected")).toBe(true);

    act(() => root.unmount());
  });

  it("gives video the same borderless strip shell as image media", () => {
    const video = renderClip({
      element: { id: "video", label: "Video", tag: "video", start: 0, duration: 2, track: 0 },
    });
    const image = renderClip({
      element: { id: "image", label: "Image", tag: "img", start: 0, duration: 2, track: 1 },
    });

    expect(video.host.querySelector<HTMLElement>(".timeline-clip")?.style.border).toBe("0px");
    expect(image.host.querySelector<HTMLElement>(".timeline-clip")?.style.border).toBe("0px");

    act(() => video.root.unmount());
    act(() => image.root.unmount());
  });

  it("is a roving native button with explicit selection semantics", () => {
    const { host, onClick, root } = renderClip({
      element: { id: "hero", label: "Hero", tag: "div", start: 1, duration: 2, track: 0 },
      isSelected: true,
    });
    const clip = host.querySelector<HTMLButtonElement>(".timeline-clip")!;
    expect(clip.type).toBe("button");
    expect(clip.tabIndex).toBe(-1);
    expect(clip.getAttribute("aria-pressed")).toBe("true");
    act(() => clip.click());
    expect(onClick).toHaveBeenCalledOnce();
    act(() => root.unmount());
  });
});
