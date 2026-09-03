// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeyframeEaseList } from "./KeyframeEaseList";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

describe("KeyframeEaseList", () => {
  it("only exposes easing controls for incoming segments, named by their destination keyframe", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        <KeyframeEaseList
          keyframes={[
            { percentage: 0, properties: { opacity: 0 } },
            { percentage: 50, properties: { opacity: 0.5 } },
            { percentage: 100, properties: { opacity: 1 } },
          ]}
          globalEase="none"
          expandedPct={null}
          onToggle={vi.fn()}
          onEaseCommit={vi.fn()}
        />,
      ),
    );

    expect(host.textContent).toContain("Incoming segment easing");
    expect(host.querySelector('[aria-label="Edit easing for segment 0% to 50%, ending at 50% keyframe"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Edit easing for segment 50% to 100%, ending at 100% keyframe"]')).not.toBeNull();
    expect(host.querySelector('[aria-label*="ending at 0% keyframe"]')).toBeNull();

    act(() => root.unmount());
    host.remove();
  });
});
