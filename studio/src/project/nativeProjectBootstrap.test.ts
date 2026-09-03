import { describe, expect, it } from "vitest";

import type { TimelineElement } from "../player/store/timelineElement";
import {
  bootstrapNativeProjectFromTimeline,
  type NativeProjectBootstrapInput,
} from "./nativeProjectBootstrap";
import { serializeNativeProjectDocument } from "./nativeProjectDocument";

const frameRate = { numerator: 30_000, denominator: 1_001 } as const;
const secondsAtFrame = (frame: number): number =>
  (frame * frameRate.denominator) / frameRate.numerator;

const element = (overrides: Partial<TimelineElement> = {}): TimelineElement => ({
  id: "runtime-row",
  tag: "video",
  start: secondsAtFrame(30),
  duration: secondsAtFrame(60),
  track: 0,
  authoredTrack: 3,
  sourceFile: "index.html",
  domId: "camera-a",
  hfId: "hf-camera-a",
  selector: "#camera-a",
  selectorIndex: 0,
  src: "assets/camera.mov",
  ...overrides,
});

const input = (elements: TimelineElement[]): NativeProjectBootstrapInput => ({
  projectId: "project:bootstrap",
  sequenceId: "sequence:main",
  sequenceName: "Main",
  frameRate,
  canvas: { width: 1920, height: 1080, background: "#111111" },
  elements,
});

describe("native project bootstrap", () => {
  it("builds valid video, audio, and image clips while ignoring structural composition rows", () => {
    const result = bootstrapNativeProjectFromTimeline(
      input([
        element({ structuralRole: "composition-root", domId: "root", src: undefined }),
        element(),
        element({
          id: "audio-row",
          tag: "audio",
          track: 1,
          authoredTrack: 1,
          domId: "voice",
          hfId: undefined,
          selector: "#voice",
          src: "assets/voice.wav",
          start: 0,
          duration: secondsAtFrame(90),
        }),
        element({
          id: "image-row",
          tag: "img",
          track: 2,
          authoredTrack: 2,
          domId: "logo",
          hfId: undefined,
          selector: "#logo",
          src: "assets/logo.png",
          start: secondsAtFrame(10),
          duration: secondsAtFrame(120),
        }),
        element({ id: "decorative-row", tag: "div", domId: "shape", src: undefined }),
      ]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.assets.map((asset) => asset.kind)).toEqual(["audio", "image", "video"]);
    expect(result.document.sequence.tracks.map((track) => [track.kind, track.id])).toEqual([
      ["audio", expect.stringContaining("1")],
      ["video", expect.stringContaining("2")],
      ["video", expect.stringContaining("3")],
    ]);
    expect(result.document.sequence.tracks.map((track) => track.lane)).toEqual([
      { authoredTrack: 1, displayTrack: 1 },
      { authoredTrack: 2, displayTrack: 2 },
      { authoredTrack: 3, displayTrack: 0 },
    ]);
    expect(result.document.sequence.tracks.flatMap((track) => track.clips)).toHaveLength(3);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "ignored-structural", elementId: "runtime-row" }),
      expect.objectContaining({ code: "unsupported-media-row", elementId: "decorative-row" }),
    ]);
    expect(() => serializeNativeProjectDocument(result.document)).not.toThrow();
  });

  it("records an exact source binding separately from deterministic canonical clip identity", () => {
    const result = bootstrapNativeProjectFromTimeline(input([element()]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const clip = result.document.sequence.tracks[0]!.clips[0]!;
    expect(clip.id).not.toBe("runtime-row");
    expect(clip.binding).toEqual({
      sourceFile: "index.html",
      domId: "camera-a",
      hfId: "hf-camera-a",
      selector: "#camera-a",
      selectorIndex: 0,
    });
  });

  it("converts timing to integer frames, uses playbackStart for sourceIn, and defaults mute false", () => {
    const result = bootstrapNativeProjectFromTimeline(
      input([
        element({
          start: secondsAtFrame(15),
          duration: secondsAtFrame(45),
          playbackStart: secondsAtFrame(12),
          sourceDuration: secondsAtFrame(120),
          muted: undefined,
        }),
      ]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.sequence.tracks[0]!.clips[0]).toMatchObject({
      startFrame: 15,
      durationFrames: 45,
      sourceInFrame: 12,
      muted: false,
    });
    expect(result.document.assets[0]!.durationFrames).toBe(120);
  });

  it("preserves fast playback as an exact rational and sizes the source range by source frames consumed", () => {
    const result = bootstrapNativeProjectFromTimeline(
      input([
        element({
          duration: secondsAtFrame(45),
          playbackStart: secondsAtFrame(12),
          playbackRate: 2,
        }),
      ]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.sequence.tracks[0]!.clips[0]).toMatchObject({
      durationFrames: 45,
      sourceInFrame: 12,
      playbackRate: { numerator: 2, denominator: 1 },
    });
    expect(result.document.assets[0]!.durationFrames).toBe(102);
  });

  it("preserves slow and decimal playback rates as reduced exact rationals", () => {
    const result = bootstrapNativeProjectFromTimeline(
      input([
        element({
          duration: secondsAtFrame(45),
          playbackStart: secondsAtFrame(12),
          playbackRate: 0.5,
        }),
        element({
          id: "decimal-rate",
          domId: "decimal-rate",
          hfId: undefined,
          selector: "#decimal-rate",
          start: secondsAtFrame(100),
          duration: secondsAtFrame(10),
          playbackRate: 1.25,
        }),
      ]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const clips = result.document.sequence.tracks[0]!.clips;
    expect(clips[0]).toMatchObject({ playbackRate: { numerator: 1, denominator: 2 } });
    expect(clips[1]).toMatchObject({ playbackRate: { numerator: 5, denominator: 4 } });
    expect(result.document.assets[0]!.durationFrames).toBe(35);
  });

  it("uses exact rational source-bound checks instead of treating timeline and source duration alike", () => {
    const fastOutOfBounds = bootstrapNativeProjectFromTimeline(
      input([
        element({
          duration: secondsAtFrame(45),
          playbackStart: secondsAtFrame(12),
          playbackRate: 2,
          sourceDuration: secondsAtFrame(101),
        }),
      ]),
    );
    const slowWithinBounds = bootstrapNativeProjectFromTimeline(
      input([
        element({
          duration: secondsAtFrame(45),
          playbackStart: secondsAtFrame(12),
          playbackRate: 0.5,
          sourceDuration: secondsAtFrame(35),
        }),
      ]),
    );

    expect(fastOutOfBounds.ok).toBe(true);
    expect(slowWithinBounds.ok).toBe(true);
    if (!fastOutOfBounds.ok || !slowWithinBounds.ok) return;
    expect(fastOutOfBounds.document.sequence.tracks).toEqual([]);
    expect(fastOutOfBounds.diagnostics).toContainEqual(
      expect.objectContaining({ code: "source-out-of-bounds" }),
    );
    expect(slowWithinBounds.document.sequence.tracks[0]!.clips).toHaveLength(1);
  });

  it("preserves an explicitly authored mute without making mute the import default", () => {
    const result = bootstrapNativeProjectFromTimeline(input([element({ muted: true })]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.sequence.tracks[0]!.clips[0]!.muted).toBe(true);
  });

  it("is byte-deterministic and has the same IDs/order policy when input rows are reordered", () => {
    const rows = [
      element({ id: "later", domId: "later", hfId: undefined, selector: "#later", start: secondsAtFrame(90) }),
      element({ id: "earlier", domId: "earlier", hfId: undefined, selector: "#earlier", start: secondsAtFrame(10) }),
      element({
        id: "audio",
        tag: "audio",
        track: 1,
        authoredTrack: 1,
        domId: "voice",
        hfId: undefined,
        selector: "#voice",
        src: "assets/voice.wav",
        start: 0,
      }),
    ];
    const first = bootstrapNativeProjectFromTimeline(input(rows));
    const repeated = bootstrapNativeProjectFromTimeline(input(rows));
    const reordered = bootstrapNativeProjectFromTimeline(input([...rows].reverse()));

    expect(first.ok && repeated.ok && reordered.ok).toBe(true);
    if (!first.ok || !repeated.ok || !reordered.ok) return;
    const firstBytes = serializeNativeProjectDocument(first.document);
    expect(serializeNativeProjectDocument(repeated.document)).toBe(firstBytes);
    expect(serializeNativeProjectDocument(reordered.document)).toBe(firstBytes);
    expect(first.document.sequence.tracks.at(-1)!.clips.map((clip) => clip.binding?.domId)).toEqual([
      "earlier",
      "later",
    ]);
  });

  it("groups visual and audio clips by authored track without packing away authored lanes", () => {
    const result = bootstrapNativeProjectFromTimeline(
      input([
        element({ track: 1, authoredTrack: 8, domId: "visual-8", hfId: undefined, selector: "#visual-8" }),
        element({
          tag: "audio",
          track: 2,
          authoredTrack: 8,
          domId: "audio-8",
          hfId: undefined,
          selector: "#audio-8",
          src: "assets/audio.wav",
        }),
        element({ track: 0, authoredTrack: 2, domId: "visual-2", hfId: undefined, selector: "#visual-2" }),
      ]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.sequence.tracks.map((track) => track.id)).toEqual([
      expect.stringContaining("2"),
      expect.stringMatching(/8.*audio/),
      expect.stringMatching(/8.*video/),
    ]);
    expect(result.document.sequence.tracks.map((track) => track.lane)).toEqual([
      { authoredTrack: 2, displayTrack: 0 },
      { authoredTrack: 8, displayTrack: 2 },
      { authoredTrack: 8, displayTrack: 1 },
    ]);
  });

  it("keeps conflicting authored/display lane mappings legacy-only instead of guessing", () => {
    const result = bootstrapNativeProjectFromTimeline(
      input([
        element({ id: "one", track: 0, authoredTrack: 8, domId: "one", hfId: undefined, selector: "#one" }),
        element({ id: "two", track: 1, authoredTrack: 8, domId: "two", hfId: undefined, selector: "#two" }),
        element({ id: "three", track: 0, authoredTrack: 9, domId: "three", hfId: undefined, selector: "#three" }),
      ]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.sequence.tracks).toEqual([]);
    expect(result.document.assets).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "invalid-track", elementId: "one" }),
      expect.objectContaining({ code: "invalid-track", elementId: "three" }),
      expect.objectContaining({ code: "invalid-track", elementId: "two" }),
    ]);
  });

  it.each([
    [element({ sourceFile: undefined }), "missing-source-file"],
    [
      element({ domId: undefined, hfId: undefined, selector: undefined, selectorIndex: undefined }),
      "missing-exact-binding",
    ],
    [element({ selector: undefined, selectorIndex: 1 }), "invalid-selector-index"],
    [element({ src: undefined }), "missing-media-source"],
  ] as const)("keeps unbindable rows legacy-only with diagnostic %s", (row, code) => {
    const result = bootstrapNativeProjectFromTimeline(input([row]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.assets).toEqual([]);
    expect(result.document.sequence.tracks).toEqual([]);
    expect(result.diagnostics).toEqual([expect.objectContaining({ code, disposition: "legacy-only" })]);
  });

  it("diagnoses every duplicate exact binding and imports neither row rather than guessing", () => {
    const result = bootstrapNativeProjectFromTimeline(
      input([
        element({ id: "one", src: "assets/one.mov" }),
        element({ id: "two", src: "assets/two.mov", start: secondsAtFrame(100) }),
      ]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.assets).toEqual([]);
    expect(result.document.sequence.tracks).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "duplicate-binding", elementId: "one" }),
      expect.objectContaining({ code: "duplicate-binding", elementId: "two" }),
    ]);
  });

  it.each([
    [element({ start: Number.NaN }), "invalid-timing"],
    [element({ duration: Number.POSITIVE_INFINITY }), "invalid-timing"],
    [element({ duration: 0 }), "invalid-timing"],
    [element({ playbackStart: -1 }), "invalid-timing"],
    [element({ playbackRate: 0 }), "invalid-timing"],
    [element({ playbackRate: Number.NaN }), "invalid-timing"],
    [element({ track: 1.5, authoredTrack: undefined }), "invalid-track"],
  ] as const)("excludes invalid rows without corrupt partial clips: %s", (row, code) => {
    const valid = element({ id: "valid", domId: "valid", hfId: undefined, selector: "#valid" });
    const result = bootstrapNativeProjectFromTimeline(input([row, valid]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.sequence.tracks.flatMap((track) => track.clips)).toHaveLength(1);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code }));
    expect(() => serializeNativeProjectDocument(result.document)).not.toThrow();
  });

  it("returns structured project-level failure for an invalid rational frame rate", () => {
    const result = bootstrapNativeProjectFromTimeline({
      ...input([element()]),
      frameRate: { numerator: 29.97, denominator: 1 },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.document).toBeNull();
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ code: "invalid-project-settings", disposition: "project-fatal" }),
      ]);
    }
  });
});
