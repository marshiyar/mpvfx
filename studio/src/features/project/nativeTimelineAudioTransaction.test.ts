// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { parseTimelineFromDOM } from "../../player/lib/timelineDOM";
import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  parseNativeProjectDocument,
  serializeNativeProjectDocument,
} from "../../../shared/project/nativeProjectDocument";
import { commitNativeTimelineAudio } from "./nativeTimelineAudioTransaction";

function fixture() {
  const project = parseNativeProjectDocument({
    schemaVersion: 1, mediaEngine: "ffmpeg", id: "project", revision: 4,
    frameRate: { numerator: 30000, denominator: 1001 },
    canvas: { width: 64, height: 32, background: "#000000" },
    assets: [{ id: "asset", kind: "video", name: "camera.mp4", source: "assets/camera.mp4", durationFrames: 300 }],
    sequence: { id: "sequence", name: "Sequence", tracks: [{
      id: "video-track", kind: "video", lane: { authoredTrack: 2, displayTrack: 3 }, clips: [{
        id: "video-clip", assetId: "asset", binding: { sourceFile: "index.html", domId: "camera" },
        startFrame: 37, durationFrames: 61, sourceInFrame: 17,
        sourceInFraction: { numerator: 1, denominator: 3 },
        playbackRate: { numerator: 3, denominator: 2 }, muted: false,
        staticParameters: { "audio.volume": 0.8 }, effects: [], parameterTracks: [],
      }],
    }] },
  });
  const files = new Map([
    [NATIVE_PROJECT_DOCUMENT_PATH, serializeNativeProjectDocument(project)],
    ["index.html", '<html><body><video id="camera" class="clip" src="assets/camera.mp4" data-start="1.234" data-duration="2.035" data-has-audio="true" data-volume="0.8"></video></body></html>'],
  ]);
  const history: Array<{ files: Record<string, { before: string; after: string }> }> = [];
  const options = {
    readOptionalProjectFile: async (path: string) => files.get(path),
    writeProjectFile: async (path: string, content: string, expected?: string) => {
      expect(files.get(path)).toBe(expected);
      files.set(path, content);
    },
    recordEdit: vi.fn(async (entry: { files: Record<string, { before: string; after: string }> }) => {
      history.push(entry);
    }),
  };
  return { files, history, options };
}

describe("native video audio file transaction", () => {
  it("generates matching IDs, saves both files, reattaches, and retains an undo snapshot", async () => {
    const { files, history, options } = fixture();
    const detached = await commitNativeTimelineAudio({
      ...options, expectedRevision: 4, action: "detach", clipId: "video-clip", hasAudioStream: true,
    });
    const audio = detached.sequence.tracks[1]!.clips[0]!;
    expect(audio.audioDetachedFrom).toBe("video-clip");
    expect(audio.binding?.domId).toBe(audio.id);
    expect(files.get("index.html")).toContain(`id="${audio.id}"`);
    expect(files.get("index.html")).toContain('data-has-audio="false"');
    const reopenedPreview = document.implementation.createHTMLDocument("reopened");
    reopenedPreview.documentElement.innerHTML = files.get("index.html")!;
    expect(parseTimelineFromDOM(reopenedPreview, 10).some(element =>
      element.tag === "audio" && element.domId === audio.id)).toBe(true);
    expect(parseNativeProjectDocument(JSON.parse(files.get(NATIVE_PROJECT_DOCUMENT_PATH)!))).toEqual(detached);
    expect(history).toHaveLength(1);
    expect(Object.keys(history[0]!.files).sort()).toEqual([NATIVE_PROJECT_DOCUMENT_PATH, "index.html"].sort());

    const reattached = await commitNativeTimelineAudio({
      ...options, expectedRevision: 5, action: "reattach", clipId: audio.id,
    });
    expect(reattached.sequence.tracks).toHaveLength(1);
    expect(files.get("index.html")).not.toContain(`id="${audio.id}"`);
    expect(files.get("index.html")).toContain('data-has-audio="true"');
    expect(parseNativeProjectDocument(JSON.parse(files.get(NATIVE_PROJECT_DOCUMENT_PATH)!))).toEqual(reattached);
    expect(history).toHaveLength(2);

    for (const [path, snapshot] of Object.entries(history[1]!.files)) files.set(path, snapshot.before);
    expect(parseNativeProjectDocument(JSON.parse(files.get(NATIVE_PROJECT_DOCUMENT_PATH)!))).toEqual(detached);
    expect(files.get("index.html")).toContain(`id="${audio.id}"`);
  });

  it("refuses changed detached timing without changing either file or history", async () => {
    const { files, history, options } = fixture();
    const detached = await commitNativeTimelineAudio({
      ...options, expectedRevision: 4, action: "detach", clipId: "video-clip", hasAudioStream: true,
    });
    const audio = detached.sequence.tracks[1]!.clips[0]!;
    audio.startFrame += 1;
    files.set(NATIVE_PROJECT_DOCUMENT_PATH, serializeNativeProjectDocument(detached));
    const before = new Map(files);
    await expect(commitNativeTimelineAudio({
      ...options, expectedRevision: 5, action: "reattach", clipId: audio.id,
    })).rejects.toThrow("moved, trimmed, or retimed");
    expect(files).toEqual(before);
    expect(history).toHaveLength(1);
  });
});
