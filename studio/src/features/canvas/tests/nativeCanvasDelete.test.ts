// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { deleteNativeCanvasSelection } from "../nativeCanvasDelete";
import { makeSelection } from "../domSelectionTestHarness";
import { NATIVE_PROJECT_DOCUMENT_PATH, parseNativeProjectDocument } from "../../../../shared/project/nativeProjectDocument";

it("removes the HTML and native clip with one undo record, preserving other clips", async () => {
  const document = parseNativeProjectDocument({
    schemaVersion: 1, id: "project", revision: 0, frameRate: { numerator: 30, denominator: 1 },
    canvas: { width: 100, height: 100, background: "#000000" },
    assets: [{ id: "asset", kind: "video", name: "video", source: "video.mp4", durationFrames: 300 }],
    sequence: { id: "main", name: "Main", tracks: [{ id: "track", kind: "video", clips: ["one", "two"].map(id => ({
      id, assetId: "asset", binding: { sourceFile: "index.html", domId: id }, startFrame: 0,
      durationFrames: 60, sourceInFrame: 0, muted: false, effects: [], parameterTracks: [],
    })) }] },
  });
  const nativeBefore = JSON.stringify(document);
  const htmlBefore = '<main data-composition-id="main"><video id="one" src="video.mp4"></video><video id="two" src="video.mp4"></video></main>';
  const files = new Map([[NATIVE_PROJECT_DOCUMENT_PATH, nativeBefore], ["index.html", htmlBefore]]);
  const element = globalThis.document.createElement("video");
  element.id = "one";
  const recordEdit = vi.fn(async () => {});
  const saved = await deleteNativeCanvasSelection([makeSelection("one", element)], {
    nativeDocument: document, getPlayheadSeconds: () => 0,
    readOptionalProjectFile: async path => files.get(path),
    writeProjectFile: async (path, content, expected) => {
      expect(files.get(path)).toBe(expected); files.set(path, content);
    },
  }, recordEdit);
  expect(saved).toBe(true);
  expect(files.get("index.html")).not.toContain('id="one"');
  expect(files.get("index.html")).toContain('id="two"');
  expect(JSON.parse(files.get(NATIVE_PROJECT_DOCUMENT_PATH)!).sequence.tracks[0].clips.map((clip: { id: string }) => clip.id)).toEqual(["two"]);
  expect(recordEdit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ files: {
    [NATIVE_PROJECT_DOCUMENT_PATH]: { before: nativeBefore, after: files.get(NATIVE_PROJECT_DOCUMENT_PATH) },
    "index.html": { before: htmlBefore, after: files.get("index.html") },
  } }));
});
