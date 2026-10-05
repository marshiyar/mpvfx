// @vitest-environment happy-dom
import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { previewOriginForProject } from "../../../shared/desktopPreviewOrigin";
import { serializeNativeProjectDocument, type NativeProjectDocument } from "../../../shared/project/nativeProjectDocument";
import { useNativeProjectSession, type NativeProjectSessionState } from "./useNativeProjectSession";

const agent = vi.hoisted(() => ({
  request: vi.fn(async () => null),
  onReady: vi.fn((callback: () => void) => { callback(); return () => {}; }),
}));
vi.mock("../preview/previewAgentClient", () => ({
  attachPreviewAgent: vi.fn(() => ({ ...agent, isReady: true })),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots.length = 0;
  document.body.replaceChildren();
  agent.request.mockClear();
  agent.onReady.mockClear();
});

function nativeProject(): NativeProjectDocument {
  return {
    schemaVersion: 1,
    id: "native-id",
    revision: 2,
    frameRate: { numerator: 30000, denominator: 1001 },
    canvas: { width: 640, height: 360, background: "#000000" },
    assets: [{ id: "image", kind: "image", name: "still.png", durationFrames: 300 }],
    sequence: {
      id: "main", name: "Main", durationFrames: 300,
      tracks: [{ id: "video", kind: "video", clips: [{
        id: "clip", assetId: "image", startFrame: 0, durationFrames: 300,
        sourceInFrame: 0, muted: false, effects: [], parameterTracks: [],
      }] }],
    },
  };
}

async function mount(projectId: string, iframe: HTMLIFrameElement) {
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  let state: NativeProjectSessionState | null = null;
  const onNativeDuration = vi.fn();
  const readOptionalProjectFile = async () => serializeNativeProjectDocument(nativeProject());
  const getPlayheadSeconds = () => 2.5;
  const getIsPlaying = () => true;
  function Harness() {
    state = useNativeProjectSession({
      projectId,
      iframe,
      activeSourceFile: "index.html",
      readOptionalProjectFile,
      getPlayheadSeconds,
      getIsPlaying,
      onNativeDuration,
    });
    return null;
  }
  await act(async () => { root.render(<Harness />); });
  return { state: state as NativeProjectSessionState | null, onNativeDuration };
}

describe("isolated native project session", () => {
  it("sends the current sidecar to its exact project preview origin and restores the playhead", async () => {
    const iframe = document.createElement("iframe");
    iframe.src = `${previewOriginForProject("p")}/api/projects/p/preview`;
    Object.defineProperty(iframe, "contentDocument", { value: null });
    const { state, onNativeDuration } = await mount("p", iframe);

    expect(state?.status).toBe("ready");
    expect(agent.request).toHaveBeenCalledWith(expect.objectContaining({
      kind: "installNativeProject", activeSourceFile: "index.html",
      timeSeconds: 2.5, playing: true,
      project: expect.objectContaining({ id: "native-id", revision: 2 }),
    }));
    expect(onNativeDuration).toHaveBeenCalledWith(300 * 1001 / 30000);
  });

  it("never sends the sidecar to a preview for another project", async () => {
    const iframe = document.createElement("iframe");
    iframe.src = `${previewOriginForProject("other")}/api/projects/other/preview`;
    Object.defineProperty(iframe, "contentDocument", { value: null });
    await mount("p", iframe);
    expect(agent.request).not.toHaveBeenCalled();
  });
});
