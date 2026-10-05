// @vitest-environment happy-dom

import { afterEach, expect, it } from "vitest";
import { createNativeParameterTrack } from "../../../shared/project/nativeKeyframeTypes";
import { serializeNativeProjectDocument, type NativeProjectDocument } from "../../../shared/project/nativeProjectDocument";
import { createBakedEngine, installVkfEngine, vkfEngine } from "../../../shared/engine/vkfEngine";
import { applyNativeFrameToDocument } from "../../../src/features/project/nativeFrameApplication";
import { createNativeProjectRenderBodyScript } from "../nativeProject";

afterEach(() => document.body.replaceChildren());

it("exports a split cropped rotation from its original interpolation without a native engine in the page", () => {
  const frameRate = { numerator: 30, denominator: 1 };
  const track = (parameterId: string, first: number, last: number, startFrame: number, endFrame: number) =>
    createNativeParameterTrack({
      id: `track:${parameterId}:${startFrame}`,
      parameterId,
      valueType: "number",
      frameRate,
      keyframes: [
        { id: `${parameterId}:${startFrame}`, frame: startFrame, value: first, outgoing: { type: "linear" } },
        { id: `${parameterId}:${endFrame}`, frame: endFrame, value: last, outgoing: { type: "linear" } },
      ],
    });
  const original = [
    track("transform.position.x", 0, 0, 0, 90),
    track("transform.position.y", 0, -80, 0, 90),
    track("transform.rotation", 0, 90, 0, 90),
  ];
  const rebased = [
    track("transform.position.x", 0, 0, 0, 30),
    track("transform.position.y", -80 * 60 / 90, -80, 0, 30),
    track("transform.rotation", 60, 90, 0, 30),
  ];
  const segment = {
    startRotationKeyId: "transform.rotation:0",
    endRotationKeyId: "transform.rotation:30",
    offsetFraction: { x: 0.05, y: -0.1 },
    reference: {
      frameOffset: 60,
      durationFrames: 150,
      startRotationKeyId: "transform.rotation:0",
      endRotationKeyId: "transform.rotation:90",
      parameterTracks: original,
      staticParameters: { "layout.width": 800, "layout.height": 400 },
    },
  };
  const project: NativeProjectDocument = {
    schemaVersion: 1,
    id: "project:split-pivot",
    revision: 1,
    frameRate,
    canvas: { width: 1920, height: 1080, background: "#000000" },
    assets: [{ id: "asset:video", kind: "video", name: "checker.mp4", durationFrames: 150 }],
    sequence: { id: "sequence:main", name: "Main", tracks: [{
      id: "track:video", kind: "video", clips: [{
        id: "clip:right", assetId: "asset:video", startFrame: 60, durationFrames: 90,
        sourceInFrame: 60, muted: true, effects: [], parameterTracks: rebased,
        staticParameters: { "layout.width": 800, "layout.height": 400 },
        cropPivotSegments: [segment], binding: { sourceFile: "index.html", domId: "right" },
      }],
    }] },
  };
  const element = document.createElement("div");
  element.id = "right";
  element.setAttribute("data-studio-clip-id", "clip:right");
  element.style.cssText = "width:800px;height:400px;clip-path:inset(40px 80px 120px 160px)";
  document.body.replaceChildren(element);

  const engine = vkfEngine();
  try {
    applyNativeFrameToDocument(document, [{
      clipId: "clip:right", startFrame: 60, durationFrames: 90,
      staticParameters: project.sequence.tracks[0]!.clips[0]!.staticParameters,
      parameterTracks: rebased, cropPivotSegments: [segment],
    }], 80);
    const previewTransform = element.style.transform;
    expect(previewTransform).toContain("rotate(80deg)");
    const script = createNativeProjectRenderBodyScript(serializeNativeProjectDocument(project))!;
    // The capture page has no C++ evaluator. An unprepared reference must
    // fail here instead of being rescued by the test runner's global engine.
    installVkfEngine(createBakedEngine("capture-only", () => undefined));
    element.style.removeProperty("transform");
    window.eval(script);
    const apply = (window as typeof window & { __studioNativeProjectApply: (seconds: number) => number })
      .__studioNativeProjectApply;
    expect(apply(80 / 30)).toBe(1);
    expect(element.style.transform).toBe(previewTransform);
  } finally {
    installVkfEngine(engine);
  }
});
