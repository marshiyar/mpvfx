// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompositionsTab } from "./CompositionsTab";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
(
  window as unknown as { happyDOM: { settings: { disableIframePageLoading: boolean } } }
).happyDOM.settings.disableIframePageLoading = true;

let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function mount(
  props: Partial<React.ComponentProps<typeof CompositionsTab>> = {},
): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <CompositionsTab
        projectId="demo"
        compositions={["index.html", "compositions/intro.html", "compositions/outro.html"]}
        masterComposition="index.html"
        activeComposition={null}
        onSelect={vi.fn()}
        onRenderComposition={vi.fn()}
        onAddToTimeline={vi.fn()}
        onDeleteComposition={vi.fn()}
        {...props}
      />,
    );
  });
  return host;
}

describe("reusable scene actions", () => {
  it("does not expose the protected master timeline as a reusable scene", () => {
    const host = mount();

    expect(host.querySelector('[aria-label="Open composition index"]')).toBeNull();
    expect(host.querySelector('[aria-label="Add index to timeline at playhead"]')).toBeNull();
    expect(host.querySelector('[aria-label="Delete scene index"]')).toBeNull();
    expect(host.querySelector('[aria-label="Open composition intro"]')).not.toBeNull();
  });

  it("cannot drag or add the currently open scene into itself but can delete it", () => {
    const host = mount({ activeComposition: "compositions/intro.html" });
    const active = host.querySelector<HTMLElement>('[aria-label="Open composition intro"]');

    expect(active?.getAttribute("draggable")).toBe("false");
    expect(host.querySelector('[aria-label="Add intro to timeline at playhead"]')).toBeNull();
    expect(host.querySelector('[aria-label="Delete scene intro"]')).not.toBeNull();

    const other = host.querySelector<HTMLElement>('[aria-label="Open composition outro"]');
    expect(other?.getAttribute("draggable")).toBe("true");
    expect(host.querySelector('[aria-label="Add outro to timeline at playhead"]')).not.toBeNull();
  });

  it("labels the arrow as export and invokes the render workflow", () => {
    const onRenderComposition = vi.fn();
    const host = mount({ onRenderComposition });
    const exportButton = host.querySelector<HTMLButtonElement>(
      '[aria-label="Export scene intro"]',
    );
    if (!exportButton) throw new Error("export action did not render");

    act(() => exportButton.click());

    expect(onRenderComposition).toHaveBeenCalledWith("compositions/intro.html");
    expect(host.querySelector('[aria-label="Render intro"]')).toBeNull();
  });

  it("only deletes a reusable scene after explicit confirmation", () => {
    const onDeleteComposition = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const host = mount({ onDeleteComposition });
    const deleteButton = host.querySelector<HTMLButtonElement>('[aria-label="Delete scene intro"]');
    if (!deleteButton) throw new Error("delete action did not render");

    act(() => deleteButton.click());
    expect(onDeleteComposition).not.toHaveBeenCalled();

    act(() => deleteButton.click());
    expect(confirm).toHaveBeenCalledWith(
      "Delete the reusable scene ‘intro’? It will be moved to the recovery archive.",
    );
    expect(onDeleteComposition).toHaveBeenCalledWith("compositions/intro.html");
  });

  it("explains when a project has no reusable scenes", () => {
    const host = mount({ compositions: ["index.html"] });
    expect(host.textContent).toContain("No reusable scenes");
    expect(host.textContent).toContain("main timeline is protected");
  });
});
