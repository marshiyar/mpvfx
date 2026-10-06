import { expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  parseNativeProjectDocument,
  serializeNativeProjectDocument,
} from "../../../shared/project/nativeProjectDocument";
import { planSilenceRemoval } from "../timeline/removeSilence";
import { commitNativeTimelineSilenceCut } from "./nativeTimelineSilenceCutTransaction";

const original = parseNativeProjectDocument({
  schemaVersion: 1, id: "project:silence", revision: 0,
  frameRate: { numerator: 30, denominator: 1 },
  canvas: { width: 1920, height: 1080, background: "#000" },
  assets: [{ id: "asset:camera", kind: "video", name: "camera.mov", durationFrames: 300 }],
  sequence: { id: "sequence:main", name: "Main", tracks: [{
    id: "track:video", kind: "video", lane: { authoredTrack: 0, displayTrack: 0 }, clips: [{
      id: "clip:camera", assetId: "asset:camera",
      binding: { sourceFile: "index.html", domId: "camera", hfId: "hf-camera" },
      startFrame: 0, durationFrames: 120, sourceInFrame: 10,
      playbackRate: { numerator: 11, denominator: 8 }, muted: false,
      staticParameters: { opacity: 0.6 },
      effects: [{ id: "fx:grade", effectId: "blur", enabled: true }],
      parameterTracks: [],
    }],
  }] },
});
const source = '<main data-composition-id="main" data-duration="4"><video id="camera" data-hf-id="hf-camera" src="media/camera.mov" data-start="0" data-duration="4" data-media-start="0.3333333333333333" data-playback-rate="1.375" style="opacity:0.6"></video></main>';
const sourceStart = 10 / 30;
const plan = planSilenceRemoval(
  { start: 0, duration: 4, playbackStart: sourceStart, playbackRate: 11 / 8 },
  [{ start: sourceStart + 11 / 8, end: sourceStart + 2 * 11 / 8 }],
);

function memory(fail?: "source" | "history") {
  const files = new Map([
    [NATIVE_PROJECT_DOCUMENT_PATH, serializeNativeProjectDocument(original)],
    ["index.html", source],
  ]);
  const recordEdit = vi.fn(async () => {
    if (fail === "history") throw new Error("history failed");
  });
  const writeProjectFile = vi.fn(async (path: string, content: string, expected?: string) => {
    expect(files.get(path)).toBe(expected);
    if (fail === "source" && path === "index.html" && content !== source) throw new Error("source failed");
    files.set(path, content);
  });
  return { files, recordEdit, writeProjectFile };
}

function input(state: ReturnType<typeof memory>) {
  return {
    expectedRevision: 0,
    element: { attributes: { "data-studio-clip-id": "clip:camera" } },
    playbackElement: { kind: "video" as const },
    plan,
    readOptionalProjectFile: async (path: string) => state.files.get(path),
    writeProjectFile: state.writeProjectFile,
    recordEdit: state.recordEdit,
  };
}

it("persists tone-pause-tone as one undoable native and HTML edit with fractional source timing", async () => {
  const state = memory();
  const committed = await commitNativeTimelineSilenceCut(input(state));
  expect(committed.revision).toBe(1);
  const clips = committed.sequence.tracks.flatMap(track => track.clips).sort((a, b) => a.startFrame - b.startFrame);
  expect(clips).toHaveLength(2);
  expect(clips.map(clip => [clip.startFrame, clip.durationFrames])).toEqual([[0, 30], [30, 60]]);
  expect(clips.map(clip => clip.effects)).toEqual([
    [{ id: "fx:grade", effectId: "blur", enabled: true }],
    [{ id: "fx:grade", effectId: "blur", enabled: true }],
  ]);
  expect(clips[1]!.sourceInFraction).toEqual({ numerator: 1, denominator: 2 });
  expect(state.recordEdit).toHaveBeenCalledOnce();
  const history = state.recordEdit.mock.calls[0]![0];
  expect(history.label).toBe("Remove silence");
  expect(Object.keys(history.files).sort()).toEqual([NATIVE_PROJECT_DOCUMENT_PATH, "index.html"].sort());
  expect(state.files.get("index.html")).toContain('data-start="1"');
  expect(state.files.get("index.html")).not.toContain('data-start="2"');
  const reopened = parseNativeProjectDocument(JSON.parse(state.files.get(NATIVE_PROJECT_DOCUMENT_PATH)!));
  expect(reopened.revision).toBe(1);
  expect(reopened.sequence.tracks[0]!.clips).toHaveLength(2);
  expect(reopened.sequence.tracks[0]!.clips.find(clip => clip.startFrame === 30)?.sourceInFraction)
    .toEqual({ numerator: 1, denominator: 2 });
  const { document: authored } = parseHTML(state.files.get("index.html")!);
  const tail = [...authored.querySelectorAll("video")].find(node => node.getAttribute("data-start") === "1");
  expect(Number(tail?.getAttribute("data-media-start"))).toBeCloseTo(92.5 / 30, 12);

  // The single history snapshot is sufficient for Undo and Redo, including
  // the original source timing, effects and authored markup.
  for (const [path, snapshot] of Object.entries(history.files)) state.files.set(path, snapshot.before);
  expect(parseNativeProjectDocument(JSON.parse(state.files.get(NATIVE_PROJECT_DOCUMENT_PATH)!))).toEqual(original);
  expect(state.files.get("index.html")).toBe(source);
  for (const [path, snapshot] of Object.entries(history.files)) state.files.set(path, snapshot.after);
  expect(parseNativeProjectDocument(JSON.parse(state.files.get(NATIVE_PROJECT_DOCUMENT_PATH)!)).sequence.tracks[0]!.clips).toHaveLength(2);
});

it.each(["source", "history"] as const)("rolls back the whole silence action when %s fails", async failure => {
  const state = memory(failure);
  await expect(commitNativeTimelineSilenceCut(input(state))).rejects.toThrow(`${failure} failed`);
  expect(state.files.get(NATIVE_PROJECT_DOCUMENT_PATH)).toBe(serializeNativeProjectDocument(original));
  expect(state.files.get("index.html")).toBe(source);
});

it("rolls back when cancellation arrives between the two durable writes", async () => {
  const state = memory();
  const controller = new AbortController();
  const normalWrite = state.writeProjectFile;
  const writeProjectFile = async (path: string, content: string, expected?: string) => {
    await normalWrite(path, content, expected);
    if (path === NATIVE_PROJECT_DOCUMENT_PATH && content !== serializeNativeProjectDocument(original)) {
      controller.abort(new Error("silence cut cancelled"));
    }
  };
  await expect(commitNativeTimelineSilenceCut({
    ...input(state), writeProjectFile, signal: controller.signal,
  })).rejects.toThrow("silence cut cancelled");
  expect(state.files.get(NATIVE_PROJECT_DOCUMENT_PATH)).toBe(serializeNativeProjectDocument(original));
  expect(state.files.get("index.html")).toBe(source);
  expect(state.recordEdit).not.toHaveBeenCalled();
});

it("uses one server-backed commit for both files and one history entry", async () => {
  const state = memory();
  const commitFileTransaction = vi.fn(async ({ files, history }: {
    files: readonly { path: string; expectedBefore: string | null; after: string | null }[];
    history: { label: string };
  }) => {
    expect(history.label).toBe("Remove silence");
    expect(files.map(file => file.path)).toEqual([NATIVE_PROJECT_DOCUMENT_PATH, "index.html"]);
    for (const file of files) {
      expect(state.files.get(file.path)).toBe(file.expectedBefore);
      state.files.set(file.path, file.after!);
    }
  });
  await commitNativeTimelineSilenceCut({ ...input(state), commitFileTransaction });
  expect(commitFileTransaction).toHaveBeenCalledOnce();
  expect(state.writeProjectFile).not.toHaveBeenCalled();
  expect(state.recordEdit).not.toHaveBeenCalled();
  expect(parseNativeProjectDocument(JSON.parse(state.files.get(NATIVE_PROJECT_DOCUMENT_PATH)!)).sequence.tracks[0]!.clips)
    .toHaveLength(2);
});
