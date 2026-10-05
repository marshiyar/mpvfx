// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import type { PreviewElementState } from "../../../../shared/preview/agentProtocol";
import { previewOriginForProject } from "../../../../shared/desktopPreviewOrigin";
import type { TimelineStackingReorderIntent } from "../../../player/components/timelineStacking";
import { applyRemoteTimelineStackingReorder } from "../remoteTimelineStackingReorder";

const mocks = vi.hoisted(() => ({ previewAgentForIframe: vi.fn(), commitRemoteStackingBatch: vi.fn() }));
vi.mock("../../preview/previewAgentClient", () => ({ previewAgentForIframe: mocks.previewAgentForIframe }));
vi.mock("../../canvas/remoteStackingBatchTransaction", () => ({ commitRemoteStackingBatch: mocks.commitRemoteStackingBatch }));

const state: PreviewElementState = {
  handle: "e1", tag: "div", id: "card", className: "", text: "", textEditable: false,
  rect: { x: 0, y: 0, width: 20, height: 20 }, visible: true, parent: null,
  sourceFile: "index.html", compositionPath: "index.html",
  dataAttributes: { "studio-clip-id": "clip-card", "hf-id": "hf-card" },
  inlineStyles: {}, computedStyles: { "z-index": "0" },
};
const intent: TimelineStackingReorderIntent = {
  contextKey: "root", placement: { kind: "above", targetKey: "other" } as TimelineStackingReorderIntent["placement"],
  zIndexChanges: [{ key: "card-key", zIndex: 4, domId: "card", sourceFile: "index.html" }],
};
function input(iframe: HTMLIFrameElement) {
  return { iframe, projectId: "demo", intent, activeCompPath: "index.html", coalesceKey: "timeline-move:hf-card",
    timelineElements: [{ id: "card", key: "card-key", domId: "card", hfId: "hf-card", tag: "div",
      sourceFile: "index.html", start: 0, duration: 2, track: 0 }],
    deps: {} as Parameters<typeof applyRemoteTimelineStackingReorder>[0]["deps"] };
}

describe("isolated single-clip lane reorder", () => {
  it("resolves a fresh exact source/native identity before one batch commit", async () => {
    const iframe = document.createElement("iframe");
    iframe.src = `${previewOriginForProject("demo")}/api/projects/demo/preview/index.html`;
    mocks.previewAgentForIframe.mockReturnValue({ isReady: true, request: vi.fn(async () => [state]) });
    mocks.commitRemoteStackingBatch.mockResolvedValue(true);
    expect(await applyRemoteTimelineStackingReorder(input(iframe))).toBe(true);
    expect(mocks.commitRemoteStackingBatch).toHaveBeenCalledWith(
      [{ state, zIndex: 4 }], "timeline-move:hf-card", input(iframe).deps,
    );
  });

  it("rejects a wrong project and ambiguous preview identity before any commit", async () => {
    const iframe = document.createElement("iframe");
    iframe.src = `${previewOriginForProject("other")}/api/projects/other/preview/index.html`;
    mocks.commitRemoteStackingBatch.mockClear();
    await expect(applyRemoteTimelineStackingReorder(input(iframe))).rejects.toThrow(/no longer belongs/);
    iframe.src = `${previewOriginForProject("demo")}/api/projects/demo/preview/index.html`;
    mocks.previewAgentForIframe.mockReturnValue({ isReady: true, request: vi.fn(async () => [state, state]) });
    await expect(applyRemoteTimelineStackingReorder(input(iframe))).rejects.toThrow(/uniquely/);
    expect(mocks.commitRemoteStackingBatch).not.toHaveBeenCalled();
  });
});
