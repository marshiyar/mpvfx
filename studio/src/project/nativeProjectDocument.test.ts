import { describe, expect, it } from "vitest";

import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
  NativeProjectDocumentValidationError,
  type NativeProjectDocumentInput,
  parseNativeProjectDocument,
  serializeNativeProjectDocument,
  findNativeProjectTrackByLane,
} from "./nativeProjectDocument";

function validDocument(): NativeProjectDocumentInput {
  return {
    schemaVersion: NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
    id: "project:demo",
    revision: 0,
    frameRate: { numerator: 30_000, denominator: 1_001 },
    canvas: { width: 1920, height: 1080, background: "#101010" },
    assets: [
      {
        id: "asset:camera-a",
        kind: "video",
        name: "camera-a.mov",
        durationFrames: 300,
      },
    ],
    sequence: {
      id: "sequence:main",
      name: "Main",
      tracks: [
        {
          id: "track:video-1",
          kind: "video",
          clips: [
            {
              id: "clip:camera-a-1",
              assetId: "asset:camera-a",
              startFrame: 0,
              durationFrames: 90,
              sourceInFrame: 10,
              effects: [],
              parameterTracks: [],
            },
          ],
        },
      ],
    },
  };
}

describe("native project document", () => {
  it("exports the fixed standalone persistence path", () => {
    expect(NATIVE_PROJECT_DOCUMENT_PATH).toBe(".studio/project.json");
  });

  it("parses a versioned, media-first project and defaults omitted clip playback and mute state safely", () => {
    const parsed = parseNativeProjectDocument(validDocument());

    expect(parsed).toMatchObject({
      schemaVersion: 1,
      id: "project:demo",
      revision: 0,
      frameRate: { numerator: 30_000, denominator: 1_001 },
      canvas: { width: 1920, height: 1080, background: "#101010" },
    });
    expect(parsed.sequence.tracks[0]?.clips[0]?.muted).toBe(false);
    expect(parsed.sequence.tracks[0]?.clips[0]?.playbackRate).toEqual({
      numerator: 1,
      denominator: 1,
    });
    expect(parsed.sequence.tracks[0]?.clips[0]?.staticParameters).toEqual({});
    expect(parsed.sequence.tracks[0]?.lane).toEqual({ authoredTrack: 0, displayTrack: 0 });
  });

  it("round-trips explicit sparse authored/display lane mappings without deriving them from track IDs", () => {
    const document = validDocument();
    document.sequence.tracks[0]!.id = "opaque-track-identity";
    document.sequence.tracks[0]!.lane = { authoredTrack: 17, displayTrack: 2 };

    const parsed = parseNativeProjectDocument(
      JSON.parse(serializeNativeProjectDocument(document)),
    );

    expect(parsed.sequence.tracks[0]).toMatchObject({
      id: "opaque-track-identity",
      lane: { authoredTrack: 17, displayTrack: 2 },
    });
    expect(
      findNativeProjectTrackByLane(parsed, {
        kind: "video",
        authoredTrack: 17,
      })?.id,
    ).toBe("opaque-track-identity");
    expect(
      findNativeProjectTrackByLane(parsed, {
        kind: "video",
        displayTrack: 2,
      })?.id,
    ).toBe("opaque-track-identity");
    expect(
      findNativeProjectTrackByLane(parsed, {
        kind: "audio",
        displayTrack: 2,
      }),
    ).toBeNull();
  });

  it.each([
    ["non-object", null],
    ["fractional authored track", { authoredTrack: 1.5, displayTrack: 0 }],
    ["negative authored track", { authoredTrack: -1, displayTrack: 0 }],
    ["fractional display track", { authoredTrack: 1, displayTrack: 0.5 }],
    ["negative display track", { authoredTrack: 1, displayTrack: -1 }],
  ])("rejects invalid explicit lane metadata: %s", (_name, lane) => {
    const document = validDocument();
    document.sequence.tracks[0]!.lane = lane as never;

    expect(() => parseNativeProjectDocument(document)).toThrowError(
      NativeProjectDocumentValidationError,
    );
  });

  it("rejects duplicate display lanes globally and duplicate authored lanes within a media kind", () => {
    const duplicateDisplay = validDocument();
    duplicateDisplay.sequence.tracks[0]!.lane = { authoredTrack: 8, displayTrack: 2 };
    duplicateDisplay.sequence.tracks.push({
      id: "track:audio-1",
      kind: "audio",
      lane: { authoredTrack: 8, displayTrack: 2 },
      clips: [],
    });
    expect(() => parseNativeProjectDocument(duplicateDisplay)).toThrowError(
      NativeProjectDocumentValidationError,
    );

    const duplicateAuthored = validDocument();
    duplicateAuthored.sequence.tracks[0]!.lane = { authoredTrack: 8, displayTrack: 1 };
    duplicateAuthored.sequence.tracks.push({
      id: "track:video-2",
      kind: "video",
      lane: { authoredTrack: 8, displayTrack: 2 },
      clips: [],
    });
    expect(() => parseNativeProjectDocument(duplicateAuthored)).toThrowError(
      NativeProjectDocumentValidationError,
    );

    const sameAuthoredDifferentKind = validDocument();
    sameAuthoredDifferentKind.sequence.tracks[0]!.lane = { authoredTrack: 8, displayTrack: 1 };
    sameAuthoredDifferentKind.sequence.tracks.push({
      id: "track:audio-1",
      kind: "audio",
      lane: { authoredTrack: 8, displayTrack: 2 },
      clips: [],
    });
    expect(() => parseNativeProjectDocument(sameAuthoredDifferentKind)).not.toThrow();
  });

  it("round-trips an exact rational playback rate without converting it to a float", () => {
    const document = validDocument();
    document.sequence.tracks[0]!.clips[0]!.playbackRate = {
      numerator: 1_001,
      denominator: 1_000,
    };

    const parsed = parseNativeProjectDocument(
      JSON.parse(serializeNativeProjectDocument(document)),
    );

    expect(parsed.sequence.tracks[0]!.clips[0]!.playbackRate).toEqual({
      numerator: 1_001,
      denominator: 1_000,
    });
  });

  it.each([
    ["non-object", 2],
    ["zero numerator", { numerator: 0, denominator: 1 }],
    ["negative numerator", { numerator: -1, denominator: 1 }],
    ["zero denominator", { numerator: 1, denominator: 0 }],
    ["fractional numerator", { numerator: 1.5, denominator: 1 }],
    ["unsafe denominator", { numerator: 1, denominator: Number.MAX_SAFE_INTEGER + 1 }],
  ])("rejects an invalid exact playback rate: %s", (_name, playbackRate) => {
    const document = validDocument();
    document.sequence.tracks[0]!.clips[0]!.playbackRate = playbackRate as never;

    try {
      parseNativeProjectDocument(document);
      throw new Error("expected parser to reject invalid playback rate");
    } catch (error) {
      expect(error).toBeInstanceOf(NativeProjectDocumentValidationError);
      expect((error as NativeProjectDocumentValidationError).issues).toContainEqual(
        expect.objectContaining({
          code: "invalid-playback-rate",
          path: "sequence.tracks[0].clips[0].playbackRate",
        }),
      );
    }
  });

  it("uses playback rate when validating a clip's exact source range", () => {
    const slow = validDocument();
    const slowClip = slow.sequence.tracks[0]!.clips[0]!;
    slowClip.sourceInFrame = 250;
    slowClip.durationFrames = 90;
    slowClip.playbackRate = { numerator: 1, denominator: 2 };
    expect(() => parseNativeProjectDocument(slow)).not.toThrow();

    const fast = validDocument();
    const fastClip = fast.sequence.tracks[0]!.clips[0]!;
    fastClip.sourceInFrame = 10;
    fastClip.durationFrames = 90;
    fastClip.playbackRate = { numerator: 4, denominator: 1 };
    expect(() => parseNativeProjectDocument(fast)).toThrowError(
      NativeProjectDocumentValidationError,
    );
  });

  it("round-trips finite static/default parameters for unkeyed clip properties", () => {
    const document = validDocument();
    document.sequence.tracks[0]!.clips[0]!.staticParameters = {
      opacity: 0.75,
      position: { x: 120, y: -40 },
      tint: { red: 0.2, green: 0.4, blue: 0.8, alpha: 1 },
    };

    const parsed = parseNativeProjectDocument(
      JSON.parse(serializeNativeProjectDocument(document)),
    );

    expect(parsed.sequence.tracks[0]!.clips[0]!.staticParameters).toEqual(
      document.sequence.tracks[0]!.clips[0]!.staticParameters,
    );
  });

  it("clones static/default parameters instead of retaining caller-owned objects", () => {
    const document = validDocument();
    const staticParameters = {
      position: { x: 120, y: -40 },
      tint: { red: 0.2, green: 0.4, blue: 0.8, alpha: 1 },
    };
    document.sequence.tracks[0]!.clips[0]!.staticParameters = staticParameters;

    const parsed = parseNativeProjectDocument(document);
    staticParameters.position.x = 999;
    staticParameters.tint.alpha = 0;

    expect(parsed.sequence.tracks[0]!.clips[0]!.staticParameters).toEqual({
      position: { x: 120, y: -40 },
      tint: { red: 0.2, green: 0.4, blue: 0.8, alpha: 1 },
    });
  });

  it.each([
    ["non-object map", null],
    ["non-finite number", { opacity: Number.NaN }],
    ["non-finite vec2 component", { position: { x: Number.POSITIVE_INFINITY, y: 0 } }],
    ["missing vec2 component", { position: { x: 0 } }],
    ["out-of-range rgba channel", { tint: { red: 1.1, green: 0, blue: 0, alpha: 1 } }],
    ["missing rgba channel", { tint: { red: 0, green: 0, blue: 0 } }],
  ])("rejects malformed static/default parameters: %s", (_name, staticParameters) => {
    const document = validDocument();
    document.sequence.tracks[0]!.clips[0]!.staticParameters = staticParameters as never;

    expect(() => parseNativeProjectDocument(document)).toThrowError(
      NativeProjectDocumentValidationError,
    );
  });

  it("round-trips a scoped DOM compatibility binding without replacing the native clip id", () => {
    const document = validDocument();
    document.sequence.tracks[0]!.clips[0]!.binding = {
      sourceFile: "index.html",
      domId: "camera-a",
      hfId: "hf-camera-a",
      selector: "#composition > .camera-a",
      selectorIndex: 0,
    };

    const parsed = parseNativeProjectDocument(document);

    expect(parsed.sequence.tracks[0]!.clips[0]).toMatchObject({
      id: "clip:camera-a-1",
      binding: {
        sourceFile: "index.html",
        domId: "camera-a",
        hfId: "hf-camera-a",
        selector: "#composition > .camera-a",
        selectorIndex: 0,
      },
    });
    expect(parseNativeProjectDocument(JSON.parse(serializeNativeProjectDocument(parsed)))).toEqual(parsed);
  });

  it.each([
    ["missing source file", { domId: "camera-a" }],
    ["blank source file", { sourceFile: "  ", domId: "camera-a" }],
    ["no exact identifier", { sourceFile: "index.html" }],
    ["blank identifier", { sourceFile: "index.html", domId: "" }],
    ["selector index without a selector", { sourceFile: "index.html", domId: "camera-a", selectorIndex: 0 }],
    ["negative selector index", { sourceFile: "index.html", selector: ".camera", selectorIndex: -1 }],
    ["fractional selector index", { sourceFile: "index.html", selector: ".camera", selectorIndex: 0.5 }],
  ])("rejects an invalid clip binding with %s", (_name, binding) => {
    const document = validDocument();
    document.sequence.tracks[0]!.clips[0]!.binding = binding as never;

    expect(() => parseNativeProjectDocument(document)).toThrowError(
      NativeProjectDocumentValidationError,
    );
  });

  it("rejects duplicate scoped binding identities but permits the same DOM id in another source file", () => {
    const document = validDocument();
    const first = document.sequence.tracks[0]!.clips[0]!;
    first.binding = { sourceFile: "index.html", domId: "camera-a" };
    document.sequence.tracks[0]!.clips.push({
      ...first,
      id: "clip:camera-a-2",
      binding: { sourceFile: "index.html", domId: "camera-a" },
    });

    expect(() => parseNativeProjectDocument(document)).toThrowError(
      NativeProjectDocumentValidationError,
    );

    document.sequence.tracks[0]!.clips[1]!.binding = {
      sourceFile: "nested.html",
      domId: "camera-a",
    };
    expect(() => parseNativeProjectDocument(document)).not.toThrow();
  });

  it("serializes canonically and round-trips without changing stable ids, timeline order, or keyframe data", () => {
    const document = validDocument();
    document.sequence.tracks[0]!.clips[0]!.parameterTracks.push({
      schemaVersion: 1,
      id: "parameter:camera-a-rotation",
      parameterId: "transform.rotation",
      valueType: "number",
      frameRate: { numerator: 30_000, denominator: 1_001 },
      keyframes: [
        { id: "key:rotate-start", frame: 0, value: 0, outgoing: { type: "linear" } },
        { id: "key:rotate-end", frame: 90, value: -180, outgoing: { type: "linear" } },
      ],
    });

    const first = serializeNativeProjectDocument(document);
    const second = serializeNativeProjectDocument(JSON.parse(first));

    expect(second).toBe(first);
    expect(parseNativeProjectDocument(JSON.parse(first))).toEqual(
      parseNativeProjectDocument(document),
    );
  });

  it.each([
    ["unknown schema version", (doc: ReturnType<typeof validDocument>) => ({ ...doc, schemaVersion: 2 })],
    ["negative revision", (doc: ReturnType<typeof validDocument>) => ({ ...doc, revision: -1 })],
    ["fractional frame rate", (doc: ReturnType<typeof validDocument>) => ({
      ...doc,
      frameRate: { numerator: 29.97, denominator: 1 },
    })],
    ["zero canvas width", (doc: ReturnType<typeof validDocument>) => ({
      ...doc,
      canvas: { ...doc.canvas, width: 0 },
    })],
    ["fractional clip start", (doc: ReturnType<typeof validDocument>) => ({
      ...doc,
      sequence: {
        ...doc.sequence,
        tracks: [{ ...doc.sequence.tracks[0]!, clips: [{ ...doc.sequence.tracks[0]!.clips[0]!, startFrame: 0.5 }] }],
      },
    })],
  ])("rejects %s rather than silently repairing it", (_name, mutate) => {
    expect(() => parseNativeProjectDocument(mutate(validDocument()))).toThrowError(
      NativeProjectDocumentValidationError,
    );
  });

  it("reports duplicate stable IDs with structured paths", () => {
    const document = validDocument();
    document.sequence.tracks.push({
      id: "track:video-1",
      kind: "video",
      clips: [],
    });

    try {
      parseNativeProjectDocument(document);
      throw new Error("expected parser to reject duplicate track id");
    } catch (error) {
      expect(error).toBeInstanceOf(NativeProjectDocumentValidationError);
      expect((error as NativeProjectDocumentValidationError).issues).toContainEqual(
        expect.objectContaining({ code: "duplicate-id", path: "sequence.tracks[1].id" }),
      );
    }
  });

  it("rejects missing asset references, media-type mismatches, and source ranges outside the asset", () => {
    const missing = validDocument();
    missing.sequence.tracks[0]!.clips[0]!.assetId = "asset:missing";
    expect(() => parseNativeProjectDocument(missing)).toThrowError(NativeProjectDocumentValidationError);

    const mismatch = validDocument();
    mismatch.sequence.tracks[0]!.kind = "audio";
    expect(() => parseNativeProjectDocument(mismatch)).toThrowError(NativeProjectDocumentValidationError);

    const overrun = validDocument();
    overrun.sequence.tracks[0]!.clips[0]!.sourceInFrame = 250;
    overrun.sequence.tracks[0]!.clips[0]!.durationFrames = 51;
    expect(() => parseNativeProjectDocument(overrun)).toThrowError(NativeProjectDocumentValidationError);
  });

  it("delegates parameter-track and keyframe integrity to the native keyframe contract", () => {
    const document = validDocument();
    document.sequence.tracks[0]!.clips[0]!.parameterTracks.push(
      {
        schemaVersion: 1,
        id: "parameter:rotation-a",
        parameterId: "transform.rotation",
        valueType: "number",
        frameRate: { numerator: 30_000, denominator: 1_001 },
        keyframes: [{ id: "key:shared", frame: 0, value: 0, outgoing: { type: "linear" } }],
      },
      {
        schemaVersion: 1,
        id: "parameter:rotation-b",
        parameterId: "transform.rotation",
        valueType: "number",
        frameRate: { numerator: 30_000, denominator: 1_001 },
        keyframes: [{ id: "key:shared", frame: 1, value: -180, outgoing: { type: "linear" } }],
      },
    );

    expect(() => parseNativeProjectDocument(document)).toThrowError(NativeProjectDocumentValidationError);
  });

  it("turns a core duplicate-keyframe failure into a project-scoped structured issue", () => {
    const document = validDocument();
    document.sequence.tracks[0]!.clips[0]!.parameterTracks.push({
      schemaVersion: 1,
      id: "parameter:rotation",
      parameterId: "transform.rotation",
      valueType: "number",
      frameRate: { numerator: 30_000, denominator: 1_001 },
      keyframes: [
        { id: "key:duplicate", frame: 0, value: 0, outgoing: { type: "linear" } },
        { id: "key:duplicate", frame: 90, value: -180, outgoing: { type: "linear" } },
      ],
    });

    try {
      parseNativeProjectDocument(document);
      throw new Error("expected parser to reject duplicate keyframe id");
    } catch (error) {
      expect(error).toBeInstanceOf(NativeProjectDocumentValidationError);
      expect((error as NativeProjectDocumentValidationError).issues).toContainEqual(
        expect.objectContaining({
          code: "invalid-parameter-track",
          path: "sequence.tracks[0].clips[0].parameterTracks[0]",
        }),
      );
    }
  });

  it("rejects every parameter keyframe beyond its clip duration with an exact keyframe path", () => {
    const document = validDocument();
    const clip = document.sequence.tracks[0]!.clips[0]!;
    clip.parameterTracks = [
      {
        schemaVersion: 1,
        id: "parameter:opacity",
        parameterId: "opacity",
        valueType: "number",
        frameRate: { numerator: 30_000, denominator: 1_001 },
        keyframes: [
          { id: "key:opacity-outside", frame: 91, value: 0.5, outgoing: { type: "linear" } },
        ],
      },
      {
        schemaVersion: 1,
        id: "parameter:position",
        parameterId: "transform.position",
        valueType: "vec2",
        frameRate: { numerator: 30_000, denominator: 1_001 },
        keyframes: [
          {
            id: "key:position-outside",
            frame: 120,
            value: { x: 10, y: 20 },
            outgoing: { type: "linear" },
          },
        ],
      },
      {
        schemaVersion: 1,
        id: "parameter:tint",
        parameterId: "color.tint",
        valueType: "rgba",
        frameRate: { numerator: 30_000, denominator: 1_001 },
        keyframes: [
          {
            id: "key:tint-outside",
            frame: 92,
            value: { red: 1, green: 0.5, blue: 0, alpha: 1 },
            outgoing: { type: "linear" },
          },
        ],
      },
    ];

    try {
      parseNativeProjectDocument(document);
      throw new Error("expected parser to reject keyframes beyond the clip duration");
    } catch (error) {
      expect(error).toBeInstanceOf(NativeProjectDocumentValidationError);
      expect((error as NativeProjectDocumentValidationError).issues).toEqual(
        expect.arrayContaining([
          {
            code: "invalid-parameter-track",
            path: "sequence.tracks[0].clips[0].parameterTracks[0].keyframes[0].frame",
            message: "Keyframe frame 91 exceeds clip duration 90",
          },
          {
            code: "invalid-parameter-track",
            path: "sequence.tracks[0].clips[0].parameterTracks[1].keyframes[0].frame",
            message: "Keyframe frame 120 exceeds clip duration 90",
          },
          {
            code: "invalid-parameter-track",
            path: "sequence.tracks[0].clips[0].parameterTracks[2].keyframes[0].frame",
            message: "Keyframe frame 92 exceeds clip duration 90",
          },
        ]),
      );
    }
  });

  it.each([89, 90])(
    "accepts a parameter keyframe at valid clip-local boundary frame %i",
    (frame) => {
      const document = validDocument();
      document.sequence.tracks[0]!.clips[0]!.parameterTracks.push({
        schemaVersion: 1,
        id: `parameter:rotation:${frame}`,
        parameterId: "transform.rotation",
        valueType: "number",
        frameRate: { numerator: 30_000, denominator: 1_001 },
        keyframes: [
          { id: `key:rotation:${frame}`, frame, value: -180, outgoing: { type: "linear" } },
        ],
      });

      expect(() => parseNativeProjectDocument(document)).not.toThrow();
    },
  );
});
