import { expect, it, vi } from "vitest";
import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  parseNativeProjectDocument,
  serializeNativeProjectDocument,
} from "../../../shared/project/nativeProjectDocument";
import { stabilizeNativeBindingSource, synchronizeNativeBindingSource } from "./nativeBindingSource";
import { commitNativeTimelineDelete } from "./nativeTimelineDeleteTransaction";

const hfId = "hf-3cbc152b-197f-4695-966b-c86677d28c35";
const clipId = "native-clip:camera";
const source = '<main data-composition-id="main"><video id="cs146-chapter-05b"></video></main>';

function project() {
  return parseNativeProjectDocument({
    schemaVersion: 1, id: "project:binding", revision: 0,
    frameRate: { numerator: 30, denominator: 1 },
    canvas: { width: 1920, height: 1080, background: "#000000" },
    assets: [{ id: "asset:camera", kind: "video", name: "camera.mov", durationFrames: 300 }],
    sequence: { id: "sequence:main", name: "Main", tracks: [{
      id: "track:video", kind: "video", clips: [{
        id: clipId, assetId: "asset:camera",
        binding: { sourceFile: "index.html", domId: "cs146-chapter-05b", hfId },
        startFrame: 0, durationFrames: 120, sourceInFrame: 0, muted: false,
        effects: [], parameterTracks: [],
      }],
    }] },
  });
}

it("pins a preview-only hf identity into authored source before synchronizing native clip ownership", () => {
  const native = project();
  const stamped = stabilizeNativeBindingSource(native, "index.html", source);
  expect(stamped).toContain(`data-hf-id="${hfId}"`);
  const synchronized = synchronizeNativeBindingSource(native, "index.html", stamped);
  expect(synchronized).toContain(`data-studio-clip-id="${clipId}"`);
  expect(synchronizeNativeBindingSource(native, "index.html", synchronized)).toBe(synchronized);
});

it("commits a native delete with a preview-only hf identity as one exact history transaction", async () => {
  const files = new Map([
    [NATIVE_PROJECT_DOCUMENT_PATH, serializeNativeProjectDocument(project())],
    ["index.html", source],
  ]);
  const recordEdit = vi.fn(async () => {});
  const result = await commitNativeTimelineDelete({
    expectedRevision: 0,
    targets: [{ attributes: { "data-studio-clip-id": clipId } }],
    readOptionalProjectFile: async path => files.get(path),
    writeProjectFile: async (path, content, expected) => {
      expect(files.get(path)).toBe(expected);
      files.set(path, content);
    },
    recordEdit,
    removeCompatibilityTarget: content => content.replace(/<video\b[^>]*><\/video>/, ""),
  });
  expect(result.committed).toBe(true);
  expect(files.get("index.html")).not.toContain("<video");
  expect(recordEdit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    files: expect.objectContaining({
      "index.html": expect.objectContaining({ before: source }),
      [NATIVE_PROJECT_DOCUMENT_PATH]: expect.any(Object),
    }),
  }));
});
