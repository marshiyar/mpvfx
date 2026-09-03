// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StudioRightPanelTabs, StudioRightSidebarRail } from "./StudioRightSidebarChrome";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

describe("right sidebar chrome", () => {
  it("puts Hide sidebar immediately before Design", () => {
    const onHide = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <StudioRightPanelTabs
          designActive
          rendersActive={false}
          rendersLabel="Renders"
          onHide={onHide}
          onDesign={vi.fn()}
          onRenders={vi.fn()}
        />,
      );
    });

    const buttons = Array.from(host.querySelectorAll("button"));
    expect(buttons.map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual([
      "Hide sidebar",
      "Design",
      "Renders",
    ]);
    expect(host.textContent).not.toContain("Layers");
    act(() => buttons[0]?.click());
    expect(onHide).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it("keeps a mirrored Show sidebar rail after the right pane is collapsed", () => {
    const onShow = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(<StudioRightSidebarRail onShow={onShow} />));

    const button = host.querySelector<HTMLButtonElement>('button[aria-label="Show sidebar"]');
    expect(button).not.toBeNull();
    act(() => button?.click());
    expect(onShow).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });
});
