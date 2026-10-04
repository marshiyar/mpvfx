// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimelineEmptyState } from "../TimelineEmptyState";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

function renderEmptyState(onFileDrop: boolean): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <TimelineEmptyState
        isDragOver={false}
        onFileDrop={onFileDrop}
        onDragOver={vi.fn()}
        onDragLeave={vi.fn()}
        onDrop={vi.fn()}
      />,
    );
  });
  return host;
}

describe("TimelineEmptyState", () => {
  it("starts a media-first editing workflow when file drop is available", () => {
    const host = renderEmptyState(true);

    expect(host.textContent).toContain("Drop video, audio, or images here to start editing");
    expect(host.textContent?.toLowerCase()).not.toContain("describe");
    expect(host.textContent?.toLowerCase()).not.toContain("composition");
  });

  it("uses editor language even when direct file drop is unavailable", () => {
    const host = renderEmptyState(false);

    expect(host.textContent).toContain("Import media to start editing");
    expect(host.textContent?.toLowerCase()).not.toContain("describe");
  });

  it("keeps the prompt target stable across dragover, leave, and reentry", () => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const onDragOver = vi.fn();
    const onDragLeave = vi.fn();
    const onDrop = vi.fn();
    const render = (isDragOver: boolean) => {
      act(() => root?.render(
        <TimelineEmptyState
          isDragOver={isDragOver}
          onFileDrop
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        />,
      ));
    };

    render(false);
    const prompt = [...host.querySelectorAll("span")].find((span) =>
      span.textContent?.includes("Drop video, audio, or images here"),
    );
    const icon = prompt?.previousElementSibling;
    const iconChildren = [...(icon?.children ?? [])];
    expect(prompt).toBeDefined();
    expect(iconChildren).toHaveLength(4);

    for (const hovering of [true, false, true]) {
      render(hovering);
      expect(prompt?.isConnected).toBe(true);
      expect(prompt?.previousElementSibling).toBe(icon);
      expect([...icon!.children]).toEqual(iconChildren);
      expect(prompt?.textContent).toContain("Drop video, audio, or images here");
    }

    act(() => prompt?.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true })));
    act(() => prompt?.dispatchEvent(new Event("dragleave", { bubbles: true })));
    act(() => prompt?.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true })));
    expect(onDragOver).toHaveBeenCalledOnce();
    expect(onDragLeave).toHaveBeenCalledOnce();
    expect(onDrop).toHaveBeenCalledOnce();
  });
});
