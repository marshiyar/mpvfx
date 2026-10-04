import { describe, expect, it, vi } from "vitest";
import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  parseNativeProjectDocument,
  serializeNativeProjectDocument,
} from "../../../shared/project/nativeProjectDocument";
import { commitNativeTimelineAudioAttribute } from "./nativeTimelineAudioAttributeTransaction";
import { commitNativeTimelineAudio } from "./nativeTimelineAudioTransaction";

function fixture() {
  const project = parseNativeProjectDocument({
    schemaVersion: 1, mediaEngine: "ffmpeg", id: "project", revision: 0,
    frameRate: { numerator: 30, denominator: 1 },
    canvas: { width: 64, height: 32, background: "#000000" },
    assets: [{ id: "asset", kind: "video", name: "camera.mp4", source: "assets/camera.mp4", durationFrames: 300 }],
    sequence: { id: "sequence", name: "Sequence", audioGroups: [{ id: "bus" }], tracks: [{
      id: "video-track", kind: "video", lane: { authoredTrack: 0, displayTrack: 0 }, clips: [{
        id: "video-clip", assetId: "asset", binding: { sourceFile: "index.html", domId: "camera" },
        audioGroupId: "bus", startFrame: 0, durationFrames: 60, sourceInFrame: 0,
        muted: false, staticParameters: {}, effects: [], parameterTracks: [],
      }],
    }] },
  });
  const files = new Map([
    [NATIVE_PROJECT_DOCUMENT_PATH, serializeNativeProjectDocument(project)],
    ["index.html", '<html><body><hf-audio-group id="bus"></hf-audio-group><video id="camera" src="assets/camera.mp4" data-start="0" data-duration="2" data-has-audio="true"></video></body></html>'],
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

describe("native audio attribute transaction", () => {
  it("rejects an invalid gain without a partial save or history entry", async () => {
    const { files, history, options } = fixture();
    const before = new Map(files);
    await expect(commitNativeTimelineAudioAttribute({
      ...options, expectedRevision: 0,
      target: { kind: "group", id: "bus", sourceFile: "index.html" },
      attr: "data-volume", value: "20", label: "Set bus gain",
    })).rejects.toThrow("outside the supported range");
    expect(files).toEqual(before);
    expect(history).toHaveLength(0);
  });

  it("persists bus fader, mute and FX to native export state and preview together", async () => {
    const { files, history, options } = fixture();
    const target = { kind: "group", id: "bus", sourceFile: "index.html" } as const;
    const gain = await commitNativeTimelineAudioAttribute({
      ...options, target, expectedRevision: 0, attr: "data-volume", value: "0.5", label: "Set bus gain",
    });
    expect(gain.sequence.audioGroups?.[0]?.volume).toBe(0.5);
    expect(files.get("index.html")).toContain('data-volume="0.5"');
    const mute = await commitNativeTimelineAudioAttribute({
      ...options, target, expectedRevision: 1, attr: "data-hidden", value: "", label: "Mute bus",
    });
    expect(mute.sequence.audioGroups?.[0]?.muted).toBe(true);
    const chain = '{"version":1,"nodes":[]}';
    const fx = await commitNativeTimelineAudioAttribute({
      ...options, target, expectedRevision: 2, attr: "data-fx-chain", value: chain, label: "Set bus FX",
    });
    expect(fx.sequence.audioGroups?.[0]?.fxChain).toBe(chain);
    expect(files.get("index.html")).toContain("data-fx-chain=");
    expect(parseNativeProjectDocument(JSON.parse(files.get(NATIVE_PROJECT_DOCUMENT_PATH)!))).toEqual(fx);
    expect(history).toHaveLength(3);
    for (const [path, snapshot] of Object.entries(history[2]!.files)) files.set(path, snapshot.before);
    expect(parseNativeProjectDocument(JSON.parse(files.get(NATIVE_PROJECT_DOCUMENT_PATH)!))).toEqual(mute);
  });

  it("preserves edited detached clip gain, mute and FX through reattach", async () => {
    const { files, options } = fixture();
    const detached = await commitNativeTimelineAudio({
      ...options, expectedRevision: 0, action: "detach", clipId: "video-clip", hasAudioStream: true,
    });
    const audio = detached.sequence.tracks[1]!.clips[0]!;
    const detachedFiles = new Map(files);
    await expect(commitNativeTimelineAudioAttribute({
      ...options, expectedRevision: 1,
      target: { kind: "clip", selection: { id: "camera", sourceFile: "index.html" }, sourceFile: "index.html" },
      attr: "muted", value: null, label: "Unmute original video",
    })).rejects.toThrow("sound is detached");
    expect(files).toEqual(detachedFiles);
    const target = { kind: "clip", selection: { id: audio.id, sourceFile: "index.html" }, sourceFile: "index.html" } as const;
    await commitNativeTimelineAudioAttribute({
      ...options, target, expectedRevision: 1, attr: "data-volume", value: "0.4", label: "Set clip gain",
    });
    await commitNativeTimelineAudioAttribute({
      ...options, target, expectedRevision: 2, attr: "data-fx-chain", value: '{"version":1,"nodes":[]}', label: "Set clip FX",
    });
    await commitNativeTimelineAudioAttribute({
      ...options, target, expectedRevision: 3, attr: "muted", value: "true", label: "Mute clip",
    });
    const attached = await commitNativeTimelineAudio({
      ...options, expectedRevision: 4, action: "reattach", clipId: audio.id,
    });
    const clip = attached.sequence.tracks[0]!.clips[0]!;
    expect(clip.muted).toBe(true);
    expect(clip.staticParameters?.["audio.volume"]).toBe(0.4);
    expect(clip.audioFxChain).toBe('{"version":1,"nodes":[]}');
    expect(files.get("index.html")).toContain('data-volume="0.4"');
    expect(files.get("index.html")).toContain("data-fx-chain=");
    expect(files.get("index.html")).not.toContain(`id="${audio.id}"`);
  });
});
