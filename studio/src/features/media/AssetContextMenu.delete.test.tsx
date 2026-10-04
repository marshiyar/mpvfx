// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ContextMenu } from "./AssetContextMenu";
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

it.each([false, true])("requires explicit placement-removal selection: %s", removePlacements => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const onDelete = vi.fn();
  try {
    act(() => root.render(<ContextMenu x={0} y={0} asset="media/example.jpg" onClose={vi.fn()} onCopy={vi.fn()} onDelete={onDelete} />));
    const deleteButton = () => [...host.querySelectorAll("button")].find(button => button.textContent?.trim() === "Delete")!;
    act(() => deleteButton().click());
    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox.checked).toBe(false);
    expect(onDelete).not.toHaveBeenCalled();
    if (removePlacements) act(() => checkbox.click());
    act(() => deleteButton().click());
    expect(onDelete).toHaveBeenCalledExactlyOnceWith("media/example.jpg", removePlacements);
  } finally { act(() => root.unmount()); host.remove(); }
});
