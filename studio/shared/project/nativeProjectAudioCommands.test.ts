import { describe, expect, it } from "vitest";
import { detachNativeVideoAudio, reattachNativeVideoAudio } from "./nativeProjectAudioCommands";
import { applyNativeProjectClipCommand, nativeSplitClipId } from "./nativeProjectClipCommands";
import { parseNativeProjectDocument } from "./nativeProjectDocument";

const ids = { assetId: "audio-asset", clipId: "audio-clip", trackId: "audio-track" };
function project() {
  return parseNativeProjectDocument({
    schemaVersion: 1, mediaEngine: "ffmpeg", id: "project", revision: 0,
    frameRate: { numerator: 30000, denominator: 1001 },
    canvas: { width: 64, height: 32, background: "#000000" },
    assets: [{ id: "video-asset", kind: "video", name: "camera.mp4", source: "assets/camera.mp4", durationFrames: 300 }],
    sequence: { id: "sequence", name: "Sequence", tracks: [{
      id: "video-track", kind: "video", lane: { authoredTrack: 7, displayTrack: 3 }, clips: [{
        id: "video-clip", assetId: "video-asset", startFrame: 37, durationFrames: 61,
        sourceInFrame: 17, sourceInFraction: { numerator: 1, denominator: 3 },
        playbackRate: { numerator: 3, denominator: 2 }, muted: false,
        staticParameters: { "visual.opacity": 0.7, "audio.volume": 0.8 },
        effects: [{ id: "visual-fx", effectId: "color", enabled: false }], parameterTracks: [],
      }],
    }] },
  });
}

describe("native video audio detach and reattach", () => {
  it("keeps exact source timing, visual edits, source linkage and native track lanes", () => {
    const original = project();
    const detached = detachNativeVideoAudio(original, "video-clip", true, ids);
    const video = detached.sequence.tracks[0]!.clips[0]!;
    const audio = detached.sequence.tracks[1]!.clips[0]!;
    expect(video).toMatchObject({
      id: "video-clip", muted: true, staticParameters: { "visual.opacity": 0.7, "audio.volume": 0.8 },
      effects: [{ id: "visual-fx" }],
    });
    expect(audio).toMatchObject({
      id: "audio-clip", audioDetachedFrom: "video-clip", startFrame: 37, durationFrames: 61,
      sourceInFrame: 17, sourceInFraction: { numerator: 1, denominator: 3 },
      playbackRate: { numerator: 3, denominator: 2 }, staticParameters: { "audio.volume": 0.8 },
    });
    expect(detached.sequence.tracks[1]!.lane).toEqual({ authoredTrack: 0, displayTrack: 4 });
    expect(detached.assets[1]).toMatchObject({ kind: "audio", source: "assets/camera.mp4" });
    expect(original.sequence.tracks).toHaveLength(1); // immutable command result supports history snapshots
    expect(reattachNativeVideoAudio(detached, "audio-clip")).toEqual(original);
  });

  it("retains detached audio mute, gain, group and FX edits on reattach", () => {
    const original = project();
    original.sequence.audioGroups = [{ id: "dialogue" }];
    original.sequence.tracks[0]!.clips[0]!.audioGroupId = "dialogue";
    const detached = detachNativeVideoAudio(original, "video-clip", true, ids);
    const video = detached.sequence.tracks[0]!.clips[0]!;
    const audio = detached.sequence.tracks[1]!.clips[0]!;
    expect(video.audioGroupId).toBeUndefined();
    expect(audio.audioGroupId).toBe("dialogue");
    audio.muted = true;
    audio.staticParameters!["audio.volume"] = 0.45;
    audio.effects.push({ id: "audio-fx", effectId: "gain", enabled: false });
    const attached = reattachNativeVideoAudio(detached, "audio-clip");
    expect(attached.sequence.tracks[0]!.clips[0]).toMatchObject({
      muted: true, audioGroupId: "dialogue", staticParameters: { "audio.volume": 0.45, "visual.opacity": 0.7 },
      effects: [{ id: "visual-fx" }, { id: "audio-fx" }],
    });
    expect(attached.sequence.tracks).toHaveLength(1);
  });

  it("refuses an unverified silent video and changed detached timing without discarding edits", () => {
    const original = project();
    expect(() => detachNativeVideoAudio(original, "video-clip", false, ids)).toThrow("no audio stream");
    const detached = detachNativeVideoAudio(original, "video-clip", true, ids);
    const audio = detached.sequence.tracks[1]!.clips[0]!;
    audio.startFrame += 1;
    audio.staticParameters!["audio.volume"] = 0.2;
    expect(() => reattachNativeVideoAudio(detached, "audio-clip")).toThrow("moved, trimmed, or retimed");
    expect(audio.staticParameters!["audio.volume"]).toBe(0.2);
    expect(detached.sequence.tracks[1]!.clips).toHaveLength(1);
  });

  it("rejects dangling, duplicate and different-source detached links on reopen", () => {
    const detached = detachNativeVideoAudio(project(), "video-clip", true, ids);
    const dangling = structuredClone(detached);
    dangling.sequence.tracks[1]!.clips[0]!.audioDetachedFrom = "missing-video";
    expect(() => parseNativeProjectDocument(dangling)).toThrow("existing video clip");

    const duplicate = structuredClone(detached);
    duplicate.sequence.tracks[1]!.clips.push({ ...duplicate.sequence.tracks[1]!.clips[0]!, id: "audio-copy" });
    expect(() => parseNativeProjectDocument(duplicate)).toThrow("Only one detached audio clip");

    const differentSource = structuredClone(detached);
    differentSource.assets.find(asset => asset.id === ids.assetId)!.source = "assets/other.mp4";
    expect(() => parseNativeProjectDocument(differentSource)).toThrow("share one source file");

    // A timing edit remains valid: the link is an identity, while reattach
    // checks alignment separately before discarding either clip.
    const moved = structuredClone(detached);
    moved.sequence.tracks[1]!.clips[0]!.startFrame += 1;
    expect(parseNativeProjectDocument(moved).sequence.tracks[1]!.clips[0]!.startFrame).toBe(38);
    expect(() => reattachNativeVideoAudio(moved, ids.clipId)).toThrow("moved, trimmed, or retimed");
  });

  it("unlinks independent audio after a split or source-video delete", () => {
    const detached = detachNativeVideoAudio(project(), "video-clip", true, ids);
    const audioAddress = { sequenceId: "sequence", trackId: ids.trackId, clipId: ids.clipId };
    const split = applyNativeProjectClipCommand(detached, { type: "split", address: audioAddress, splitFrame: 67 });
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    expect(split.document.sequence.tracks[1]!.clips.map(clip => clip.audioDetachedFrom))
      .toEqual(["video-clip", undefined]);
    expect(split.document.sequence.tracks[1]!.clips[1]).toMatchObject({
      id: nativeSplitClipId(ids.clipId, 67), sourceInFrame: 62,
      sourceInFraction: { numerator: 1, denominator: 3 }, playbackRate: { numerator: 3, denominator: 2 },
    });

    const deleted = applyNativeProjectClipCommand(detached, {
      type: "delete", address: { sequenceId: "sequence", trackId: "video-track", clipId: "video-clip" },
    });
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.document.sequence.tracks[1]!.clips[0]!.audioDetachedFrom).toBeUndefined();
    expect(deleted.document.sequence.tracks[1]!.clips[0]!.assetId).toBe(ids.assetId);
  });
});
