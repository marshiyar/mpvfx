import { expect, it, vi } from "vitest";
import { createNativeParameterTrack } from "../../../../shared/project/nativeKeyframeTypes";
import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
  parseNativeProjectDocument,
  serializeNativeProjectDocument,
} from "../../../../shared/project/nativeProjectDocument";
import { captureNativeClipboard, pasteNativeClipboard } from "../nativeClipboard";

it("copies clip-local effects and keyframes into a distinct undoable native clip", async () => {
  const frameRate = { numerator: 30, denominator: 1 } as const;
  const original = parseNativeProjectDocument({
    schemaVersion: NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
    id: "project:duplicate", revision: 2, frameRate,
    canvas: { width: 1920, height: 1080, background: "#000" },
    assets: [{ id: "asset:video", kind: "video", name: "camera.mov", source: "media/camera.mov", durationFrames: 300 }],
    sequence: { id: "sequence:main", name: "Main", tracks: [{
      id: "track:video", kind: "video", lane: { authoredTrack: 0, displayTrack: 0 },
      clips: [{
        id: "clip:original", assetId: "asset:video",
        binding: { sourceFile: "index.html", domId: "camera", hfId: "hf-camera" },
        startFrame: 0, durationFrames: 120, sourceInFrame: 0, muted: true,
        staticParameters: { "transform.position.x": 25 },
        cropPivotSegments: [{ startRotationKeyId: "key:rotation",
          endRotationKeyId: "key:rotation:end", offsetFraction: { x: 0.05, y: -0.1 } }],
        effects: [{ id: "fx:original", effectId: "blur", enabled: true }],
        parameterTracks: [createNativeParameterTrack({
          id: "track:rotation", parameterId: "transform.rotation", valueType: "number", frameRate,
          keyframes: [
            { id: "key:rotation", frame: 0, value: 30, outgoing: { type: "linear" } },
            { id: "key:rotation:end", frame: 90, value: 90, outgoing: { type: "linear" } },
          ],
        })],
      }],
    }] },
  });
  const clipHtml = '<video id="camera" data-hf-id="hf-camera" data-studio-clip-id="clip:original" class="clip" src="media/camera.mov" data-start="0" data-duration="4" data-end="4"></video>';
  const source = `<main data-composition-id="main" data-duration="4">${clipHtml}</main>`;
  const files = new Map([[NATIVE_PROJECT_DOCUMENT_PATH, serializeNativeProjectDocument(original)], ["index.html", source]]);
  const snapshot = captureNativeClipboard(clipHtml, original, "workspace:one");
  expect(snapshot?.entries).toHaveLength(1);
  if (!snapshot) return;
  const recordEdit = vi.fn(async () => {});
  await pasteNativeClipboard({
    payload: { kind: "timeline-clip", html: clipHtml, sourceFile: "index.html" },
    snapshot, workspaceProjectId: "workspace:one", targetPath: "index.html", playhead: 4,
    editing: {
      readOptionalProjectFile: async (path: string) => files.get(path),
      writeProjectFile: async (path: string, content: string, expected?: string) => {
        expect(files.get(path)).toBe(expected);
        files.set(path, content);
      },
    } as NonNullable<Parameters<typeof pasteNativeClipboard>[0]["editing"]>,
    recordEdit,
  });

  const reopened = parseNativeProjectDocument(JSON.parse(files.get(NATIVE_PROJECT_DOCUMENT_PATH)!));
  const clips = reopened.sequence.tracks.flatMap((track) => track.clips);
  expect(clips).toHaveLength(2);
  const duplicated = clips.find((clip) => clip.id !== "clip:original")!;
  expect(duplicated.assetId).toBe("asset:video");
  expect(duplicated.id).not.toBe("clip:original");
  expect(duplicated.binding?.domId).not.toBe("camera");
  expect(duplicated.startFrame).toBe(120);
  expect(duplicated.muted).toBe(true);
  expect(duplicated.staticParameters).toEqual({ "transform.position.x": 25 });
  expect(duplicated.effects).toEqual([{ id: expect.not.stringMatching(/^fx:original$/), effectId: "blur", enabled: true }]);
  expect(duplicated.parameterTracks[0]?.id).not.toBe("track:rotation");
  expect(duplicated.parameterTracks[0]?.keyframes[0]?.id).not.toBe("key:rotation");
  expect(duplicated.parameterTracks[0]?.keyframes[0]?.value).toBe(30);
  expect(duplicated.cropPivotSegments).toEqual([{
    startRotationKeyId: duplicated.parameterTracks[0]!.keyframes[0]!.id,
    endRotationKeyId: duplicated.parameterTracks[0]!.keyframes[1]!.id,
    offsetFraction: { x: 0.05, y: -0.1 },
  }]);
  expect(duplicated.cropPivotSegments?.[0]?.startRotationKeyId).not.toBe("key:rotation");
  const savedHtml = files.get("index.html")!;
  expect(savedHtml).toContain('id="camera"');
  expect(savedHtml).toContain('data-end="4"');
  const duplicatedTag = savedHtml.match(/<video[^>]*data-studio-clip-id="native-clip:[^>]*>/)?.[0];
  expect(duplicatedTag).toBeDefined();
  expect(duplicatedTag).toContain('data-start="4"');
  expect(duplicatedTag).not.toContain('data-end=');
  expect(recordEdit).toHaveBeenCalledWith(expect.objectContaining({
    files: expect.objectContaining({
      [NATIVE_PROJECT_DOCUMENT_PATH]: expect.objectContaining({ before: serializeNativeProjectDocument(original) }),
      "index.html": expect.objectContaining({ before: source }),
    }),
  }));
});
