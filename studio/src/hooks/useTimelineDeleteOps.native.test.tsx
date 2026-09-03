// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TimelineElement } from "../player";
import { usePlayerStore } from "../player";
import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
  parseNativeProjectDocument,
  serializeNativeProjectDocument,
  type NativeProjectDocument,
} from "../project/nativeProjectDocument";
import { useTimelineDeleteOps } from "./useTimelineDeleteOps";
import { mountProbe } from "./useRazorSplit.testHelpers";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const clipA: TimelineElement = {
  id: "clip-a", domId: "clip-a", hfId: "hf-a", tag: "video", kind: "video",
  start: 0, duration: 2, track: 0, sourceFile: "index.html", timingSource: "authored",
};
const clipB: TimelineElement = {
  id: "clip-b", domId: "clip-b", hfId: "hf-b", tag: "audio", kind: "audio",
  start: 1, duration: 3, track: 1, sourceFile: "scenes/b.html", timingSource: "authored",
};
const keep: TimelineElement = {
  id: "keep", domId: "keep", tag: "div", start: 0, duration: 1, track: 2,
  sourceFile: "index.html", timingSource: "authored",
};

function nativeDeleteProject(): NativeProjectDocument {
  return parseNativeProjectDocument({
    schemaVersion: NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
    id: "project:p1",
    revision: 0,
    frameRate: { numerator: 30, denominator: 1 },
    canvas: { width: 1920, height: 1080, background: "#000000" },
    assets: [
      { id: "asset:a", kind: "video", name: "a.mov", durationFrames: 300 },
      { id: "asset:b", kind: "audio", name: "b.wav", durationFrames: 300 },
    ],
    sequence: {
      id: "sequence:main",
      name: "Main",
      tracks: [{
        id: "track:v1", kind: "video", lane: { authoredTrack: 0, displayTrack: 0 },
        clips: [{
          id: "native:a", assetId: "asset:a",
          binding: { sourceFile: "index.html", domId: "clip-a", hfId: "hf-a" },
          startFrame: 0, durationFrames: 60, sourceInFrame: 0, muted: false,
          staticParameters: { opacity: 0.7 }, effects: [], parameterTracks: [],
        }],
      }, {
        id: "track:a1", kind: "audio", lane: { authoredTrack: 1, displayTrack: 1 },
        clips: [{
          id: "native:b", assetId: "asset:b",
          binding: { sourceFile: "scenes/b.html", domId: "clip-b", hfId: "hf-b" },
          startFrame: 30, durationFrames: 90, sourceInFrame: 0, muted: false,
          staticParameters: { "audio.volume": 0.8 }, effects: [], parameterTracks: [],
        }],
      }],
    },
  });
}

afterEach(() => {
  document.body.innerHTML = "";
  usePlayerStore.getState().reset();
  vi.unstubAllGlobals();
});

describe("useTimelineDeleteOps native-canonical integration", () => {
  it("deletes a multi-file native selection as one undoable operation without legacy mutation requests", async () => {
    const native = nativeDeleteProject();
    const nativeBefore = serializeNativeProjectDocument(native);
    const indexBefore = '<main data-composition-id="main" data-duration="4"><video class="clip" id="clip-a" data-hf-id="hf-a" data-start="0" data-duration="2"></video><div class="clip" id="keep" data-start="0" data-duration="1"></div></main>';
    const sceneBefore = '<main data-composition-id="b" data-duration="4"><audio class="clip" id="clip-b" data-hf-id="hf-b" data-start="1" data-duration="3"></audio></main>';
    const files = new Map<string, string>([
      [NATIVE_PROJECT_DOCUMENT_PATH, nativeBefore],
      ["index.html", indexBefore],
      ["scenes/b.html", sceneBefore],
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
      throw new Error("native delete must not use the legacy remove-element route");
    });
    vi.stubGlobal("fetch", fetchMock);
    usePlayerStore.getState().setElements([clipA, clipB, keep]);
    usePlayerStore.getState().setDuration(4);
    const nativeDocumentRef = { current: native as NativeProjectDocument | null };
    let suppliedDocument = native;
    let removeMany: ((selection: TimelineElement[]) => Promise<void>) | undefined;

    function Harness() {
      removeMany = useTimelineDeleteOps({
        projectIdRef: { current: "p1" },
        activeCompPath: "index.html",
        timelineElements: [clipA, clipB, keep],
        showToast,
        writeProjectFile,
        recordEdit,
        domEditSaveTimestampRef: { current: 0 },
        reloadPreview,
        forceReloadSdkSession,
        previewIframeRef: { current: null },
        nativeProjectEditing: {
          nativeDocument: suppliedDocument,
          readOptionalProjectFile: async (path) => files.get(path),
          onNativeDocumentCommitted,
        },
        nativeDocumentRef,
      }).handleTimelineElementsDelete;
      return null;
    }

    const root = mountProbe(Harness);
    await act(async () => {
      await removeMany!([clipA, clipB]);
    });

    expect(fetchMock).not.toHaveBeenCalled();
    const saved = parseNativeProjectDocument(
      JSON.parse(files.get(NATIVE_PROJECT_DOCUMENT_PATH)!),
    );
    expect(saved.revision).toBe(1);
    expect(saved.sequence.tracks.flatMap((track) => track.clips)).toEqual([]);
    expect(files.get("index.html")).not.toContain('id="clip-a"');
    expect(files.get("index.html")).toContain('id="keep"');
    expect(files.get("index.html")).toContain('data-duration="1"');
    expect(files.get("scenes/b.html")).not.toContain('id="clip-b"');
    expect(recordEdit).toHaveBeenCalledOnce();
    expect(recordEdit).toHaveBeenCalledWith(expect.objectContaining({
      label: "Delete timeline clips",
      kind: "timeline",
      files: expect.objectContaining({
        [NATIVE_PROJECT_DOCUMENT_PATH]: expect.any(Object),
        "index.html": expect.any(Object),
        "scenes/b.html": expect.any(Object),
      }),
    }));
    expect(usePlayerStore.getState().elements.map((candidate) => candidate.id)).toEqual(["keep"]);
    expect(usePlayerStore.getState().duration).toBe(1);
    expect(onNativeDocumentCommitted).toHaveBeenCalledOnce();
    expect(nativeDocumentRef.current?.revision).toBe(1);
    expect(forceReloadSdkSession).toHaveBeenCalledOnce();
    expect(reloadPreview).toHaveBeenCalledOnce();
    expect(showToast).toHaveBeenCalledWith(
      "Deleted 2 clips. Use Undo to restore them.",
      "info",
    );

    // Simulate Undo restoring exact revision-zero bytes, followed by the
    // session publishing a newly parsed lower-revision object. The next delete
    // must still use the native transaction; falling back to the legacy route
    // here would recreate HTML/sidecar divergence.
    files.set(NATIVE_PROJECT_DOCUMENT_PATH, nativeBefore);
    files.set("index.html", indexBefore);
    files.set("scenes/b.html", sceneBefore);
    suppliedDocument = parseNativeProjectDocument(JSON.parse(nativeBefore));
    usePlayerStore.getState().setElements([clipA, clipB, keep]);
    usePlayerStore.getState().setDuration(4);
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {
      await removeMany!([clipA]);
    });

    expect(fetchMock).not.toHaveBeenCalled();
    const afterUndoDelete = parseNativeProjectDocument(
      JSON.parse(files.get(NATIVE_PROJECT_DOCUMENT_PATH)!),
    );
    expect(afterUndoDelete.revision).toBe(1);
    expect(afterUndoDelete.sequence.tracks.flatMap((track) => track.clips).map((clip) => clip.id))
      .toEqual(["native:b"]);
    expect(recordEdit).toHaveBeenCalledTimes(2);
    expect(onNativeDocumentCommitted).toHaveBeenCalledTimes(2);

    act(() => root.unmount());
  });
});
