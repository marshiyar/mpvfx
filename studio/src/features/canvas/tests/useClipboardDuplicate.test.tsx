// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { usePlayerStore } from "../../../player/index";
import { useClipboard } from "../useClipboard";

const native = vi.hoisted(() => ({
  capture: vi.fn((html: string) => ({ copiedHtml: html })),
  paste: vi.fn(async (_input: unknown) => {}),
}));
vi.mock("../nativeClipboard", () => ({
  captureNativeClipboard: native.capture,
  pasteNativeClipboard: native.paste,
}));

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterEach(() => {
  usePlayerStore.getState().reset();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

it("duplicates the selected clip after its end without replacing the copied clip", async () => {
  const preview = document.createElement("iframe");
  document.body.append(preview);
  preview.contentDocument!.body.innerHTML = `<main data-composition-id="main">
    <video id="first" data-hf-id="hf-first" data-start="1" data-duration="3"></video>
    <video id="second" data-hf-id="hf-second" data-start="10" data-duration="4"></video>
  </main>`;
  const clips = [
    { id: "first", key: "first", domId: "first", hfId: "hf-first", sourceFile: "index.html", tag: "video", start: 1, duration: 3, track: 0 },
    { id: "second", key: "second", domId: "second", hfId: "hf-second", sourceFile: "index.html", tag: "video", start: 10, duration: 4, track: 0 },
  ];
  usePlayerStore.setState({ elements: clips, selectedElementId: "first", selectedElementIds: new Set(["first"]) });

  let clipboard!: ReturnType<typeof useClipboard>;
  const Probe = () => {
    clipboard = useClipboard({
      projectId: "p1", activeCompPath: "index.html",
      domEditSelectionRef: { current: null }, previewIframeRef: { current: preview },
      showToast: vi.fn(), writeProjectFile: vi.fn(async () => {}),
      recordEdit: vi.fn(async () => {}), domEditSaveTimestampRef: { current: 0 },
      reloadPreview: vi.fn(), handleTimelineElementDelete: vi.fn(async () => {}),
      handleDomEditElementDelete: vi.fn(async () => {}),
      nativeProjectEditing: { nativeDocument: {} } as NonNullable<Parameters<typeof useClipboard>[0]["nativeProjectEditing"]>,
    });
    return null;
  };
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  expect(clipboard.handleCopy()).toBe(true);

  // A marquee selection can have a sole selected key without a primary ID.
  usePlayerStore.setState({ selectedElementId: null, selectedElementIds: new Set(["second"]) });
  await act(async () => expect(clipboard.handleDuplicate()).toBe(true));
  expect(native.paste).toHaveBeenCalledTimes(1);
  expect(native.paste.mock.calls[0]![0]).toMatchObject({
    playhead: 14,
    payload: { kind: "timeline-clip", html: expect.stringContaining('id="second"') },
  });

  await act(async () => clipboard.handlePaste());
  expect(native.paste).toHaveBeenCalledTimes(2);
  expect(native.paste.mock.calls[1]![0]).toMatchObject({
    payload: { kind: "timeline-clip", html: expect.stringContaining('id="first"') },
  });
  usePlayerStore.setState({ selectedElementIds: new Set(["first", "second"]) });
  expect(clipboard.handleDuplicate()).toBe(false);
  expect(native.paste).toHaveBeenCalledTimes(2);
  await act(async () => root.unmount());
});
