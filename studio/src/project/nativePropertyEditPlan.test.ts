import { describe, expect, it } from "vitest";

import {
  planNativePropertyEdit,
  projectFrameFromSeconds,
} from "./nativePropertyEditPlan";
import {
  NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
  parseNativeProjectDocument,
  type NativeProjectDocument,
} from "./nativeProjectDocument";
import { createNativeParameterTrack } from "./nativeKeyframeTypes";

const frameRate = { numerator: 30_000, denominator: 1_001 } as const;

const documentFixture = (): NativeProjectDocument =>
  parseNativeProjectDocument({
    schemaVersion: NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
    id: "project:planner",
    revision: 0,
    frameRate,
    canvas: { width: 1920, height: 1080, background: "#111111" },
    assets: [{ id: "asset:video", kind: "video", name: "video.mov", durationFrames: 300 }],
    sequence: {
      id: "sequence:main",
      name: "Main",
      tracks: [
        {
          id: "track:v1",
          kind: "video",
          clips: [
            {
              id: "clip:first",
              assetId: "asset:video",
              binding: {
                sourceFile: "index.html",
                domId: "legacy-first",
                hfId: "hf-first",
                selector: ".timeline-clip",
                selectorIndex: 0,
              },
              startFrame: 30,
              durationFrames: 90,
              sourceInFrame: 0,
              muted: false,
              effects: [],
              parameterTracks: [],
            },
            {
              id: "clip:second",
              assetId: "asset:video",
              binding: {
                sourceFile: "nested.html",
                domId: "legacy-first",
                hfId: "hf-second",
                selector: ".timeline-clip",
                selectorIndex: 0,
              },
              startFrame: 120,
              durationFrames: 90,
              sourceInFrame: 90,
              muted: false,
              effects: [],
              parameterTracks: [],
            },
          ],
        },
      ],
    },
  });

const secondsAtFrame = (frame: number): number =>
  (frame * frameRate.denominator) / frameRate.numerator;

describe("native property edit planner", () => {
  it("quantizes seconds with the same floor rule used by preview and export", () => {
    expect(projectFrameFromSeconds(secondsAtFrame(45), frameRate)).toBe(45);
    expect(projectFrameFromSeconds(secondsAtFrame(45) + secondsAtFrame(0.49), frameRate)).toBe(45);
    expect(projectFrameFromSeconds(secondsAtFrame(45) + secondsAtFrame(0.99), frameRate)).toBe(45);
    expect(projectFrameFromSeconds(secondsAtFrame(46), frameRate)).toBe(46);
  });

  it("rejects negative playhead seconds structurally instead of rounding them to frame zero", () => {
    const result = planNativePropertyEdit(documentFixture(), {
      selectedElement: { id: "clip:first" },
      playheadSeconds: -0.001,
      properties: { x: 20 },
      selectionBounds: { width: 640, height: 360 },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("invalid-playhead");
  });

  it("resolves exact data-studio-clip-id before a conflicting DOM id", () => {
    const result = planNativePropertyEdit(documentFixture(), {
      selectedElement: {
        id: "clip:second",
        attributes: { "data-studio-clip-id": "clip:first" },
      },
      playheadSeconds: secondsAtFrame(45),
      properties: { rotation: -180 },
      selectionBounds: { width: 640, height: 360 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clipId).toBe("clip:first");
    expect(result.projectFrame).toBe(45);
    expect(result.clipLocalFrame).toBe(15);
    expect(result.command.commands[0].address).toMatchObject({
      sequenceId: "sequence:main",
      trackId: "track:v1",
      clipId: "clip:first",
    });
  });

  it("falls back to an exact DOM id only and never performs fuzzy matching", () => {
    const exact = planNativePropertyEdit(documentFixture(), {
      selectedElement: { id: "clip:first" },
      playheadSeconds: secondsAtFrame(45),
      properties: { x: 20 },
      selectionBounds: { width: 640, height: 360 },
    });
    const fuzzy = planNativePropertyEdit(documentFixture(), {
      selectedElement: { id: "clip:first-child" },
      playheadSeconds: secondsAtFrame(45),
      properties: { x: 20 },
      selectionBounds: { width: 640, height: 360 },
    });

    expect(exact.ok).toBe(true);
    expect(fuzzy.ok).toBe(false);
    if (!fuzzy.ok) expect(fuzzy.failure.code).toBe("clip-not-found");
  });

  it("resolves a scoped legacy binding while preserving the independent native clip id", () => {
    const result = planNativePropertyEdit(documentFixture(), {
      selectedElement: {
        id: "legacy-first",
        hfId: "hf-first",
        sourceFile: "index.html",
        selector: ".timeline-clip",
        selectorIndex: 0,
      },
      playheadSeconds: secondsAtFrame(45),
      properties: { rotation: -180 },
      selectionBounds: { width: 640, height: 360 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clipId).toBe("clip:first");
  });

  it("uses source-file scope when repeated DOM ids exist in separate compositions", () => {
    const result = planNativePropertyEdit(documentFixture(), {
      selectedElement: { id: "legacy-first", sourceFile: "nested.html" },
      playheadSeconds: secondsAtFrame(150),
      properties: { x: 12 },
      selectionBounds: { width: 640, height: 360 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clipId).toBe("clip:second");
  });

  it.each([
    ["DOM id", { id: "legacy-first" }],
    ["adapter id", { hfId: "hf-first" }],
    ["selector", { selector: ".unique-first", selectorIndex: 0 }],
  ] as const)(
    "resolves a unique %s compatibility binding when the preview omits source-file scope",
    (_identityKind, selectedElement) => {
      const document = documentFixture();
      document.sequence.tracks[0]!.clips[1]!.binding = {
        ...document.sequence.tracks[0]!.clips[1]!.binding!,
        domId: "legacy-second",
        selector: ".unique-second",
      };
      document.sequence.tracks[0]!.clips[0]!.binding = {
        ...document.sequence.tracks[0]!.clips[0]!.binding!,
        selector: ".unique-first",
      };

      const result = planNativePropertyEdit(document, {
        selectedElement,
        playheadSeconds: secondsAtFrame(45),
        properties: { rotation: -180 },
        selectionBounds: { width: 640, height: 360 },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.clipId).toBe("clip:first");
    },
  );

  it("rejects a source-less compatibility hint repeated across source files", () => {
    const result = planNativePropertyEdit(documentFixture(), {
      selectedElement: { id: "legacy-first" },
      playheadSeconds: secondsAtFrame(45),
      properties: { rotation: -180 },
      selectionBounds: { width: 640, height: 360 },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("ambiguous-clip");
  });

  it("rejects conflicting source-less compatibility hints that identify different clips", () => {
    const document = documentFixture();
    document.sequence.tracks[0]!.clips[1]!.binding = {
      ...document.sequence.tracks[0]!.clips[1]!.binding!,
      domId: "legacy-second",
    };
    const result = planNativePropertyEdit(document, {
      selectedElement: { id: "legacy-first", hfId: "hf-second" },
      playheadSeconds: secondsAtFrame(45),
      properties: { rotation: -180 },
      selectionBounds: { width: 640, height: 360 },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("ambiguous-clip");
  });

  it("rejects conflicting exact binding facts instead of arbitrarily choosing a clip", () => {
    const document = documentFixture();
    document.sequence.tracks[0]!.clips[1]!.binding = {
      sourceFile: "index.html",
      domId: "legacy-second",
      hfId: "hf-second",
    };
    const result = planNativePropertyEdit(document, {
      selectedElement: {
        id: "legacy-first",
        hfId: "hf-second",
        sourceFile: "index.html",
      },
      playheadSeconds: secondsAtFrame(150),
      properties: { x: 12 },
      selectionBounds: { width: 640, height: 360 },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("ambiguous-clip");
  });

  it("does not fall back to DOM id when an explicit clip attribute is present but wrong", () => {
    const result = planNativePropertyEdit(documentFixture(), {
      selectedElement: {
        id: "clip:first",
        attributes: { "data-studio-clip-id": "clip:missing" },
      },
      playheadSeconds: secondsAtFrame(45),
      properties: { x: 20 },
      selectionBounds: { width: 640, height: 360 },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("clip-not-found");
  });

  it("rejects structurally ambiguous exact clip matches", () => {
    const valid = documentFixture();
    const duplicate = {
      ...valid,
      sequence: {
        ...valid.sequence,
        tracks: [
          ...valid.sequence.tracks,
          {
            id: "track:v2",
            kind: "video" as const,
            clips: [{ ...valid.sequence.tracks[0]!.clips[0]! }],
          },
        ],
      },
    } as NativeProjectDocument;
    const result = planNativePropertyEdit(duplicate, {
      selectedElement: { attributes: { "data-studio-clip-id": "clip:first" } },
      playheadSeconds: secondsAtFrame(45),
      properties: { x: 20 },
      selectionBounds: { width: 640, height: 360 },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("ambiguous-clip");
  });

  it.each([29, 120])("rejects project frame %s outside the resolved clip", (frame) => {
    const result = planNativePropertyEdit(documentFixture(), {
      selectedElement: { id: "clip:first" },
      playheadSeconds: secondsAtFrame(frame),
      properties: { x: 20 },
      selectionBounds: { width: 640, height: 360 },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("playhead-outside-clip");
  });

  it("maps every supported property to number parameters with deterministic baselines", () => {
    const result = planNativePropertyEdit(documentFixture(), {
      selectedElement: { id: "clip:first" },
      playheadSeconds: secondsAtFrame(60),
      properties: {
        x: 10,
        y: -20,
        rotation: -180,
        scale: 1.5,
        scaleX: 2,
        scaleY: 0.5,
        opacity: 0.75,
        width: 1280,
        height: 720,
      },
      selectionBounds: { width: 640, height: 360 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.type).toBe("batch");
    expect(
      result.command.commands.map((command) => ({
        parameterId: command.address.parameterId,
        valueType: command.type === "upsert" ? command.valueType : null,
        value: command.type === "upsert" ? command.value : null,
        baseline: command.type === "upsert" ? command.baselineValue : null,
        frame: command.type === "upsert" ? command.frame : null,
      })),
    ).toEqual([
      { parameterId: "transform.position.x", valueType: "number", value: 10, baseline: 0, frame: 30 },
      { parameterId: "transform.position.y", valueType: "number", value: -20, baseline: 0, frame: 30 },
      { parameterId: "transform.rotation", valueType: "number", value: -180, baseline: 0, frame: 30 },
      { parameterId: "transform.scale", valueType: "number", value: 1.5, baseline: 1, frame: 30 },
      { parameterId: "transform.scaleX", valueType: "number", value: 2, baseline: 1, frame: 30 },
      { parameterId: "transform.scaleY", valueType: "number", value: 0.5, baseline: 1, frame: 30 },
      { parameterId: "visual.opacity", valueType: "number", value: 0.75, baseline: 1, frame: 30 },
      { parameterId: "layout.width", valueType: "number", value: 1280, baseline: 640, frame: 30 },
      { parameterId: "layout.height", valueType: "number", value: 720, baseline: 360, frame: 30 },
    ]);
  });

  it("maps rotationZ and autoAlpha aliases while preserving authored negative rotation", () => {
    const result = planNativePropertyEdit(documentFixture(), {
      selectedElement: { id: "clip:first" },
      playheadSeconds: secondsAtFrame(45),
      properties: { rotationZ: -180, autoAlpha: 0.25 },
      selectionBounds: { width: 640, height: 360 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.commands).toEqual([
      expect.objectContaining({
        address: expect.objectContaining({ parameterId: "transform.rotation" }),
        value: -180,
        baselineValue: 0,
      }),
      expect.objectContaining({
        address: expect.objectContaining({ parameterId: "visual.opacity" }),
        value: 0.25,
        baselineValue: 1,
      }),
    ]);
  });

  it("plans the exposed 3D transform channels as native parameters", () => {
    const result = planNativePropertyEdit(documentFixture(), {
      selectedElement: { id: "clip:first" },
      playheadSeconds: secondsAtFrame(45),
      properties: {
        z: 120,
        rotationX: 12,
        rotationY: -18,
        transformPerspective: 900,
        scaleZ: 0.8,
      },
      selectionBounds: { width: 640, height: 360 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.commands.map((command) => command.address.parameterId)).toEqual([
      "transform.position.z",
      "transform.rotationX",
      "transform.rotationY",
      "transform.scaleZ",
      "transform.perspective",
    ]);
  });

  it.each([
    [{ x: 10, color: "red" }, "unsupported-property"],
    [{ x: 10, rotation: Number.NaN }, "nonfinite-value"],
    [{ x: 10, scale: Number.POSITIVE_INFINITY }, "nonfinite-value"],
  ] as const)("never returns a partial plan for invalid property sets", (properties, code) => {
    const result = planNativePropertyEdit(documentFixture(), {
      selectedElement: { id: "clip:first" },
      playheadSeconds: secondsAtFrame(45),
      properties,
      selectionBounds: { width: 640, height: 360 },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe(code);
  });

  it("requires finite selection bounds when width or height needs a baseline", () => {
    const result = planNativePropertyEdit(documentFixture(), {
      selectedElement: { id: "clip:first" },
      playheadSeconds: secondsAtFrame(45),
      properties: { width: 1280 },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("missing-selection-bounds");
  });

  it("rejects aliases that would target the same native parameter twice", () => {
    const result = planNativePropertyEdit(documentFixture(), {
      selectedElement: { id: "clip:first" },
      playheadSeconds: secondsAtFrame(45),
      properties: { rotation: 45, rotationZ: -180 },
      selectionBounds: { width: 640, height: 360 },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("duplicate-parameter");
  });

  it("plans an ordinary edit with auto-keyframing off as a static value when no curve exists", () => {
    const result = planNativePropertyEdit(documentFixture(), {
      selectedElement: { id: "clip:first" },
      playheadSeconds: secondsAtFrame(45),
      properties: { rotation: -180 },
      selectionBounds: { width: 640, height: 360 },
      intent: "edit",
      autoKeyframeEnabled: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.commands).toEqual([
      expect.objectContaining({
        type: "set-static",
        address: expect.objectContaining({ parameterId: "transform.rotation" }),
        value: -180,
      }),
    ]);
  });

  it("plans an ordinary edit between authored keys as a whole-curve offset", () => {
    const document = documentFixture();
    document.sequence.tracks[0]!.clips[0]!.parameterTracks = [
      createNativeParameterTrack({
        id: "parameter:rotation",
        parameterId: "transform.rotation",
        valueType: "number",
        frameRate,
        keyframes: [
          { id: "key:0", frame: 0, value: 0, outgoing: { type: "linear" } },
          { id: "key:60", frame: 60, value: -180, outgoing: { type: "hold" } },
        ],
      }),
    ];

    const result = planNativePropertyEdit(document, {
      selectedElement: { id: "clip:first" },
      playheadSeconds: secondsAtFrame(60),
      properties: { rotation: -120 },
      selectionBounds: { width: 640, height: 360 },
      intent: "edit",
      autoKeyframeEnabled: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Local frame 30 evaluates to -90, so the complete curve moves by -30.
    expect(result.command.commands).toEqual([
      expect.objectContaining({
        type: "offset-track",
        address: expect.objectContaining({ parameterId: "transform.rotation" }),
        delta: -30,
      }),
    ]);
  });

  it("updates the exact authored key under the playhead with auto-keyframing off", () => {
    const document = documentFixture();
    document.sequence.tracks[0]!.clips[0]!.parameterTracks = [
      createNativeParameterTrack({
        id: "parameter:rotation",
        parameterId: "transform.rotation",
        valueType: "number",
        frameRate,
        keyframes: [
          { id: "key:0", frame: 0, value: 0, outgoing: { type: "linear" } },
          { id: "key:30", frame: 30, value: -90, outgoing: { type: "hold" } },
        ],
      }),
    ];

    const result = planNativePropertyEdit(document, {
      selectedElement: { id: "clip:first" },
      playheadSeconds: secondsAtFrame(60),
      properties: { rotation: -180 },
      selectionBounds: { width: 640, height: 360 },
      intent: "edit",
      autoKeyframeEnabled: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.commands).toEqual([
      expect.objectContaining({
        type: "update-value",
        frame: 30,
        value: -180,
      }),
    ]);
  });

  it.each([
    ["explicit keyframe", "keyframe" as const, false],
    ["auto keyframe", "edit" as const, true],
  ])("plans an upsert for %s", (_label, intent, autoKeyframeEnabled) => {
    const result = planNativePropertyEdit(documentFixture(), {
      selectedElement: { id: "clip:first" },
      playheadSeconds: secondsAtFrame(45),
      properties: { rotation: -180 },
      selectionBounds: { width: 640, height: 360 },
      intent,
      autoKeyframeEnabled,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.commands[0]?.type).toBe("upsert");
  });

  it("uses the persisted static value as the first-key baseline", () => {
    const document = documentFixture();
    document.sequence.tracks[0]!.clips[0]!.staticParameters = {
      "transform.rotation": -30,
    };
    const result = planNativePropertyEdit(document, {
      selectedElement: { id: "clip:first" },
      playheadSeconds: secondsAtFrame(60),
      properties: { rotation: -180 },
      selectionBounds: { width: 640, height: 360 },
      intent: "keyframe",
      autoKeyframeEnabled: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.commands[0]).toMatchObject({
      type: "upsert",
      baselineValue: -30,
    });
  });

  it("uses the selected element's measured visual state as the first-key baseline", () => {
    const result = planNativePropertyEdit(documentFixture(), {
      selectedElement: { id: "clip:first" },
      playheadSeconds: secondsAtFrame(60),
      properties: { rotation: -180, opacity: 0.25 },
      propertyBaselines: { rotation: 25, opacity: 0.8 },
      selectionBounds: { width: 640, height: 360 },
      intent: "keyframe",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.commands).toEqual([
      expect.objectContaining({
        address: expect.objectContaining({ parameterId: "transform.rotation" }),
        baselineValue: 25,
      }),
      expect.objectContaining({
        address: expect.objectContaining({ parameterId: "visual.opacity" }),
        baselineValue: 0.8,
      }),
    ]);
  });

  it("keeps persisted native static values authoritative over measured DOM baselines", () => {
    const document = documentFixture();
    document.sequence.tracks[0]!.clips[0]!.staticParameters = {
      "transform.rotation": 12,
    };
    const result = planNativePropertyEdit(document, {
      selectedElement: { id: "clip:first" },
      playheadSeconds: secondsAtFrame(60),
      properties: { rotation: -180 },
      propertyBaselines: { rotation: 25 },
      selectionBounds: { width: 640, height: 360 },
      intent: "keyframe",
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.command.commands[0]).toMatchObject({ baselineValue: 12 });
  });
});
