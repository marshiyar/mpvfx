import { describe, expect, it, vi } from "vitest";
import type { PreviewElementState } from "../../../shared/preview/agentProtocol";
import { NATIVE_PROJECT_DOCUMENT_PATH, parseNativeProjectDocument, serializeNativeProjectDocument } from "../../../shared/project/nativeProjectDocument";
import { commitRemoteNativeMediaEdit, snapshotRemoteNativeMedia } from "./remoteInspectorNativeMediaTransaction";
import type { RemoteNativeMediaCommand } from "./remoteInspectorNativeMediaTransaction";

const target: PreviewElementState = {
  handle: "e1", tag: "video", id: "camera", className: "", text: "",
  rect: { x: 0, y: 0, width: 100, height: 100 }, visible: true, parent: null,
  sourceFile: "index.html", compositionPath: "index.html",
  dataAttributes: { "studio-clip-id": "clip" }, inlineStyles: {}, computedStyles: {},
};

function fixture() {
  const document = parseNativeProjectDocument({
    schemaVersion: 1, id: "project", revision: 0,
    frameRate: { numerator: 30, denominator: 1 }, canvas: { width: 100, height: 100, background: "#000000" },
    assets: [{ id: "asset", kind: "video", name: "video", source: "video.mp4", durationFrames: 300 }],
    sequence: { id: "main", name: "Main", tracks: [{ id: "track", kind: "video", clips: [{
      id: "clip", assetId: "asset", binding: { sourceFile: "index.html", domId: "camera" },
      startFrame: 0, durationFrames: 60, sourceInFrame: 0, muted: true, effects: [], parameterTracks: [],
    }] }] },
  });
  const files = new Map([
    [NATIVE_PROJECT_DOCUMENT_PATH, serializeNativeProjectDocument(document)],
    ["index.html", '<html><body><video id="camera" src="video.mp4" muted></video></body></html>'],
  ]);
  const recordEdit = vi.fn(async () => {});
  const onNativeDocumentCommitted = vi.fn();
  const deps = {
    expectedRevision: 0,
    readOptionalProjectFile: async (path: string) => files.get(path),
    writeProjectFile: async (path: string, content: string, expected?: string) => {
      expect(files.get(path)).toBe(expected);
      files.set(path, content);
    },
    recordEdit,
    onNativeDocumentCommitted,
  };
  return { document, files, deps, recordEdit, onNativeDocumentCommitted };
}

describe("remote native media transaction", () => {
  it("snapshots only an exact clip and saved source binding", () => {
    const { document } = fixture();
    expect(snapshotRemoteNativeMedia(target, document)).toMatchObject({ clipId: "clip", muted: true, playbackRate: 1, durationSeconds: 2 });
    expect(snapshotRemoteNativeMedia({ ...target, id: "other" }, document)).toBeNull();
    expect(snapshotRemoteNativeMedia({ ...target, sourceFile: "other.html" }, document)).toBeNull();
    expect(snapshotRemoteNativeMedia({ ...target, dataAttributes: { "studio-clip-id": "other" } }, document)).toBeNull();
  });

  it("atomically saves mute and HTML mirror with one history entry", async () => {
    const { files, deps, recordEdit, onNativeDocumentCommitted } = fixture();
    const saved = await commitRemoteNativeMediaEdit(target, { kind: "muted", value: false }, deps);
    expect(saved.sequence.tracks[0]!.clips[0]!.muted).toBe(false);
    expect(files.get("index.html")).not.toMatch(/\smuted(?:\s|>)/);
    expect(files.get("index.html")).toContain('data-studio-clip-id="clip"');
    expect(recordEdit).toHaveBeenCalledTimes(1);
    expect(onNativeDocumentCommitted).toHaveBeenCalledWith(saved);
  });

  it("preserves fractional source timing and rejects stale or forged targets", async () => {
    const { files, deps, recordEdit } = fixture();
    const saved = await commitRemoteNativeMediaEdit(target, { kind: "source-start", value: 1 / 60 }, deps);
    expect(saved.sequence.tracks[0]!.clips[0]!.sourceInFraction).toEqual({ numerator: 1, denominator: 2 });
    expect(files.get("index.html")).toContain('data-media-start="0.016666666666666666"');
    await expect(commitRemoteNativeMediaEdit({ ...target, id: "other" }, { kind: "gain", value: 0.5 }, { ...deps, expectedRevision: 1 }))
      .rejects.toThrow("not bound");
    await expect(commitRemoteNativeMediaEdit(target, { kind: "gain", value: 0.5 }, deps))
      .rejects.toThrow();
    expect(recordEdit).toHaveBeenCalledTimes(1);
  });

  it("commits gain and playback rate through the same sidecar and HTML transaction", async () => {
    const { files, deps } = fixture();
    const gained = await commitRemoteNativeMediaEdit(target, { kind: "gain", value: 0.5 }, deps);
    expect(gained.sequence.tracks[0]!.clips[0]!.staticParameters?.["audio.volume"]).toBe(0.5);
    expect(files.get("index.html")).toContain('data-volume="0.5"');
    const rated = await commitRemoteNativeMediaEdit(target, { kind: "playback-rate", value: 1.5 }, { ...deps, expectedRevision: 1 });
    expect(rated.sequence.tracks[0]!.clips[0]!.playbackRate).toEqual({ numerator: 3, denominator: 2 });
    expect(files.get("index.html")).toContain('data-playback-rate="1.5"');
  });

  it("trims one boundary and mirrors exact native timing", async () => {
    const { files, deps } = fixture();
    const saved = await commitRemoteNativeMediaEdit(target, { kind: "trim", startSeconds: 0, durationSeconds: 1 }, deps);
    expect(saved.sequence.tracks[0]!.clips[0]!.durationFrames).toBe(30);
    expect(files.get("index.html")).toContain('data-duration="1"');
  });

  it("accepts parsed audio FX and automation payloads", async () => {
    const { files, deps } = fixture();
    const chain = '{"version":1,"nodes":[]}';
    const automation = '{"version":1,"lanes":[]}';
    const withFx = await commitRemoteNativeMediaEdit(target, { kind: "audio-fx-chain", value: chain }, deps);
    expect(withFx.sequence.tracks[0]!.clips[0]!.audioFxChain).toBe(chain);
    const withAutomation = await commitRemoteNativeMediaEdit(target, { kind: "audio-automation", value: automation }, { ...deps, expectedRevision: 1 });
    expect(withAutomation.sequence.tracks[0]!.clips[0]!.audioAutomation).toBe(automation);
    expect(files.get("index.html")).toContain("data-automation=");
  });

  it("rejects unsupported audio payload and invalid range before writing", async () => {
    const { deps, recordEdit } = fixture();
    await expect(commitRemoteNativeMediaEdit(target, { kind: "audio-fx-chain", value: "{}" }, deps)).rejects.toThrow();
    await expect(commitRemoteNativeMediaEdit(target, { kind: "trim", startSeconds: 0, durationSeconds: -1 }, deps)).rejects.toThrow();
    expect(recordEdit).not.toHaveBeenCalled();
  });

  it("fails closed for visual grade and FX commands the native renderer cannot export", async () => {
    const { deps, recordEdit } = fixture();
    for (const kind of ["color-grading", "video-fx-chain"]) {
      await expect(commitRemoteNativeMediaEdit(target,
        { kind, value: '{"enabled":true}' } as RemoteNativeMediaCommand, deps))
        .rejects.toThrow("Unsupported native media command");
    }
    expect(recordEdit).not.toHaveBeenCalled();
  });
});
