import { parseHTML } from "linkedom";
import { expect, it, vi } from "vitest";

import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  parseNativeProjectDocument,
  serializeNativeProjectDocument,
} from "../../../shared/project/nativeProjectDocument";
import { commitNativeTimelineAssetInsertions } from "./nativeTimelineAssetInsertTransaction";
import { commitNativeTimelineDelete } from "./nativeTimelineDeleteTransaction";
import { commitNativeTimelineMove } from "./nativeTimelineMoveTransaction";
import { commitNativeTimelineSplits } from "./nativeTimelineSplitTransaction";

it("keeps split bindings usable through move, delete, reopen and fresh asset insertion", async () => {
  const clipId = "native:camera";
  const original = parseNativeProjectDocument({
    schemaVersion: 1, id: "project:lifecycle", revision: 0,
    frameRate: { numerator: 30, denominator: 1 },
    canvas: { width: 1920, height: 1080, background: "#000" },
    assets: [{ id: "asset:camera", kind: "video", name: "camera.mov", path: "media/camera.mov", durationFrames: 300 }],
    sequence: { id: "sequence:main", name: "Main", tracks: [{
      id: "track:video", kind: "video", lane: { authoredTrack: 0, displayTrack: 0 }, clips: [{
        id: clipId, assetId: "asset:camera",
        binding: { sourceFile: "index.html", domId: "camera", hfId: "hf-camera" },
        startFrame: 0, durationFrames: 120, sourceInFrame: 0, muted: false,
        staticParameters: { opacity: 0.6 },
        effects: [{ id: "fx:old", effectId: "blur", enabled: true }], parameterTracks: [],
      }],
    }] },
  });
  const files = new Map([
    [NATIVE_PROJECT_DOCUMENT_PATH, serializeNativeProjectDocument(original)],
    ["index.html", '<main data-composition-id="main" data-duration="4"><video id="camera" src="media/camera.mov" data-start="0" data-duration="4" data-track-index="0" style="opacity:0.6"></video></main>'],
  ]);
  const readOptionalProjectFile = async (path: string) => files.get(path);
  const writeProjectFile = async (path: string, content: string, expected?: string) => {
    expect(files.get(path)).toBe(expected);
    files.set(path, content);
  };
  const recordEdit = vi.fn(async () => {});
  const common = { readOptionalProjectFile, writeProjectFile, recordEdit };
  const reopened = () => parseNativeProjectDocument(JSON.parse(files.get(NATIVE_PROJECT_DOCUMENT_PATH)!));
  const clips = () => reopened().sequence.tracks.flatMap(track => track.clips);

  const split = await commitNativeTimelineSplits({
    ...common, expectedRevision: 0,
    splits: [{ element: { attributes: { "data-studio-clip-id": clipId } }, requestedSplitSeconds: 2 }],
    patchCompatibilityContent: (content, edit) => {
      const { document } = parseHTML(content);
      const left = document.querySelector("#camera")!;
      const right = left.cloneNode(true) as Element;
      right.setAttribute("id", "camera-right");
      right.removeAttribute("data-hf-id");
      right.removeAttribute("data-studio-clip-id");
      right.setAttribute("data-start", edit.compatibilitySplitTime);
      right.setAttribute("data-duration", "2");
      left.setAttribute("data-duration", "2");
      left.after(right);
      return { content: document.toString(), rightBinding: { sourceFile: edit.sourceFile, domId: "camera-right" } };
    },
  });
  expect(split.committed).toBe(true);
  expect(clips()).toHaveLength(2);
  const right = clips().find(clip => clip.id !== clipId)!;
  expect(right.effects).toEqual([{ id: "fx:old", effectId: "blur", enabled: true }]);

  await commitNativeTimelineMove({
    ...common, expectedRevision: reopened().revision,
    element: { attributes: { "data-studio-clip-id": right.id } },
    requestedStartSeconds: 4, requestedTrack: 0,
    patchCompatibilityContent: (content, start) => {
      const { document } = parseHTML(content);
      document.querySelector("#camera-right")!.setAttribute("data-start", String(start));
      return document.toString();
    },
  });
  expect(clips().find(clip => clip.id === right.id)?.startFrame).toBe(120);

  const deleted = await commitNativeTimelineDelete({
    ...common, expectedRevision: reopened().revision,
    targets: [{ attributes: { "data-studio-clip-id": clipId } }],
    removeCompatibilityTarget: content => {
      const { document } = parseHTML(content);
      document.querySelector("#camera")!.remove();
      return document.toString();
    },
  });
  expect(deleted.committed).toBe(true);
  expect(clips().map(clip => clip.id)).toEqual([right.id]);
  expect(reopened().assets).toHaveLength(1);

  const inserted = await commitNativeTimelineAssetInsertions({
    ...common, expectedRevision: reopened().revision,
    insertions: [{ assetPath: "media/camera.mov", kind: "video", sourceFile: "index.html",
      requestedStartSeconds: 0, requestedDurationSeconds: 2, sourceDurationSeconds: 10, requestedTrack: 0 }],
    patchCompatibilityContent: (content, edit) => {
      const { document } = parseHTML(content);
      const video = document.createElement("video");
      video.setAttribute("id", "camera-new");
      video.setAttribute("data-hf-id", "hf-camera-new");
      video.setAttribute("src", edit.assetPath);
      video.setAttribute("data-start", String(edit.compatibilityStartSeconds));
      video.setAttribute("data-duration", String(edit.compatibilityDurationSeconds));
      document.querySelector("main")!.append(video);
      return { content: document.toString(), binding: { sourceFile: edit.sourceFile, domId: "camera-new", hfId: "hf-camera-new" } };
    },
  });
  expect(inserted.committed).toBe(true);
  const fresh = clips().find(clip => clip.id !== right.id)!;
  expect(fresh.id).not.toBe(clipId);
  expect(fresh.effects).toEqual([]);
  expect(fresh.parameterTracks).toEqual([]);
  expect(fresh.staticParameters ?? {}).toEqual({});
  expect(clips().find(clip => clip.id === right.id)?.effects).toHaveLength(1);
  expect(files.get("index.html")).toContain('id="camera-new"');
  expect(recordEdit).toHaveBeenCalledTimes(4);
});
