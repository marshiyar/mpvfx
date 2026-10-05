// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { PreviewElementState } from "../../../../shared/preview/agentProtocol";
import { IsolatedPreviewCropHandles } from "../IsolatedPreviewCropHandles";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const request = vi.hoisted(() => vi.fn(async () => null));
vi.mock("../../preview/previewAgentClient", () => ({ previewAgentForIframe: () => ({ request }) }));

const selection: PreviewElementState = {
  handle: "e1", tag: "video", id: "clip", className: "", text: "",
  rect: { x: 0, y: 0, width: 100, height: 100 }, visible: true, textEditable: false, parent: null,
  sourceFile: "index.html", compositionPath: "index.html",
  dataAttributes: { "studio-clip-id": "clip" }, inlineStyles: {},
  computedStyles: { width: "100px", height: "100px", "clip-path": "none" },
};

afterEach(() => { document.body.innerHTML = ""; request.mockClear(); });

function pointer(node: Element, type: string, x: number, y = 0) {
  const event = new PointerEvent(type, { bubbles: true, button: 0, clientX: x,
    clientY: y, pointerId: 7 });
  act(() => node.dispatchEvent(event));
}

it("drafts a crop by handle and saves one strict source edit", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const commit = vi.fn(async () => true);
  act(() => root.render(<IsolatedPreviewCropHandles frame={document.createElement("iframe")}
    selection={selection} width={100} height={100} commit={commit} />));
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Crop selected layer"]')!.click());
  const left = host.querySelector<HTMLButtonElement>('[aria-label="Crop left edge"]')!;
  left.setPointerCapture = vi.fn();
  pointer(left, "pointerdown", 0);
  pointer(left, "pointermove", 20);
  pointer(left, "pointerup", 20);
  await act(async () => { await Promise.resolve(); });
  expect(request).toHaveBeenCalledWith({ kind: "setStyle", handle: "e1",
    property: "clip-path", value: "inset(0px 0px 0px 20px)" });
  expect(commit).toHaveBeenCalledExactlyOnceWith(selection,
    [{ type: "inline-style", property: "clip-path", value: "inset(0px 0px 0px 20px)" }], "Crop layer");
  act(() => root.unmount());
});

it("restores the exact empty inline style when a crop save fails", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const commit = vi.fn(async () => false);
  act(() => root.render(<IsolatedPreviewCropHandles frame={document.createElement("iframe")}
    selection={selection} width={100} height={100} commit={commit} />));
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Crop selected layer"]')!.click());
  const top = host.querySelector<HTMLButtonElement>('[aria-label="Crop top edge"]')!;
  top.setPointerCapture = vi.fn();
  pointer(top, "pointerdown", 0);
  pointer(top, "pointermove", 0, 10);
  pointer(top, "pointerup", 0, 10);
  await act(async () => { await Promise.resolve(); });
  expect(request).toHaveBeenLastCalledWith({ kind: "setStyle", handle: "e1",
    property: "clip-path", value: "" });
  act(() => root.unmount());
});
