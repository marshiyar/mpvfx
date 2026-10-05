// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreviewElementState, PreviewGsapObservation } from "../../../../shared/preview/agentProtocol";
import { mountReactHarness } from "../domSelectionTestHarness";
import { useRemoteSourceEdits } from "../useRemoteSourceEdits";

const spies = vi.hoisted(() => ({
  observeGsap: vi.fn(),
  loadRemoteGsapTargets: vi.fn(),
  commitRemoteGsapPropertyEdit: vi.fn(),
}));
vi.mock("../../preview/previewAgentClient", () => ({
  previewAgentForIframe: () => ({ isReady: true, observeGsap: spies.observeGsap }),
}));
vi.mock("../../animation/GSAP/remoteGsapSourceTransaction", () => ({
  loadRemoteGsapTargets: spies.loadRemoteGsapTargets,
  commitRemoteGsapPropertyEdit: spies.commitRemoteGsapPropertyEdit,
}));

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const state: PreviewElementState = {
  handle: "e1", tag: "div", id: "card", className: "", text: "Card", textEditable: true,
  rect: { x: 0, y: 0, width: 10, height: 10 }, visible: true, parent: null,
  sourceFile: "index.html", compositionPath: "index.html",
  dataAttributes: { "hf-id": "hf-card" }, inlineStyles: {}, computedStyles: {},
};
const observation: PreviewGsapObservation = {
  handle: "e1", id: "card", hfId: "hf-card", sourceFile: "index.html",
  compositionPath: "index.html", values: {}, tweens: [],
};

afterEach(() => {
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe("remote source edits from a master composition URL", () => {
  it("observes GSAP and scopes both list and commit to trusted index.html when comp is absent", async () => {
    spies.observeGsap.mockResolvedValue(observation);
    spies.loadRemoteGsapTargets.mockResolvedValue([{ id: "tween", label: "to #card", properties: { x: 10 } }]);
    spies.commitRemoteGsapPropertyEdit.mockResolvedValue(true);
    const reloadPreview = vi.fn();
    const iframe = document.createElement("iframe");
    const previewIframeRef = { current: iframe };
    let actions: ReturnType<typeof useRemoteSourceEdits> | null = null;
    function Probe() {
      actions = useRemoteSourceEdits({
        projectId: "project", activeCompPath: null, previewIframeRef,
        nativeProjectEditing: undefined,
        readProjectFile: vi.fn(async () => "<html></html>"),
        writeProjectFile: vi.fn(async () => {}),
        editHistory: { recordEdit: vi.fn(async () => {}) },
        domEditSaveTimestampRef: { current: 0 }, reloadPreview, showToast: vi.fn(),
      });
      return null;
    }
    const root = mountReactHarness(<Probe />);
    await act(async () => {
      expect(await actions!.loadRemoteGsapAnimations(state)).toHaveLength(1);
      expect(await actions!.commitRemoteGsapProperty(state,
        { animationId: "tween", property: "x", value: 20 })).toBe(true);
    });
    expect(spies.observeGsap).toHaveBeenCalledTimes(2);
    expect(spies.observeGsap).toHaveBeenCalledWith("e1", expect.any(Array));
    expect(spies.loadRemoteGsapTargets.mock.calls[0]?.[2].expectedSourceFile).toBe("index.html");
    expect(spies.commitRemoteGsapPropertyEdit.mock.calls[0]?.[3].expectedSourceFile).toBe("index.html");
    expect(reloadPreview).toHaveBeenCalledOnce();
    act(() => root.unmount());
  });
});
