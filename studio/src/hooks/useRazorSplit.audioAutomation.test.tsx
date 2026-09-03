// @vitest-environment happy-dom

import { parseAutomation, sampleAutomationLane } from "@hyperframes/core/audio-automation";
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
import { splitAudioAutomation } from "../utils/splitAudioAutomation";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const frameRate = { numerator: 30, denominator: 1 } as const;

const originalAutomation = JSON.stringify({
  version: 1,
  lanes: [
    {
      target: "volume",
      points: [
        { t: 0, v: 0 },
        { t: 4, v: 1 },
        { t: 8, v: 0.5 },
      ],
    },
    {
      target: "fx.n1.frequency",
      points: [
        { t: 0, v: 100, curve: -0.25 },
        { t: 2, v: 200, curve: 0.4, viaX: 0.7, viaY: 0.35 },
        { t: 6, v: 600 },
      ],
    },
  ],
});

function nativeProject(): NativeProjectDocument {
  return parseNativeProjectDocument({
    schemaVersion: NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
    id: "project:p1",
    revision: 0,
    frameRate,
    canvas: { width: 1920, height: 1080, background: "#000000" },
    assets: [{ id: "asset:audio", kind: "audio", name: "bed.wav", durationFrames: 600 }],
    sequence: {
      id: "sequence:main",
      name: "Main",
      tracks: [{
        id: "track:a1",
        kind: "audio",
        lane: { authoredTrack: 0, displayTrack: 0 },
        clips: [{
          id: "clip:audio",
          assetId: "asset:audio",
          binding: { sourceFile: "index.html", domId: "bed", hfId: "hf-bed" },
          startFrame: 30,
          durationFrames: 240,
          sourceInFrame: 15,
          playbackRate: { numerator: 2, denominator: 1 },
          muted: false,
          staticParameters: {},
          effects: [],
          parameterTracks: [],
        }],
      }],
    },
  });
}

const element: TimelineElement = {
  id: "bed",
  domId: "bed",
  hfId: "hf-bed",
  tag: "audio",
  kind: "audio",
  start: 1,
  duration: 8,
  playbackStart: 0.5,
  playbackRate: 2,
  track: 0,
  sourceFile: "index.html",
  timingSource: "authored",
};

function automationById(html: string, id: string) {
  const document = new DOMParser().parseFromString(html, "text/html");
  const raw = document.getElementById(id)?.getAttribute("data-automation");
  if (!raw) throw new Error(`Missing automation for ${id}`);
  return parseAutomation(raw);
}

async function runNativeSplit(html: string, splitTime = 4) {
  const native = nativeProject();
  const files = new Map<string, string>([
    [NATIVE_PROJECT_DOCUMENT_PATH, serializeNativeProjectDocument(native)],
    ["index.html", html],
  ]);
  const writeProjectFile = vi.fn(async (path: string, content: string, expected?: string) => {
    if (files.get(path) !== expected) throw new Error(`CAS conflict: ${path}`);
    files.set(path, content);
  });
  const recordEdit = vi.fn(async () => undefined);
  const showToast = vi.fn();
  let split: ((target: TimelineElement, time: number) => Promise<void>) | undefined;

  function Harness() {
    split = useRazorSplit({
      projectId: "p1",
      activeCompPath: "index.html",
      showToast,
      writeProjectFile,
      recordEdit,
      domEditSaveTimestampRef: { current: 0 },
      reloadPreview: vi.fn(),
      nativeProjectEditing: {
        nativeDocument: native,
        readOptionalProjectFile: async (path) => files.get(path),
        onNativeDocumentCommitted: vi.fn(),
      },
      nativeDocumentRef: { current: native },
    }).handleRazorSplit;
    return null;
  }

  const root = mountProbe(Harness);
  await act(async () => {
    await split!(element, splitTime);
  });
  act(() => root.unmount());
  return { files, recordEdit, showToast, writeProjectFile };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("useRazorSplit audio automation compatibility", () => {
  it("crops and rebases volume and FX lanes on the timeline-local split clock", async () => {
    const html = [
      '<div data-composition-id="main" data-duration="10">',
      `  <audio class="clip" id="bed" data-hf-id="hf-bed" data-start="1" data-duration="8" data-media-start="0.5" data-playback-rate="2" data-automation='${originalAutomation}'></audio>`,
      "</div>",
    ].join("\n");
    const { files, recordEdit } = await runNativeSplit(html);

    const savedHtml = files.get("index.html")!;
    const left = automationById(savedHtml, "bed");
    const right = automationById(savedHtml, "bed-split");
    expect(left.lanes[0]?.points).toEqual([
      { t: 0, v: 0 },
      { t: 3, v: 0.75 },
    ]);
    expect(right.lanes[0]?.points).toEqual([
      { t: 0, v: 0.75 },
      { t: 1, v: 1 },
      { t: 5, v: 0.5 },
    ]);
    expect(right.lanes[1]?.points[0]).toEqual(expect.objectContaining({
      t: 0,
      v: sampleAutomationLane(parseAutomation(originalAutomation).lanes[1]!, 3),
      curve: 0.4,
    }));
    expect(right.lanes[1]?.points.at(-1)).toEqual({ t: 3, v: 600 });
    expect(savedHtml).toContain('id="bed-split"');
    expect(savedHtml).toContain('data-media-start="6.5"');
    expect(recordEdit).toHaveBeenCalledWith(expect.objectContaining({
      files: expect.objectContaining({
        "index.html": { before: html, after: savedHtml },
      }),
    }));
    const originalVolume = parseAutomation(originalAutomation).lanes[0]!;
    const leftVolume = left.lanes[0]!;
    const rightVolume = right.lanes[0]!;
    for (const t of [0, 0.5, 1.5, 2.75, 3]) {
      expect(sampleAutomationLane(leftVolume, t)).toBeCloseTo(
        sampleAutomationLane(originalVolume, t),
        12,
      );
    }
    for (const t of [0, 0.25, 1, 2.5, 5]) {
      expect(sampleAutomationLane(rightVolume, t)).toBeCloseTo(
        sampleAutomationLane(originalVolume, t + 3),
        12,
      );
    }
    const originalFx = parseAutomation(originalAutomation).lanes[1]!;
    const rightFx = right.lanes[1]!;
    for (let index = 0; index <= 100; index += 1) {
      const t = (3 * index) / 100;
      expect(sampleAutomationLane(rightFx, t)).toBeCloseTo(
        sampleAutomationLane(originalFx, t + 3),
        8,
      );
    }
  });

  it("uses an exact boundary point once and retains its outgoing curve controls", () => {
    const source = parseAutomation(JSON.stringify({
      version: 1,
      lanes: [{
        target: "fx.n1.frequency",
        points: [
          { t: 0, v: 100 },
          { t: 3, v: 300, curve: -0.3, viaX: 0.4, viaY: 0.75 },
          { t: 7, v: 700 },
        ],
      }],
    }));
    const { left, right } = splitAudioAutomation(source, 3);

    expect(left.lanes[0]?.points).toEqual([
      { t: 0, v: 100 },
      { t: 3, v: 300, curve: -0.3, viaX: 0.4, viaY: 0.75 },
    ]);
    expect(right.lanes[0]?.points).toEqual([
      { t: 0, v: 300, curve: -0.3, viaX: 0.4, viaY: 0.75 },
      { t: 4, v: 700 },
    ]);
    for (const t of [0, 0.5, 1.75, 4]) {
      expect(sampleAutomationLane(right.lanes[0]!, t)).toBeCloseTo(
        sampleAutomationLane(source.lanes[0]!, t + 3),
        12,
      );
    }
  });

  it("rejects malformed automation before either project file is written", async () => {
    const html = [
      '<div data-composition-id="main" data-duration="10">',
      '  <audio class="clip" id="bed" data-hf-id="hf-bed" data-start="1" data-duration="8" data-media-start="0.5" data-automation="{nope"></audio>',
      "</div>",
    ].join("\n");
    const originalNative = serializeNativeProjectDocument(nativeProject());
    const { files, recordEdit, showToast, writeProjectFile } = await runNativeSplit(html);

    expect(files.get("index.html")).toBe(html);
    expect(files.get(NATIVE_PROJECT_DOCUMENT_PATH)).toBe(originalNative);
    expect(writeProjectFile).not.toHaveBeenCalled();
    expect(recordEdit).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining("Automation is not valid JSON"),
      "error",
    );
  });

  it("leaves clips without data-automation on the ordinary split path", async () => {
    const html = [
      '<div data-composition-id="main" data-duration="10">',
      '  <audio class="clip" id="bed" data-hf-id="hf-bed" data-start="1" data-duration="8" data-media-start="0.5"></audio>',
      "</div>",
    ].join("\n");
    const { files, recordEdit } = await runNativeSplit(html);
    const savedHtml = files.get("index.html")!;
    const saved = new DOMParser().parseFromString(savedHtml, "text/html");

    expect(saved.getElementById("bed")?.hasAttribute("data-automation")).toBe(false);
    expect(saved.getElementById("bed-split")?.hasAttribute("data-automation")).toBe(false);
    expect(recordEdit).toHaveBeenCalledWith(expect.objectContaining({
      files: expect.objectContaining({
        "index.html": { before: html, after: savedHtml },
      }),
    }));
  });
});
