// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreviewElementState } from "../../../../shared/preview/agentProtocol";
import { installReactActEnvironment } from "../domSelectionTestHarness";

installReactActEnvironment();
const request = vi.fn();
vi.mock("../../preview/previewAgentClient", async importOriginal => ({
  ...(await importOriginal<typeof import("../../preview/previewAgentClient")>()),
  previewAgentForIframe: () => ({ isReady: true, request }),
}));
const { useDomSelection } = await import("../useDomSelection");
const state: PreviewElementState = {
  handle: "e1", tag: "div", id: "card", className: "", text: "Hello", textEditable: true,
  rect: { x: 0, y: 0, width: 100, height: 40 }, visible: true, parent: null,
  sourceFile: "index.html", compositionPath: "index.html",
  dataAttributes: { "studio-clip-id": "clip" }, inlineStyles: {}, computedStyles: {},
};
afterEach(() => { request.mockReset(); document.body.replaceChildren(); });

describe("isolated preview selection", () => {
  it("re-reads the exact frame handle, keeps it separate from HTMLElement selection, and revokes it on load", async () => {
    const frame = document.createElement("iframe");
    const other = document.createElement("iframe");
    document.body.append(frame, other);
    const frameRef = { current: frame };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let hook: ReturnType<typeof useDomSelection> | null = null;
    const setRightCollapsed = vi.fn();
    function Probe() {
      hook = useDomSelection({ projectId: "project", activeCompPath: "index.html", isMasterView: true,
        compIdToSrc: new Map(), captionEditMode: false, previewIframeRef: frameRef,
        timelineElements: [], getTimelineSelectionSet: () => new Set(),
        setSelectedTimelineElementId: vi.fn(), setTimelineSelectionSet: vi.fn(),
        setRightCollapsed, setRightPanelTab: vi.fn(), previewIframe: frame, refreshKey: 0 });
      return null;
    }
    act(() => root.render(React.createElement(Probe)));
    request.mockResolvedValue(state);
    await act(async () => {
      window.dispatchEvent(new CustomEvent("mpvfx-isolated-preview-selection", { detail: { iframe: other, state } }));
    });
    expect(request).not.toHaveBeenCalled();
    await act(async () => {
      window.dispatchEvent(new CustomEvent("mpvfx-isolated-preview-selection", { detail: { iframe: frame, state } }));
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(request).toHaveBeenCalledWith({ kind: "readElement", handle: "e1" });
    expect(hook!.remoteSelection).toEqual(state);
    expect(hook!.domEditSelection).toBeNull();
    act(() => frame.dispatchEvent(new Event("load")));
    expect(hook!.remoteSelection).toBeNull();
    act(() => root.unmount());
  });
});
