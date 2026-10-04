// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { usePlayerStore, type TimelineElement } from "../../../player/index";
import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  parseNativeProjectDocument,
  serializeNativeProjectDocument,
} from "../../../../shared/project/nativeProjectDocument";
import { createAudioGroupAndAssignMembers } from "../timelineAudioGroupCreate";

afterEach(() => usePlayerStore.getState().reset());

function setup(secondVideoHasSound = true, secondKind: "video" | "audio" = "video") {
  const document = parseNativeProjectDocument({
    schemaVersion: 1,
    id: "project:group",
    revision: 4,
    frameRate: { numerator: 30, denominator: 1 },
    canvas: { width: 1920, height: 1080, background: "#000" },
    assets: [
      { id: "asset:one", kind: "video", name: "one.mp4", durationFrames: 300 },
      { id: "asset:two", kind: secondKind, name: "two.mp4", durationFrames: 300 },
    ],
    sequence: {
      id: "sequence:main",
      name: "Main",
      tracks: [{
        id: "track:video",
        kind: secondKind === "video" ? "video" : "mixed",
        clips: ["one", "two"].map((name, index) => ({
          id: `clip:${name}`,
          assetId: `asset:${name}`,
          binding: { sourceFile: "index.html", domId: name },
          startFrame: index * 150,
          durationFrames: 150,
          sourceInFrame: 0,
          muted: false,
          effects: [],
          parameterTracks: [],
        })),
      }],
    },
  });
  const secondTag = secondKind === "video"
    ? `<video id="two" data-has-audio="${secondVideoHasSound}"></video>`
    : '<audio id="two"></audio>';
  const originalHtml = `<html><body><video id="one" data-has-audio="true"></video>${secondTag}</body></html>`;
  const files = new Map([
    [NATIVE_PROJECT_DOCUMENT_PATH, serializeNativeProjectDocument(document)],
    ["index.html", originalHtml],
  ]);
  const elements: TimelineElement[] = ["one", "two"].map((name, index) => ({
    id: name,
    key: `index.html#${name}`,
    domId: name,
    tag: name === "two" ? secondKind : "video",
    sourceFile: "index.html",
    start: index * 5,
    duration: 5,
    track: 0,
  }));
  usePlayerStore.getState().setElements(elements);
  const commitFileTransaction = vi.fn(async (input: {
    files: readonly { path: string; expectedBefore: string | null; after: string | null }[];
  }) => {
    for (const file of input.files) {
      expect(files.get(file.path)).toBe(file.expectedBefore);
      if (file.after !== null) files.set(file.path, file.after);
    }
  });
  const onNativeDocumentCommitted = vi.fn();
  const nativeDocumentRef = { current: document };
  const create = () => createAudioGroupAndAssignMembers({
    projectId: "project:group",
    activeCompPath: "index.html",
    elements,
    groupId: "dialogue",
    groupLabel: "Dialogue",
    previewIframe: null,
    writeProjectFile: vi.fn(async () => {}),
    recordEdit: vi.fn(async () => {}),
    domEditSaveTimestampRef: { current: 0 },
    pendingTimelineEditPathRef: { current: new Set<string>() },
    nativeDocumentRef,
    nativeProjectEditing: {
      nativeDocument: document,
      readOptionalProjectFile: async (path: string) => files.get(path),
      onNativeDocumentCommitted,
      commitFileTransaction,
    },
  });
  return { create, files, document, elements, originalHtml, commitFileTransaction, onNativeDocumentCommitted };
}

it("groups audible videos in native and HTML with one durable undo transaction", async () => {
  const state = setup();
  const changed = await state.create();
  expect(changed).toEqual([NATIVE_PROJECT_DOCUMENT_PATH, "index.html"]);
  expect(state.commitFileTransaction).toHaveBeenCalledOnce();
  const call = state.commitFileTransaction.mock.calls[0]![0];
  expect(call.files).toHaveLength(2);
  expect(call.history).toEqual({ label: "Group 2 clips as Dialogue", kind: "timeline" });
  const saved = parseNativeProjectDocument(JSON.parse(state.files.get(NATIVE_PROJECT_DOCUMENT_PATH)!));
  expect(saved.revision).toBe(5);
  expect(saved.sequence.audioGroups).toEqual([{ id: "dialogue", label: "Dialogue", muted: false, volume: 1 }]);
  expect(saved.sequence.tracks[0]?.clips.map((clip) => clip.audioGroupId)).toEqual(["dialogue", "dialogue"]);
  expect(state.files.get("index.html")).toContain('<video id="two" data-has-audio="true" data-audio-group="dialogue">');
  expect(state.files.get("index.html")).toContain('<hf-audio-group id="dialogue" data-label="Dialogue">');
  expect(state.onNativeDocumentCommitted).toHaveBeenCalledOnce();
  expect(usePlayerStore.getState().elements.map((clip) => clip.audioGroup)).toEqual(["dialogue", "dialogue"]);
});

it("refuses a silent video without partially writing native or HTML state", async () => {
  const state = setup(false);
  await expect(state.create()).rejects.toThrow("no confirmed audio stream");
  expect(state.commitFileTransaction).not.toHaveBeenCalled();
  expect(state.onNativeDocumentCommitted).not.toHaveBeenCalled();
  expect(state.files.get("index.html")).toBe(state.originalHtml);
  expect(parseNativeProjectDocument(JSON.parse(state.files.get(NATIVE_PROJECT_DOCUMENT_PATH)!)).revision).toBe(4);
  expect(usePlayerStore.getState().elements.every((clip) => clip.audioGroup === undefined)).toBe(true);
});

it("groups video sound and an audio clip on the same native bus", async () => {
  const state = setup(true, "audio");
  await state.create();
  expect(state.commitFileTransaction).toHaveBeenCalledOnce();
  expect(state.files.get("index.html")).toContain('<audio id="two" data-audio-group="dialogue">');
  const saved = parseNativeProjectDocument(JSON.parse(state.files.get(NATIVE_PROJECT_DOCUMENT_PATH)!));
  expect(saved.sequence.tracks[0]?.clips.map((clip) => clip.audioGroupId)).toEqual(["dialogue", "dialogue"]);
});

it("does not publish or mirror a group when its durable transaction fails", async () => {
  const state = setup();
  state.commitFileTransaction.mockImplementationOnce(async () => { throw new Error("durable write failed"); });
  await expect(state.create()).rejects.toThrow("durable write failed");
  expect(state.onNativeDocumentCommitted).not.toHaveBeenCalled();
  expect(state.files.get("index.html")).toBe(state.originalHtml);
  expect(usePlayerStore.getState().elements.every((clip) => clip.audioGroup === undefined)).toBe(true);
});

it("refuses a partial native video track even when called outside the track header", async () => {
  const state = setup();
  const withThird = parseNativeProjectDocument({
    ...state.document,
    assets: [...state.document.assets, {
      id: "asset:three", kind: "video", name: "three.mp4", durationFrames: 300,
    }],
    sequence: {
      ...state.document.sequence,
      tracks: state.document.sequence.tracks.map((track) => ({
        ...track,
        clips: [...track.clips, {
          ...track.clips[0]!, id: "clip:three", assetId: "asset:three",
          binding: { sourceFile: "index.html", domId: "three" }, startFrame: 300,
        }],
      })),
    },
  });
  state.files.set(NATIVE_PROJECT_DOCUMENT_PATH, serializeNativeProjectDocument(withThird));
  state.files.set("index.html", state.originalHtml.replace("</body>", '<video id="three" data-has-audio="true"></video></body>'));
  await expect(state.create()).rejects.toThrow("Select every clip on a video track");
  expect(state.commitFileTransaction).not.toHaveBeenCalled();
});
