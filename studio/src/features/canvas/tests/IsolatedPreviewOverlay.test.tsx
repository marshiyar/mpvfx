// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { PreviewElementState } from "../../../../shared/preview/agentProtocol";
import { IsolatedPreviewOverlay } from "../IsolatedPreviewOverlay";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  commitGesture: vi.fn(async () => true),
  selection: vi.fn(),
  read: vi.fn(),
  hit: vi.fn(),
}));
vi.mock("../../../app/StudioContext", () => ({ useStudioShellContext: () => ({ activeCompPath: "index.html" }) }));
vi.mock("../DomEditContext", () => ({ useDomEditActionsContext: () => ({
  nativeDocument: null, commitRemoteGsapCanvasGesture: mocks.commitGesture,
}) }));
vi.mock("../../../player/index", () => ({ usePlayerStore: Object.assign(
  (select: (state: object) => unknown) => select({ currentTime: 0, isPlaying: false }),
  { getState: () => ({ elements: [], setSelection: mocks.selection }) },
) }));
vi.mock("../../preview/previewAgentClient", () => ({
  previewAgentForIframe: () => ({ isReady: true, onReady: () => () => {},
    request: mocks.read, hitTestAtClientPoint: mocks.hit }),
  previewRectToClient: (_frame: HTMLIFrameElement, rect: object) => rect,
  clientPointToPreview: (_frame: HTMLIFrameElement, x: number, y: number) => ({ x, y }),
}));

const layer: PreviewElementState = {
  handle: "e3", tag: "div", id: "authored", className: "", text: "", textEditable: false,
  rect: { x: 20, y: 20, width: 100, height: 80 }, visible: true, parent: null,
  sourceFile: "index.html", compositionPath: "index.html",
  dataAttributes: { "hf-id": "hf-authored" },
  inlineStyles: { left: "20px", top: "20px", width: "100px", height: "80px" },
  computedStyles: { width: "100px", height: "80px", transform: "none", "clip-path": "none" },
};

function pointer(node: Element, type: string, x: number, y: number) {
  const event = new PointerEvent(type, { bubbles: true, button: 0, clientX: x,
    clientY: y, pointerId: 7 });
  act(() => node.dispatchEvent(event));
}

async function mount(state: PreviewElementState = layer) {
  mocks.read.mockImplementation(async (request: { kind: string }) => request.kind === "snapshot" ? [state] : state);
  mocks.hit.mockResolvedValue(state);
  const frame = document.createElement("iframe");
  Object.defineProperty(frame, "contentDocument", { value: null, configurable: true });
  Object.defineProperty(frame, "clientWidth", { value: 400, configurable: true });
  Object.defineProperty(frame, "clientHeight", { value: 300, configurable: true });
  frame.getBoundingClientRect = () => ({ x: 0, y: 0, width: 400, height: 300,
    top: 0, left: 0, right: 400, bottom: 300, toJSON: () => ({}) });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<IsolatedPreviewOverlay iframeRef={{ current: frame }} enabled />));
  const canvas = host.querySelector<HTMLElement>('[aria-label="Isolated composition canvas"]')!;
  canvas.setPointerCapture = vi.fn();
  pointer(canvas, "pointerdown", 40, 40);
  pointer(canvas, "pointerup", 40, 40);
  await act(async () => { await Promise.resolve(); });
  return { host, root };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

it("selects an exact legacy source and sends a bounded move gesture", async () => {
  const { host, root } = await mount();
  const selected = host.querySelector<HTMLElement>('[data-testid="isolated-preview-selection"]')!;
  expect(selected).toBeTruthy();
  selected.setPointerCapture = vi.fn();
  pointer(selected, "pointerdown", 40, 40);
  pointer(selected, "pointermove", 55, 35);
  pointer(selected, "pointerup", 55, 35);
  await act(async () => { await Promise.resolve(); });
  expect(mocks.commitGesture).toHaveBeenCalledExactlyOnceWith(layer,
    { mode: "move", delta: { x: 15, y: -5 } });
  act(() => root.unmount());
});

it("does not create a move edit for a selection click without movement", async () => {
  const { host, root } = await mount();
  const selected = host.querySelector<HTMLElement>('[data-testid="isolated-preview-selection"]')!;
  selected.setPointerCapture = vi.fn();
  pointer(selected, "pointerdown", 40, 40);
  pointer(selected, "pointerup", 40, 40);
  await act(async () => { await Promise.resolve(); });
  expect(mocks.commitGesture).not.toHaveBeenCalled();
  act(() => root.unmount());
});

it("routes legacy source-box resize and base rotation through the strict gesture action", async () => {
  const first = await mount();
  const resize = first.host.querySelector<HTMLButtonElement>('[data-testid="isolated-preview-resize"]')!;
  expect(resize.disabled).toBe(false);
  resize.setPointerCapture = vi.fn();
  pointer(resize, "pointerdown", 120, 100);
  pointer(resize, "pointermove", 140, 110);
  pointer(resize, "pointerup", 140, 110);
  await act(async () => { await Promise.resolve(); });
  expect(mocks.commitGesture).toHaveBeenCalledExactlyOnceWith(layer,
    { mode: "resize", width: 120, height: 90 });
  act(() => first.root.unmount());

  mocks.commitGesture.mockClear();
  const second = await mount();
  const rotate = second.host.querySelector<HTMLButtonElement>('[data-testid="isolated-preview-rotate"]')!;
  expect(rotate.disabled).toBe(false);
  rotate.setPointerCapture = vi.fn();
  pointer(rotate, "pointerdown", 70, 0);
  pointer(rotate, "pointermove", 130, 60);
  pointer(rotate, "pointerup", 130, 60);
  await act(async () => { await Promise.resolve(); });
  expect(mocks.commitGesture).toHaveBeenCalledExactlyOnceWith(layer,
    { mode: "rotate", deltaDegrees: 90 });
  act(() => second.root.unmount());
});

it("shows an authored-animation refusal when legacy position is not explicit", async () => {
  const { host, root } = await mount({ ...layer, inlineStyles: { width: "100px", height: "80px" } });
  const selected = host.querySelector<HTMLElement>('[data-testid="isolated-preview-selection"]')!;
  expect(selected.className).toContain("cursor-default");
  expect(host.querySelector<HTMLButtonElement>('[data-testid="isolated-preview-rotate"]')?.disabled).toBe(true);
  expect(host.querySelector<HTMLButtonElement>('[data-testid="isolated-preview-resize"]')?.disabled).toBe(true);
  selected.setPointerCapture = vi.fn();
  pointer(selected, "pointerdown", 40, 40);
  pointer(selected, "pointerup", 60, 40);
  expect(mocks.commitGesture).not.toHaveBeenCalled();
  act(() => root.unmount());
});
