// @vitest-environment happy-dom
import { act, createElement, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GsapAnimation } from "@hyperframes/core/gsap-parser";
import type { DomEditSelection } from "../../canvas/domEditingTypes";
import { useEnableKeyframes, type EnableKeyframesSession } from "./useEnableKeyframes";
import { usePlayerStore } from "../../../player/store/playerStore";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  vi.unstubAllGlobals();
  window.location.hash = "";
});

function anim(overrides: Partial<GsapAnimation>): GsapAnimation {
  return {
    id: "#el-to-0-position",
    targetSelector: "#el",
    method: "to",
    position: 0,
    properties: {},
    ...overrides,
  };
}

function renderEnableKeyframes(
  session: EnableKeyframesSession,
): () => Promise<void> {
  let enable: (() => Promise<void>) | null = null;
  function Probe() {
    const sessionRef = useRef<EnableKeyframesSession | undefined>(session);
    enable = useEnableKeyframes(sessionRef);
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(createElement(Probe)));
  cleanup = () => act(() => root.unmount());
  if (!enable) throw new Error("hook did not initialize");
  return enable;
}

function makeElementSelection(): DomEditSelection {
  const element = document.body.appendChild(document.createElement("div"));
  element.id = "el";
  return {
    id: "el",
    selector: "#el",
    sourceFile: "index.html",
    element,
  } as DomEditSelection;
}

describe("useEnableKeyframes — native position", () => {
  function nativeSession() {
    const selection = makeElementSelection();
    const commitKeyframeProperties = vi.fn(async () => undefined);
    const deleteNativeKeyframes = vi.fn(async () => undefined);
    const commitMutation = vi.fn(async () => undefined);
    const nativeProjectDocument = {
      schemaVersion: 1,
      id: "project:test",
      revision: 1,
      frameRate: { numerator: 30, denominator: 1 },
      canvas: { width: 1920, height: 1080, background: "#000" },
      assets: [{ id: "asset", kind: "image", name: "card.svg" }],
      sequence: {
        id: "sequence",
        name: "Main",
        tracks: [
          {
            id: "track",
            kind: "video",
            clips: [
              {
                id: "clip",
                assetId: "asset",
                startFrame: 143,
                durationFrames: 120,
                sourceInFrame: 0,
                muted: false,
                effects: [],
                binding: { domId: "el", sourceFile: "index.html" },
                staticParameters: {
                  "transform.position.x": -640,
                  "transform.position.y": 0,
                },
                parameterTracks: [],
              },
            ],
          },
        ],
      },
    } as import("../../../../shared/project/nativeProjectDocument").NativeProjectDocument;
    return {
      domEditSelection: selection,
      selectedGsapAnimations: [anim({ properties: { x: 309, y: -57 } })],
      handleGsapAddAnimation: vi.fn(),
      handleGsapConvertToKeyframes: vi.fn(),
      handleGsapRemoveKeyframe: vi.fn(),
      nativeProjectDocument,
      commitKeyframeProperties,
      deleteNativeKeyframes,
      commitMutation,
    };
  }

  it("rejects an unresolved selection without fetching or writing legacy animation", async () => {
    const session = nativeSession();
    session.domEditSelection.element.setAttribute("data-studio-clip-id", "missing");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(renderEnableKeyframes(session)()).rejects.toThrow("not available");
    expect(fetch).not.toHaveBeenCalled();
    expect(session.commitMutation).not.toHaveBeenCalled();
    expect(session.commitKeyframeProperties).not.toHaveBeenCalled();
  });

  it("captures native position without writing a competing legacy tween", async () => {
    usePlayerStore.setState({ currentTime: 5.392 });
    const session = nativeSession();
    await renderEnableKeyframes(session)();
    expect(session.commitKeyframeProperties).toHaveBeenCalledWith(
      session.domEditSelection,
      { x: -640, y: 0 },
    );
    expect(session.commitMutation).not.toHaveBeenCalled();
  });

  it("removes coincident native X/Y keys atomically at the current output frame", async () => {
    usePlayerStore.setState({ currentTime: 5.392 });
    const session = nativeSession();
    session.nativeProjectDocument.sequence.tracks[0]!.clips[0]!.parameterTracks =
      ["x", "y"].map((axis) => ({
        schemaVersion: 1,
        id: axis,
        parameterId: `transform.position.${axis}`,
        valueType: "number",
        frameRate: { numerator: 30, denominator: 1 },
        keyframes: [
          {
            id: axis + ":18",
            frame: 18,
            value: 0,
            outgoing: { type: "linear" },
          },
        ],
      }));
    await renderEnableKeyframes(session)();
    expect(session.deleteNativeKeyframes).toHaveBeenCalledWith(
      ["x", "y"].map((axis) => ({
        sequenceId: "sequence",
        trackId: "track",
        clipId: "clip",
        parameterId: `transform.position.${axis}`,
        frame: 18,
      })),
    );
    expect(session.commitMutation).not.toHaveBeenCalled();
    expect(session.commitKeyframeProperties).not.toHaveBeenCalled();
  });

  it("does not fall back to the legacy writer when a native save rejects", async () => {
    usePlayerStore.setState({ currentTime: 5.392 });
    const session = nativeSession();
    session.commitKeyframeProperties.mockRejectedValue(
      new Error("Disk unavailable"),
    );
    await expect(renderEnableKeyframes(session)()).rejects.toThrow(
      "Disk unavailable",
    );
    expect(session.commitMutation).not.toHaveBeenCalled();
  });
});
