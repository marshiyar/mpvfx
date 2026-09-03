// @vitest-environment happy-dom

import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TimelineElement } from "../player";
import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
  parseNativeProjectDocument,
  serializeNativeProjectDocument,
  type NativeProjectDocument,
} from "../project/nativeProjectDocument";
import { useRazorSplit } from "./useRazorSplit";
import { mountProbe } from "./useRazorSplit.testHelpers";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const frameRate = { numerator: 30_000, denominator: 1_001 } as const;
const secondsAtFrame = (frame: number): number =>
  (frame * frameRate.denominator) / frameRate.numerator;

function nativeSplitProject(revision = 0): NativeProjectDocument {
  return parseNativeProjectDocument({
    schemaVersion: NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
    id: "project:p1",
    revision,
    frameRate,
    canvas: { width: 1920, height: 1080, background: "#000000" },
    assets: [{ id: "asset:clip", kind: "video", name: "clip.mov", durationFrames: 900 }],
    sequence: {
      id: "sequence:main",
      name: "Main",
      tracks: [{
        id: "track:v1",
        kind: "video",
        lane: { authoredTrack: 0, displayTrack: 0 },
        clips: [{
          id: "clip:native",
          assetId: "asset:clip",
          binding: { sourceFile: "index.html", domId: "clip", hfId: "hf-clip" },
          startFrame: 30,
          durationFrames: 120,
          sourceInFrame: 10,
          playbackRate: { numerator: 2, denominator: 1 },
          muted: false,
          staticParameters: { opacity: 0.75 },
          effects: [{ id: "fx:blur", effectId: "blur", enabled: true }],
          parameterTracks: [],
        }],
      }],
    },
  });
}

const element: TimelineElement = {
  id: "clip",
  domId: "clip",
  hfId: "hf-clip",
  tag: "video",
  kind: "video",
  start: secondsAtFrame(30),
  duration: secondsAtFrame(120),
  playbackStart: secondsAtFrame(10),
  playbackRate: 2,
  track: 0,
  sourceFile: "index.html",
  timingSource: "authored",
};

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("useRazorSplit native-canonical integration", () => {
  it.each([
    {
      label: "60fps one-frame head",
      rate: { numerator: 60, denominator: 1 },
      requestedSplitSeconds: 61 / 60,
      expectedSplitFrame: 61,
    },
    {
      label: "24fps quantized tail frame inside the seconds epsilon",
      rate: { numerator: 24, denominator: 1 },
      requestedSplitSeconds: 180 / 24 - 0.02,
      expectedSplitFrame: 179,
    },
  ])("uses native frame validity at the $label boundary", async ({
    rate,
    requestedSplitSeconds,
    expectedSplitFrame,
  }) => {
    const base = nativeSplitProject();
    const native = parseNativeProjectDocument({
      ...base,
      frameRate: rate,
      sequence: {
        ...base.sequence,
        tracks: base.sequence.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) => ({
            ...clip,
            startFrame: 60,
            durationFrames: 120,
            sourceInFrame: 0,
            playbackRate: { numerator: 1, denominator: 1 },
          })),
        })),
      },
    });
    const seconds = (frame: number) => (frame * rate.denominator) / rate.numerator;
    const html = [
      `<div data-composition-id="main" data-duration="${seconds(180)}">`,
      `  <video class="clip" id="clip" data-hf-id="hf-clip" data-start="${seconds(60)}" data-duration="${seconds(120)}" data-media-start="0"></video>`,
      "</div>",
    ].join("\n");
    const files = new Map<string, string>([
      [NATIVE_PROJECT_DOCUMENT_PATH, serializeNativeProjectDocument(native)],
      ["index.html", html],
    ]);
    const writeProjectFile = vi.fn(async (path: string, content: string, expected?: string) => {
      if (files.get(path) !== expected) throw new Error(`CAS conflict: ${path}`);
      files.set(path, content);
    });
    const nativeDocumentRef = { current: native as NativeProjectDocument | null };
    let split: ((target: TimelineElement, splitTime: number) => Promise<void>) | undefined;

    function Harness() {
      split = useRazorSplit({
        projectId: "p1",
        activeCompPath: "index.html",
        showToast: vi.fn(),
        writeProjectFile,
        recordEdit: vi.fn(async () => undefined),
        domEditSaveTimestampRef: { current: 0 },
        reloadPreview: vi.fn(),
        nativeProjectEditing: {
          nativeDocument: native,
          readOptionalProjectFile: async (path) => files.get(path),
          onNativeDocumentCommitted: vi.fn(),
        },
        nativeDocumentRef,
      }).handleRazorSplit;
      return null;
    }

    const boundaryElement: TimelineElement = {
      ...element,
      start: seconds(60),
      duration: seconds(120),
      playbackStart: 0,
      playbackRate: 1,
    };
    const root = mountProbe(Harness);
    await act(async () => {
      await split!(boundaryElement, requestedSplitSeconds);
    });

    const saved = parseNativeProjectDocument(
      JSON.parse(files.get(NATIVE_PROJECT_DOCUMENT_PATH)!),
    );
    expect(saved.revision).toBe(1);
    expect(saved.sequence.tracks[0]!.clips.map((clip) => clip.startFrame)).toEqual([
      60,
      expectedSplitFrame,
    ]);

    act(() => root.unmount());
  });

  it("splits an exact bound clip without the server/GSAP path and persists the actual collision-safe binding", async () => {
    const native = nativeSplitProject();
    const html = [
      `<div data-composition-id="main" data-duration="${secondsAtFrame(150)}">`,
      `  <video class="clip" id="clip" data-hf-id="hf-clip" data-start="${secondsAtFrame(30)}" data-duration="${secondsAtFrame(120)}" data-media-start="${secondsAtFrame(10)}"></video>`,
      "  <div id=\"clip-split\"></div>",
      "</div>",
    ].join("\n");
    const files = new Map<string, string>([
      [NATIVE_PROJECT_DOCUMENT_PATH, serializeNativeProjectDocument(native)],
      ["index.html", html],
    ]);
    const writeProjectFile = vi.fn(async (path: string, content: string, expected?: string) => {
      if (files.get(path) !== expected) throw new Error(`CAS conflict: ${path}`);
      files.set(path, content);
    });
    const recordEdit = vi.fn(async () => undefined);
    const onNativeDocumentCommitted = vi.fn();
    const reloadPreview = vi.fn();
    const forceReloadSdkSession = vi.fn();
    const showToast = vi.fn();
    const fetchMock = vi.fn(async () => {
      throw new Error("native split must not use the legacy split server");
    });
    vi.stubGlobal("fetch", fetchMock);
    const nativeDocumentRef = { current: native as NativeProjectDocument | null };
    let split: ((target: TimelineElement, splitTime: number) => Promise<void>) | undefined;

    function Harness() {
      split = useRazorSplit({
        projectId: "p1",
        activeCompPath: "index.html",
        showToast,
        writeProjectFile,
        recordEdit,
        domEditSaveTimestampRef: { current: 0 },
        reloadPreview,
        forceReloadSdkSession,
        nativeProjectEditing: {
          nativeDocument: native,
          readOptionalProjectFile: async (path) => files.get(path),
          onNativeDocumentCommitted,
        },
        nativeDocumentRef,
      }).handleRazorSplit;
      return null;
    }

    const root = mountProbe(Harness);
    await act(async () => {
      await split!(element, secondsAtFrame(60));
    });

    expect(fetchMock).not.toHaveBeenCalled();
    const saved = parseNativeProjectDocument(
      JSON.parse(files.get(NATIVE_PROJECT_DOCUMENT_PATH)!),
    );
    expect(saved.revision).toBe(1);
    expect(saved.sequence.tracks[0]!.clips).toEqual([
      expect.objectContaining({
        id: "clip:native",
        startFrame: 30,
        durationFrames: 30,
        sourceInFrame: 10,
        staticParameters: { opacity: 0.75 },
        effects: [{ id: "fx:blur", effectId: "blur", enabled: true }],
      }),
      expect.objectContaining({
        startFrame: 60,
        durationFrames: 90,
        sourceInFrame: 70,
        binding: { sourceFile: "index.html", domId: "clip-split-2" },
        staticParameters: { opacity: 0.75 },
        effects: [{ id: "fx:blur", effectId: "blur", enabled: true }],
      }),
    ]);
    const savedHtml = files.get("index.html")!;
    expect(savedHtml).toContain(`id="clip"`);
    expect(savedHtml).toContain(`data-start="${secondsAtFrame(30)}"`);
    expect(savedHtml).toContain(`data-duration="${secondsAtFrame(30)}"`);
    expect(savedHtml).toContain(`id="clip-split-2"`);
    expect(savedHtml).toContain(`data-start="${secondsAtFrame(60)}"`);
    expect(savedHtml).toContain(`data-duration="${secondsAtFrame(90)}"`);
    expect(savedHtml).toContain(`data-media-start="${secondsAtFrame(70)}"`);
    expect(recordEdit).toHaveBeenCalledOnce();
    expect(recordEdit).toHaveBeenCalledWith(expect.objectContaining({
      label: "Split timeline clip",
      kind: "timeline",
      files: expect.objectContaining({
        [NATIVE_PROJECT_DOCUMENT_PATH]: expect.any(Object),
        "index.html": expect.any(Object),
      }),
    }));
    expect(onNativeDocumentCommitted).toHaveBeenCalledOnce();
    expect(nativeDocumentRef.current?.revision).toBe(1);
    expect(forceReloadSdkSession).toHaveBeenCalledOnce();
    expect(reloadPreview).toHaveBeenCalledOnce();
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining("Split"), "info");

    act(() => root.unmount());
  });
});
