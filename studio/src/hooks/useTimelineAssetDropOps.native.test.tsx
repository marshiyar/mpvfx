// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
  parseNativeProjectDocument,
  serializeNativeProjectDocument,
  type NativeProjectDocument,
} from "../project/nativeProjectDocument";
import type { CommitNativeTimelineFileTransaction } from "../project/nativeTimelineTransactionCommit";
import { usePlayerStore } from "../player";
import { useTimelineAssetDropOps } from "./useTimelineAssetDropOps";

const mediaProbe = vi.hoisted(() => ({ duration: 4.004 }));

vi.mock("../utils/studioHelpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/studioHelpers")>();
  return { ...actual, resolveDroppedAssetDuration: vi.fn(async () => mediaProbe.duration) };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const compatibilityBefore =
  '<div id="root" data-composition-id="main" data-duration="2" data-width="1920" data-height="1080"></div>';

function emptyNativeProject(): NativeProjectDocument {
  return parseNativeProjectDocument({
    schemaVersion: NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
    id: "project:native-drop",
    revision: 0,
    frameRate: { numerator: 30_000, denominator: 1_001 },
    canvas: { width: 1920, height: 1080, background: "#000000" },
    assets: [],
    sequence: { id: "sequence:main", name: "Main", tracks: [] },
  });
}

async function mountNativeHarness(options?: {
  failCommit?: boolean;
  uploads?: string[];
  nativeDisabled?: boolean;
  nativeDocument?: NativeProjectDocument;
}) {
  const native = options?.nativeDocument ?? emptyNativeProject();
  const files = new Map<string, string>([
    [NATIVE_PROJECT_DOCUMENT_PATH, serializeNativeProjectDocument(native)],
    ["index.html", compatibilityBefore],
  ]);
  const showToast = vi.fn();
  const reloadPreview = vi.fn();
  const forceReloadSdkSession = vi.fn();
  const onNativeDocumentCommitted = vi.fn();
  const writeProjectFile = vi.fn(async (path: string, content: string) => {
    if (!options?.nativeDisabled) {
      throw new Error("native insertion must not escape to the legacy writer");
    }
    files.set(path, content);
  });
  const recordEdit = vi.fn(async () => {
    if (!options?.nativeDisabled) {
      throw new Error("durable insertion must not create a second browser history entry");
    }
  });
  const commitFileTransaction = vi.fn(
    async (input: Parameters<CommitNativeTimelineFileTransaction>[0]) => {
      if (options?.failCommit) throw new Error("durable commit failed");
      for (const file of input.files) {
        expect(files.get(file.path) ?? null).toBe(file.expectedBefore);
      }
      for (const file of input.files) {
        if (file.after === null) files.delete(file.path);
        else files.set(file.path, file.after);
      }
    },
  );
  const uploadProjectFiles = vi.fn(async () => options?.uploads ?? []);
  const captured: { current: ReturnType<typeof useTimelineAssetDropOps> | null } = {
    current: null,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ content: files.get("index.html") })),
  );

  function Probe(): null {
    captured.current = useTimelineAssetDropOps({
      projectIdRef: { current: "native-drop" },
      activeCompPath: "index.html",
      timelineElements: [],
      showToast,
      writeProjectFile,
      recordEdit,
      domEditSaveTimestampRef: { current: 0 },
      reloadPreview,
      uploadProjectFiles,
      forceReloadSdkSession,
      nativeProjectEditing: {
        nativeDocument: options?.nativeDisabled ? null : native,
        readOptionalProjectFile: async (path) => files.get(path),
        commitFileTransaction,
        onNativeDocumentCommitted,
      },
      nativeDocumentRef: { current: options?.nativeDisabled ? null : native },
      editQueueRef: { current: Promise.resolve() },
    });
    return null;
  }

  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  if (!captured.current) throw new Error("native timeline drop hook did not mount");
  return {
    hook: captured.current,
    root,
    files,
    showToast,
    reloadPreview,
    forceReloadSdkSession,
    onNativeDocumentCommitted,
    writeProjectFile,
    recordEdit,
    commitFileTransaction,
  };
}

describe("native timeline asset drop integration", () => {
  beforeEach(() => { mediaProbe.duration = 4.004; });
  afterEach(() => {
    usePlayerStore.getState().reset();
    vi.unstubAllGlobals();
  });

  it("commits one library drop as one exact native and compatibility transaction", async () => {
    const harness = await mountNativeHarness();

    await act(async () => {
      await harness.hook.handleTimelineAssetDrop("media/camera.mov", {
        start: 2.535,
        track: 2,
      });
    });

    expect(harness.commitFileTransaction).toHaveBeenCalledOnce();
    expect(harness.commitFileTransaction).toHaveBeenCalledWith({
      files: [
        expect.objectContaining({ path: NATIVE_PROJECT_DOCUMENT_PATH }),
        expect.objectContaining({ path: "index.html" }),
      ],
      history: { label: "Add timeline asset", kind: "timeline" },
    });
    const saved = parseNativeProjectDocument(
      JSON.parse(harness.files.get(NATIVE_PROJECT_DOCUMENT_PATH)!),
    );
    const clip = saved.sequence.tracks.flatMap((track) => track.clips)[0];
    expect(saved.revision).toBe(1);
    expect(clip).toMatchObject({
      startFrame: 75,
      durationFrames: 120,
      sourceInFrame: 0,
      playbackRate: { numerator: 1, denominator: 1 },
      muted: false,
      effects: [],
      parameterTracks: [],
    });
    const html = harness.files.get("index.html")!;
    expect(html).toContain(`id="${clip?.binding?.domId}"`);
    expect(html).toContain(`data-hf-id="${clip?.binding?.hfId}"`);
    expect(clip?.binding?.sourceFile).toBe("index.html");
    expect(html).toContain('data-start="2.5025"');
    expect(html).toContain('data-duration="4.004"');
    expect(html).not.toMatch(/<video[^>]*\smuted(?:\s|=|>)/i);
    expect(harness.writeProjectFile).not.toHaveBeenCalled();
    expect(harness.recordEdit).not.toHaveBeenCalled();
    expect(harness.onNativeDocumentCommitted).toHaveBeenCalledOnce();
    expect(harness.forceReloadSdkSession).toHaveBeenCalledOnce();
    expect(harness.reloadPreview).toHaveBeenCalledOnce();
    expect(harness.showToast).not.toHaveBeenCalled();
    await act(async () => harness.root.unmount());
  });

  it("batches an OS multi-file drop into one revision and one durable history entry", async () => {
    const harness = await mountNativeHarness({
      uploads: ["media/a.mov", "media/b.mp4"],
    });

    await act(async () => {
      await harness.hook.handleTimelineFileDrop(
        [new File(["a"], "a.mov"), new File(["b"], "b.mp4")],
        { start: 2.002, track: 1 },
      );
    });

    expect(harness.commitFileTransaction).toHaveBeenCalledOnce();
    expect(harness.commitFileTransaction.mock.calls[0]?.[0].history).toEqual({
      label: "Add timeline assets",
      kind: "timeline",
    });
    const saved = parseNativeProjectDocument(
      JSON.parse(harness.files.get(NATIVE_PROJECT_DOCUMENT_PATH)!),
    );
    expect(saved.revision).toBe(1);
    const clips = saved.sequence.tracks.flatMap((track) => track.clips);
    expect(clips).toHaveLength(2);
    expect(clips.map((clip) => [clip.startFrame, clip.durationFrames])).toEqual([
      [60, 120],
      [180, 120],
    ]);
    for (const clip of clips) {
      expect(clip.binding?.sourceFile).toBe("index.html");
      expect(harness.files.get("index.html")).toContain(`id="${clip.binding?.domId}"`);
      expect(harness.files.get("index.html")).toContain(`data-hf-id="${clip.binding?.hfId}"`);
    }
    expect(harness.files.get("index.html")?.match(/<(?:video|audio|img)\b/g)).toHaveLength(2);
    expect(harness.onNativeDocumentCommitted).toHaveBeenCalledOnce();
    expect(harness.forceReloadSdkSession).toHaveBeenCalledOnce();
    expect(harness.reloadPreview).toHaveBeenCalledOnce();
    await act(async () => harness.root.unmount());
  });

  it("accumulates multi-file placements from quantized duration frames", async () => {
    mediaProbe.duration = 1.02;
    const native = emptyNativeProject();
    native.frameRate = { numerator: 30, denominator: 1 };
    const harness = await mountNativeHarness({
      nativeDocument: native,
      uploads: ["media/a.mov", "media/b.mov", "media/c.mov"],
    });

    await act(async () => {
      await harness.hook.handleTimelineFileDrop(
        [
          new File(["a"], "a.mov"),
          new File(["b"], "b.mov"),
          new File(["c"], "c.mov"),
        ],
        { start: 0, track: 1 },
      );
    });

    const saved = parseNativeProjectDocument(
      JSON.parse(harness.files.get(NATIVE_PROJECT_DOCUMENT_PATH)!),
    );
    expect(
      saved.sequence.tracks.flatMap((track) => track.clips)
        .map((clip) => [clip.startFrame, clip.durationFrames]),
    ).toEqual([[0, 30], [30, 30], [60, 30]]);
    await act(async () => harness.root.unmount());
  });

  it("does not fall back, publish, or reload when the durable native commit rejects", async () => {
    const harness = await mountNativeHarness({ failCommit: true });

    await act(async () => {
      await harness.hook.handleTimelineAssetDrop("media/camera.mov", { start: 0, track: 0 });
    });

    expect(harness.files.get("index.html")).toBe(compatibilityBefore);
    expect(
      parseNativeProjectDocument(JSON.parse(harness.files.get(NATIVE_PROJECT_DOCUMENT_PATH)!))
        .revision,
    ).toBe(0);
    expect(harness.writeProjectFile).not.toHaveBeenCalled();
    expect(harness.recordEdit).not.toHaveBeenCalled();
    expect(harness.onNativeDocumentCommitted).not.toHaveBeenCalled();
    expect(harness.forceReloadSdkSession).not.toHaveBeenCalled();
    expect(harness.reloadPreview).not.toHaveBeenCalled();
    expect(harness.showToast).toHaveBeenCalledWith("durable commit failed", "error");
    await act(async () => harness.root.unmount());
  });

  it("rejects an audio drop onto a video lane before any durable or published change", async () => {
    const native = parseNativeProjectDocument({
      ...emptyNativeProject(),
      sequence: {
        ...emptyNativeProject().sequence,
        tracks: [
          {
            id: "track:video:zero",
            kind: "video",
            lane: { authoredTrack: 0, displayTrack: 0 },
            clips: [],
          },
        ],
      },
    });
    const harness = await mountNativeHarness({ nativeDocument: native });

    await act(async () => {
      await harness.hook.handleTimelineAssetDrop("media/voiceover.mp3", {
        start: 0,
        track: 0,
      });
    });

    expect(harness.files.get("index.html")).toBe(compatibilityBefore);
    expect(harness.files.get(NATIVE_PROJECT_DOCUMENT_PATH)).toBe(
      serializeNativeProjectDocument(native),
    );
    expect(harness.commitFileTransaction).not.toHaveBeenCalled();
    expect(harness.writeProjectFile).not.toHaveBeenCalled();
    expect(harness.recordEdit).not.toHaveBeenCalled();
    expect(harness.onNativeDocumentCommitted).not.toHaveBeenCalled();
    expect(harness.forceReloadSdkSession).not.toHaveBeenCalled();
    expect(harness.reloadPreview).not.toHaveBeenCalled();
    expect(harness.showToast).toHaveBeenCalledWith(
      "Cannot add media to track 0 because that track contains a different media type.",
      "error",
    );
    await act(async () => harness.root.unmount());
  });

  it("does not publish or reload until the durable transaction has resolved", async () => {
    const harness = await mountNativeHarness();
    const baseCommit = harness.commitFileTransaction.getMockImplementation();
    if (!baseCommit) throw new Error("expected durable commit implementation");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    harness.commitFileTransaction.mockImplementationOnce(async (input) => {
      await gate;
      await baseCommit(input);
    });

    let pending!: Promise<void>;
    act(() => {
      pending = harness.hook.handleTimelineAssetDrop("media/camera.mov", {
        start: 0,
        track: 0,
      });
    });
    await vi.waitFor(() => expect(harness.commitFileTransaction).toHaveBeenCalledOnce());
    expect(harness.onNativeDocumentCommitted).not.toHaveBeenCalled();
    expect(harness.forceReloadSdkSession).not.toHaveBeenCalled();
    expect(harness.reloadPreview).not.toHaveBeenCalled();

    await act(async () => {
      release();
      await pending;
    });
    expect(harness.onNativeDocumentCommitted).toHaveBeenCalledOnce();
    expect(harness.forceReloadSdkSession).toHaveBeenCalledOnce();
    expect(harness.reloadPreview).toHaveBeenCalledOnce();
    await act(async () => harness.root.unmount());
  });

  it("rebases once onto a newer same-project revision before inserting", async () => {
    const harness = await mountNativeHarness();
    const persisted = parseNativeProjectDocument(
      JSON.parse(harness.files.get(NATIVE_PROJECT_DOCUMENT_PATH)!),
    );
    persisted.revision = 1;
    persisted.canvas.background = "#123456";
    harness.files.set(NATIVE_PROJECT_DOCUMENT_PATH, serializeNativeProjectDocument(persisted));

    await act(async () => {
      await harness.hook.handleTimelineAssetDrop("media/camera.mov", { start: 0, track: 0 });
    });

    const saved = parseNativeProjectDocument(
      JSON.parse(harness.files.get(NATIVE_PROJECT_DOCUMENT_PATH)!),
    );
    expect(saved.revision).toBe(2);
    expect(saved.canvas.background).toBe("#123456");
    expect(harness.commitFileTransaction).toHaveBeenCalledOnce();
    expect(harness.onNativeDocumentCommitted).toHaveBeenCalledOnce();
    expect(harness.reloadPreview).toHaveBeenCalledOnce();
    await act(async () => harness.root.unmount());
  });

  it("keeps the characterized legacy path when native dependencies exist without a persisted document", async () => {
    const harness = await mountNativeHarness({ nativeDisabled: true });

    await act(async () => {
      await harness.hook.handleTimelineAssetDrop("media/camera.mov", { start: 1, track: 0 });
    });

    expect(harness.commitFileTransaction).not.toHaveBeenCalled();
    expect(harness.onNativeDocumentCommitted).not.toHaveBeenCalled();
    expect(harness.writeProjectFile).toHaveBeenCalledOnce();
    expect(harness.recordEdit).toHaveBeenCalledOnce();
    expect(harness.files.get("index.html")).toContain('<video id="camera"');
    expect(harness.forceReloadSdkSession).toHaveBeenCalledOnce();
    expect(harness.reloadPreview).toHaveBeenCalledOnce();
    await act(async () => harness.root.unmount());
  });

  it("keeps legacy multi-file placement and durations on declared project frames", async () => {
    mediaProbe.duration = 1.02;
    usePlayerStore.getState().setTimelineFrameRate({ numerator: 30, denominator: 1 });
    const harness = await mountNativeHarness({
      nativeDisabled: true,
      uploads: ["media/a.mov", "media/b.mov", "media/c.mov"],
    });

    await act(async () => {
      await harness.hook.handleTimelineFileDrop(
        [
          new File(["a"], "a.mov"),
          new File(["b"], "b.mov"),
          new File(["c"], "c.mov"),
        ],
        { start: 0, track: 1 },
      );
    });

    const html = harness.files.get("index.html")!;
    expect([...html.matchAll(/data-start="([^"]+)"/g)]
      .map((match) => Number(match[1]))
      .sort((left, right) => left - right))
      .toEqual([0, 1, 2]);
    expect([...html.matchAll(/data-duration="([^"]+)"/g)].slice(1).map((match) => Number(match[1])))
      .toEqual([1, 1, 1]);
    await act(async () => harness.root.unmount());
  });
});
