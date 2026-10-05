// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import { beginStudioManualEditGesture, endStudioManualEditGesture } from "../canvas/manualEdits";
import { applyRotationDraftViaGsap } from "../canvas/manualOffsetDrag";

import { applyNativeFrameToDocument, type NativeClipFrameBinding } from "./nativeFrameApplication";
import { createNativeParameterTrack } from "../../../shared/project/nativeKeyframeTypes";
import { evaluateNativeParameterTrack } from "../../../shared/project/nativeKeyframeEvaluator";

const frameRate = { numerator: 30, denominator: 1 } as const;

function animatedClip(overrides: Partial<NativeClipFrameBinding> = {}): NativeClipFrameBinding {
  return {
    clipId: "clip-1",
    startFrame: 30,
    durationFrames: 91,
    parameterTracks: [
      createNativeParameterTrack({
        id: "parameter:position",
        parameterId: "transform.position",
        valueType: "vec2",
        frameRate,
        keyframes: [
          { id: "position:start", frame: 0, value: { x: 0, y: 10 }, outgoing: { type: "linear" } },
          { id: "position:end", frame: 90, value: { x: 100, y: 40 }, outgoing: { type: "linear" } },
        ],
      }),
      createNativeParameterTrack({
        id: "parameter:rotation",
        parameterId: "transform.rotation",
        valueType: "number",
        frameRate,
        keyframes: [
          { id: "rotation:start", frame: 0, value: 0, outgoing: { type: "linear" } },
          { id: "rotation:end", frame: 90, value: -180, outgoing: { type: "linear" } },
        ],
      }),
      createNativeParameterTrack({
        id: "parameter:scale",
        parameterId: "transform.scale",
        valueType: "vec2",
        frameRate,
        keyframes: [
          { id: "scale:start", frame: 0, value: { x: 1, y: 1 }, outgoing: { type: "linear" } },
          { id: "scale:end", frame: 90, value: { x: 2, y: 1.5 }, outgoing: { type: "linear" } },
        ],
      }),
      createNativeParameterTrack({
        id: "parameter:opacity",
        parameterId: "transform.opacity",
        valueType: "number",
        frameRate,
        keyframes: [
          { id: "opacity:start", frame: 0, value: 1, outgoing: { type: "linear" } },
          { id: "opacity:end", frame: 90, value: 0.5, outgoing: { type: "linear" } },
        ],
      }),
    ],
    ...overrides,
  };
}

function addClipElement(clipId = "clip-1"): HTMLElement {
  const element = document.createElement("div");
  element.setAttribute("data-studio-clip-id", clipId);
  document.body.appendChild(element);
  return element;
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("applyNativeFrameToDocument", () => {
  it("corrects only an opted-in asymmetric crop rotation between authored keys", () => {
    const element = addClipElement("clip:pivot");
    element.style.width = "200px";
    element.style.height = "100px";
    element.style.clipPath = "inset(10px 20px 30px 40px)";
    const numeric = (id: string, first: number, last: number) => createNativeParameterTrack({
      id, parameterId: id, valueType: "number", frameRate,
      keyframes: [
        { id: `${id}:start`, frame: 0, value: first, outgoing: { type: "linear" } },
        { id: `${id}:end`, frame: 90, value: last, outgoing: { type: "linear" } },
      ],
    });
    const clips: NativeClipFrameBinding[] = [{
      clipId: "clip:pivot", startFrame: 0, durationFrames: 91,
      parameterTracks: [
        numeric("transform.position.x", 0, 0),
        numeric("transform.position.y", 0, -20),
        numeric("transform.rotation", 0, 90),
      ],
    }];
    applyNativeFrameToDocument(document, clips, 45);
    expect(element.style.transform).toContain("translate3d(0px, -10px");
    clips[0] = { ...clips[0]!, cropPivotSegments: [{
      startRotationKeyId: "transform.rotation:start",
      endRotationKeyId: "transform.rotation:end",
      offsetFraction: { x: 0.05, y: -0.1 },
    }] };
    applyNativeFrameToDocument(document, clips, 0);
    expect(element.style.transform).toContain("translate3d(0px, 0px");
    applyNativeFrameToDocument(document, clips, 45);
    expect(element.style.transform).toContain("translate3d(-4.142135623731px, -10px");
    applyNativeFrameToDocument(document, clips, 90);
    expect(element.style.transform).toContain("translate3d(0px, -20px");
  });

  it("keeps an interior authored position key exact and retains its eased center path", () => {
    const element = addClipElement("clip:interior");
    element.style.cssText = "width: 200px; height: 100px; clip-path: inset(10px 20px 30px 40px)";
    const rotation = createNativeParameterTrack({
      id: "rotation", parameterId: "transform.rotation", valueType: "number", frameRate,
      keyframes: [
        { id: "first", frame: 0, value: 0, outgoing: { type: "linear" } },
        { id: "last", frame: 90, value: 90, outgoing: { type: "linear" } },
      ],
    });
    const y = createNativeParameterTrack({
      id: "y", parameterId: "transform.position.y", valueType: "number", frameRate,
      keyframes: [
        { id: "y:0", frame: 0, value: 0, outgoing: { type: "linear" } },
        { id: "y:30", frame: 30, value: -4, outgoing: { type: "cubic-bezier",
          controlPoints: { x1: 0.1, y1: 0.8, x2: 0.4, y2: 1 } } },
        { id: "y:90", frame: 90, value: -20, outgoing: { type: "linear" } },
      ],
    });
    const clip: NativeClipFrameBinding = {
      clipId: "clip:interior", startFrame: 0, durationFrames: 91,
      staticParameters: { "transform.position.x": 0 }, parameterTracks: [rotation, y],
      cropPivotSegments: [{ startRotationKeyId: "first", endRotationKeyId: "last",
        offsetFraction: { x: 0.05, y: -0.1 } }],
    };
    for (const [frame, authoredY] of [[0, 0], [30, -4], [90, -20]]) {
      applyNativeFrameToDocument(document, [clip], frame!);
      expect(element.style.transform).toContain(`, ${authoredY}px`);
    }
    applyNativeFrameToDocument(document, [clip], 45);
    const renderedY = Number(/translate3d\([^,]+,\s*([^p]+)px/.exec(element.style.transform)?.[1]);
    const authoredY = evaluateNativeParameterTrack(y, 45) as number;
    const progress = (authoredY + 4) / -16;
    const offsetAt30 = 10 * Math.sin(Math.PI / 6) - 10 * Math.cos(Math.PI / 6);
    const expectedCenterY = -4 + offsetAt30 + (-20 + 10 - (-4 + offsetAt30)) * progress;
    const offsetAt45 = 10 * Math.sin(Math.PI / 4) - 10 * Math.cos(Math.PI / 4);
    expect(renderedY + offsetAt45).toBeCloseTo(expectedCenterY, 8);
  });

  it("pins a cropped center through a native scale animation without moving keyed poses", () => {
    const element = addClipElement("clip:scale-pivot");
    element.style.cssText = "width: 200px; height: 100px; clip-path: inset(10px 20px 30px 40px)";
    const numeric = (id: string, first: number, last: number) => createNativeParameterTrack({
      id, parameterId: id, valueType: "number", frameRate,
      keyframes: [
        { id: `${id}:first`, frame: 0, value: first, outgoing: { type: "linear" } },
        { id: `${id}:last`, frame: 90, value: last, outgoing: { type: "linear" } },
      ],
    });
    const clip: NativeClipFrameBinding = {
      clipId: "clip:scale-pivot", startFrame: 0, durationFrames: 91,
      parameterTracks: [
        numeric("transform.position.x", 0, -10),
        numeric("transform.position.y", 0, -30),
        numeric("transform.rotation", 0, 90),
        createNativeParameterTrack({
          id: "scale", parameterId: "transform.scale", valueType: "vec2", frameRate,
          keyframes: [
            { id: "scale:first", frame: 0, value: { x: 1, y: 1 }, outgoing: { type: "linear" } },
            { id: "scale:last", frame: 90, value: { x: 2, y: 2 }, outgoing: { type: "linear" } },
          ],
        }),
      ],
      cropPivotSegments: [{ startRotationKeyId: "transform.rotation:first",
        endRotationKeyId: "transform.rotation:last", offsetFraction: { x: 0.05, y: -0.1 } }],
    };
    applyNativeFrameToDocument(document, [clip], 0);
    expect(element.style.transform).toContain("translate3d(0px, 0px");
    applyNativeFrameToDocument(document, [clip], 45);
    const match = /translate3d\(([^p]+)px,\s*([^p]+)px/.exec(element.style.transform)!;
    const current = { x: Number(match[1]), y: Number(match[2]) };
    const q = 15 * Math.SQRT2;
    expect(current.x + q).toBeCloseTo(10, 8);
    expect(current.y).toBeCloseTo(-10, 8);
    applyNativeFrameToDocument(document, [clip], 90);
    expect(element.style.transform).toContain("translate3d(-10px, -30px");
  });

  it("leaves an authored curved position path untouched", () => {
    const element = addClipElement("clip:path");
    element.style.cssText = "width: 200px; height: 100px; clip-path: inset(10px 20px 30px 40px)";
    const clip: NativeClipFrameBinding = {
      clipId: "clip:path", startFrame: 0, durationFrames: 91,
      parameterTracks: [
        createNativeParameterTrack({
          id: "path", parameterId: "transform.position", valueType: "vec2", frameRate,
          keyframes: [
            { id: "p0", frame: 0, value: { x: 0, y: 0 }, outgoing: { type: "linear" },
              outgoingPath: { type: "bezier", cp1: { x: 10, y: 40 }, cp2: { x: 30, y: -40 } } },
            { id: "p1", frame: 90, value: { x: 40, y: 0 }, outgoing: { type: "linear" } },
          ],
        }),
        createNativeParameterTrack({
          id: "rotation", parameterId: "transform.rotation", valueType: "number", frameRate,
          keyframes: [
            { id: "r0", frame: 0, value: 0, outgoing: { type: "linear" } },
            { id: "r1", frame: 90, value: 90, outgoing: { type: "linear" } },
          ],
        }),
      ],
    };
    applyNativeFrameToDocument(document, [clip], 45);
    const original = element.style.transform;
    applyNativeFrameToDocument(document, [{ ...clip, cropPivotSegments: [{
      startRotationKeyId: "r0", endRotationKeyId: "r1", offsetFraction: { x: 0.05, y: -0.1 },
    }] }], 45);
    expect(element.style.transform).toBe(original);
  });

  it("applies the evaluated midpoint for independent position, rotation, scale, and opacity tracks", () => {
    const element = addClipElement();

    const result = applyNativeFrameToDocument(document, [animatedClip()], 75);

    expect(result).toEqual({ appliedClipIds: ["clip-1"], missingClipIds: [] });
    expect(element.style.transform).toBe(
      "translate3d(50px, 25px, 0px) rotate(-90deg) scale(1.5, 1.25)",
    );
    expect(element.style.opacity).toBe("0.75");
    expect(element.style.visibility).toBe("visible");
    expect(element.getAttribute("data-studio-native-owned")).toBe(
      "transform.position transform.rotation transform.scale transform.opacity",
    );
  });

  it("applies to a clip element even when the iframe WindowProxy exposes a newer HTMLElement realm", () => {
    const element = addClipElement();
    class NewIframeRealmHTMLElement {}
    const navigatedIframeDocument = {
      defaultView: { HTMLElement: NewIframeRealmHTMLElement },
      querySelectorAll: document.querySelectorAll.bind(document),
    } as unknown as Document;

    const result = applyNativeFrameToDocument(
      navigatedIframeDocument,
      [animatedClip()],
      75,
    );

    expect(result).toEqual({ appliedClipIds: ["clip-1"], missingClipIds: [] });
    expect(element.style.transform).toContain("rotate(-90deg)");
    expect(element.getAttribute("data-studio-native-owned")).toContain("transform.rotation");
  });

  it("applies native z, 3D rotations, perspective, and scale Z without GSAP", () => {
    const element = addClipElement();
    const clip = animatedClip({
      parameterTracks: [
        createNativeParameterTrack({
          id: "parameter:z",
          parameterId: "transform.position.z",
          valueType: "number",
          frameRate,
          keyframes: [
            { id: "z:start", frame: 0, value: 0, outgoing: { type: "linear" } },
            { id: "z:end", frame: 90, value: 120, outgoing: { type: "linear" } },
          ],
        }),
        createNativeParameterTrack({
          id: "parameter:rotation-x",
          parameterId: "transform.rotationX",
          valueType: "number",
          frameRate,
          keyframes: [{ id: "rx", frame: 0, value: 12, outgoing: { type: "linear" } }],
        }),
        createNativeParameterTrack({
          id: "parameter:rotation-y",
          parameterId: "transform.rotationY",
          valueType: "number",
          frameRate,
          keyframes: [{ id: "ry", frame: 0, value: -18, outgoing: { type: "linear" } }],
        }),
        createNativeParameterTrack({
          id: "parameter:perspective",
          parameterId: "transform.perspective",
          valueType: "number",
          frameRate,
          keyframes: [{ id: "p", frame: 0, value: 900, outgoing: { type: "linear" } }],
        }),
        createNativeParameterTrack({
          id: "parameter:scale-z",
          parameterId: "transform.scaleZ",
          valueType: "number",
          frameRate,
          keyframes: [{ id: "sz", frame: 0, value: 0.8, outgoing: { type: "linear" } }],
        }),
      ],
    });

    applyNativeFrameToDocument(document, [clip], 75);

    expect(element.style.transform).toBe(
      "perspective(900px) translate3d(0px, 0px, 60px) rotateX(12deg) rotateY(-18deg) rotate(0deg) scale3d(1, 1, 0.8)",
    );
  });

  it("is deterministic across repeated and non-monotonic seeks", () => {
    const element = addClipElement();
    const clip = animatedClip();

    applyNativeFrameToDocument(document, [clip], 75);
    const first = element.getAttribute("style");
    applyNativeFrameToDocument(document, [clip], 31);
    expect(element.getAttribute("style")).not.toBe(first);
    applyNativeFrameToDocument(document, [clip], 75);

    expect(element.getAttribute("style")).toBe(first);
  });

  it("resets formerly owned properties when a later model revision removes their tracks", () => {
    const element = addClipElement();
    applyNativeFrameToDocument(document, [animatedClip()], 75);

    applyNativeFrameToDocument(
      document,
      [animatedClip({ parameterTracks: [] })],
      75,
    );

    expect(element.style.transform).toBe(
      "translate3d(0px, 0px, 0px) rotate(0deg) scale(1, 1)",
    );
    expect(element.style.opacity).toBe("1");
    expect(element.getAttribute("data-studio-native-owned")).toBe("");
  });

  it("does not overwrite an untouched legacy transform when the clip owns no native parameters", () => {
    const element = addClipElement();
    element.style.transform = "translateX(12px) rotate(20deg)";
    element.style.opacity = "0.6";

    applyNativeFrameToDocument(
      document,
      [animatedClip({ parameterTracks: [] })],
      75,
    );

    expect(element.style.transform).toBe("translateX(12px) rotate(20deg)");
    expect(element.style.opacity).toBe("0.6");
    expect(element.hasAttribute("data-studio-native-owned")).toBe(false);
  });

  it("hides clips outside their timeline interval and restores them on an in-range seek", () => {
    const element = addClipElement();
    const clip = animatedClip();

    applyNativeFrameToDocument(document, [clip], 10);
    expect(element.style.visibility).toBe("hidden");

    applyNativeFrameToDocument(document, [clip], 30);
    expect(element.style.visibility).toBe("visible");

    applyNativeFrameToDocument(document, [clip], 121);
    expect(element.style.visibility).toBe("hidden");
  });

  it("reports an absent target without aborting other clips", () => {
    const second = addClipElement("clip-2");

    const result = applyNativeFrameToDocument(
      document,
      [animatedClip(), animatedClip({ clipId: "clip-2" })],
      75,
    );

    expect(result).toEqual({ appliedClipIds: ["clip-2"], missingClipIds: ["clip-1"] });
    expect(second.style.transform).toContain("rotate(-90deg)");
  });

  it("renders exact scalar channels emitted by the legacy compatibility importer", () => {
    const element = addClipElement();
    const scalar = (id: string, parameterId: string, from: number, to: number) =>
      createNativeParameterTrack({
        id,
        parameterId,
        valueType: "number" as const,
        frameRate,
        keyframes: [
          { id: `${id}:start`, frame: 0, value: from, outgoing: { type: "linear" as const } },
          { id: `${id}:end`, frame: 90, value: to, outgoing: { type: "linear" as const } },
        ],
      });
    const clip = animatedClip({
      parameterTracks: [
        scalar("x", "transform.position.x", 0, 100),
        scalar("y", "transform.position.y", 10, 40),
        scalar("rotation", "transform.rotation", 0, -180),
        scalar("scale-x", "transform.scaleX", 1, 2),
        scalar("scale-y", "transform.scaleY", 1, 1.5),
        scalar("opacity", "visual.opacity", 1, 0.5),
      ],
    });

    applyNativeFrameToDocument(document, [clip], 75);

    expect(element.style.transform).toBe(
      "translate3d(50px, 25px, 0px) rotate(-90deg) scale(1.5, 1.25)",
    );
    expect(element.style.opacity).toBe("0.75");
  });

  it("applies animated layout dimensions without taking ownership of legacy transform or opacity", () => {
    const element = addClipElement();
    element.style.transform = "translateX(12px) rotate(20deg)";
    element.style.opacity = "0.6";
    const scalar = (id: string, parameterId: string, from: number, to: number) =>
      createNativeParameterTrack({
        id,
        parameterId,
        valueType: "number" as const,
        frameRate,
        keyframes: [
          { id: `${id}:start`, frame: 0, value: from, outgoing: { type: "linear" as const } },
          { id: `${id}:end`, frame: 90, value: to, outgoing: { type: "linear" as const } },
        ],
      });

    applyNativeFrameToDocument(
      document,
      [
        animatedClip({
          parameterTracks: [
            scalar("width", "layout.width", 640, 1280),
            scalar("height", "layout.height", 360, 720),
          ],
        }),
      ],
      75,
    );

    expect(element.style.width).toBe("960px");
    expect(element.style.height).toBe("540px");
    expect(element.style.transform).toBe("translateX(12px) rotate(20deg)");
    expect(element.style.opacity).toBe("0.6");
    expect(element.getAttribute("data-studio-native-owned")).toBe(
      "layout.width layout.height",
    );
  });

  it("clears dimensions formerly owned by a removed native layout track", () => {
    const element = addClipElement();
    const width = createNativeParameterTrack({
      id: "width",
      parameterId: "layout.width",
      valueType: "number",
      frameRate,
      keyframes: [
        { id: "width:start", frame: 0, value: 640, outgoing: { type: "linear" } },
      ],
    });

    applyNativeFrameToDocument(
      document,
      [animatedClip({ parameterTracks: [width] })],
      75,
    );
    expect(element.style.width).toBe("640px");

    applyNativeFrameToDocument(
      document,
      [animatedClip({ parameterTracks: [] })],
      75,
    );

    expect(element.style.width).toBe("");
    expect(element.getAttribute("data-studio-native-owned")).toBe("");
  });

  it("applies deterministic static picture parameters when a clip has no animation tracks", () => {
    const element = addClipElement();
    const clip = animatedClip({
      parameterTracks: [],
      staticParameters: {
        "transform.position": { x: 24, y: -12 },
        "transform.rotation": -180,
        "transform.scale": { x: 1.25, y: 0.75 },
        "transform.opacity": 0.65,
        "layout.width": 1280,
        "layout.height": 720,
      },
    });

    const result = applyNativeFrameToDocument(document, [clip], 75);

    expect(result).toEqual({ appliedClipIds: ["clip-1"], missingClipIds: [] });
    expect(element.style.transform).toBe(
      "translate3d(24px, -12px, 0px) rotate(-180deg) scale(1.25, 0.75)",
    );
    expect(element.style.opacity).toBe("0.65");
    expect(element.style.width).toBe("1280px");
    expect(element.style.height).toBe("720px");
    expect(element.getAttribute("data-studio-native-owned")).toBe(
      "transform.position transform.rotation transform.scale transform.opacity layout.width layout.height",
    );

    // Authored object insertion order must not affect the rendered frame.
    applyNativeFrameToDocument(
      document,
      [
        animatedClip({
          parameterTracks: [],
          staticParameters: {
            "layout.height": 720,
            "layout.width": 1280,
            "transform.opacity": 0.65,
            "transform.scale": { x: 1.25, y: 0.75 },
            "transform.rotation": -180,
            "transform.position": { x: 24, y: -12 },
          },
        }),
      ],
      75,
    );
    expect(element.getAttribute("style")).toContain(
      "translate3d(24px, -12px, 0px) rotate(-180deg) scale(1.25, 0.75)",
    );
  });

  it("uses animated values as overrides while retaining static values for unanimated parameters", () => {
    const element = addClipElement();
    const clip = animatedClip({
      staticParameters: {
        "transform.position": { x: 24, y: -12 },
        "transform.rotation": 45,
        "transform.scale": { x: 1.25, y: 0.75 },
        "transform.opacity": 0.65,
      },
      parameterTracks: [
        createNativeParameterTrack({
          id: "parameter:rotation-animated",
          parameterId: "transform.rotation",
          valueType: "number",
          frameRate,
          keyframes: [
            { id: "rotation:start", frame: 0, value: 0, outgoing: { type: "linear" } },
            { id: "rotation:end", frame: 90, value: -180, outgoing: { type: "linear" } },
          ],
        }),
      ],
    });

    applyNativeFrameToDocument(document, [clip], 75);

    expect(element.style.transform).toBe(
      "translate3d(24px, -12px, 0px) rotate(-90deg) scale(1.25, 0.75)",
    );
    expect(element.style.opacity).toBe("0.65");
  });
});

it("keeps explicitly hidden clips hidden on every active native frame", () => {
  const element = addClipElement();
  element.setAttribute("data-hidden", "true");
  applyNativeFrameToDocument(document, [animatedClip()], 60);
  expect(element.style.visibility).toBe("hidden");
});

it("keeps the graded picture and hidden source in sync without revealing the original", () => {
  const element = addClipElement();
  element.id = "graded";
  element.setAttribute("data-hf-color-grading-source-hidden", "true");
  element.style.setProperty("opacity", "0", "important");
  const canvas = document.createElement("canvas");
  canvas.id = "__hf_color_grading_graded";
  canvas.setAttribute("data-hf-color-grading-canvas", "true");
  document.body.append(canvas);
  applyNativeFrameToDocument(document, [animatedClip()], 75);
  expect(element.style.opacity).toBe("0");
  expect(element.style.getPropertyPriority("opacity")).toBe("important");
  expect(element.getAttribute("data-studio-native-opacity")).toBe("0.75");
  expect(canvas.style.opacity).toBe("0.75");
  expect(canvas.style.transform).toBe(element.style.transform);
  applyNativeFrameToDocument(document, [animatedClip()], 121);
  expect(canvas.style.visibility).toBe("hidden");
});

it("keeps the active gesture picture through retained frame reapplication", () => {
  const element = addClipElement();
  const clip = animatedClip();
  applyNativeFrameToDocument(document, [clip], 75);
  const token = beginStudioManualEditGesture(element);
  const runtime = window as unknown as { gsap?: unknown };
  runtime.gsap = {
    getProperty: () => 0,
    set: (target: HTMLElement, values: { rotation: number }) => {
      target.style.transform = `translate(50px, 25px) rotate(${values.rotation}deg)`;
    },
  };
  try {
    applyRotationDraftViaGsap(element, -35);
    const draft = element.style.transform;
    // A legacy seek or paused render can repaint before the native final pass.
    element.style.transform = "translate(0px, 0px)";
    applyNativeFrameToDocument(document, [clip], 75);
    expect(element.style.transform).toBe(draft);
    endStudioManualEditGesture(element, token);
    applyNativeFrameToDocument(document, [clip], 75);
    expect(element.style.transform).toContain("rotate(-90deg)");
  } finally { delete runtime.gsap; }
});

it("keeps the page's GSAP values for transform components it has no native value for", async () => {
  const { gsap } = await import("gsap");
  const element = addClipElement();
  const runtime = window as unknown as { gsap?: unknown };
  runtime.gsap = gsap;
  try {
    // An animation that stayed legacy-owned (for example an unsupported ease).
    gsap.set(element, { rotation: 30, scale: 0.5, x: 999 });
    const [position] = animatedClip().parameterTracks;
    applyNativeFrameToDocument(document, [animatedClip({ parameterTracks: [position!] })], 75);
    expect(element.style.transform).toBe("translate3d(50px, 25px, 0px) rotate(30deg) scale(0.5, 0.5)");
  } finally { delete runtime.gsap; }
});
