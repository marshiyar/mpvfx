// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { NATIVE_PROJECT_DOCUMENT_PATH, parseNativeProjectDocument, serializeNativeProjectDocument } from "../../../shared/project/nativeProjectDocument";
import { commitNativeTimelineAudio } from "../project/nativeTimelineAudioTransaction";
import type { RecordEditInput } from "../history/studioFileHistory";
import { commitNativeMediaAttributes } from "./nativeMediaAttributes";
import type { DomEditSelection } from "./domEditing";

function fixture() {
  const project = parseNativeProjectDocument({
    schemaVersion: 1, id: "project", revision: 0,
    frameRate: { numerator: 30, denominator: 1 },
    canvas: { width: 64, height: 32, background: "#000" },
    assets: [
      { id: "video-asset", kind: "video", name: "camera.mp4", source: "media/camera.mp4", durationFrames: 180 },
      { id: "audio-asset", kind: "audio", name: "camera audio", source: "media/camera.mp4", durationFrames: 180 },
    ],
    sequence: { id: "sequence", name: "Sequence", audioGroups: [{ id: "bus" }], tracks: [
      { id: "video-track", kind: "video", lane: { authoredTrack: 0, displayTrack: 0 }, clips: [{
        id: "video-clip", assetId: "video-asset", binding: { sourceFile: "index.html", domId: "camera" },
        startFrame: 0, durationFrames: 60, sourceInFrame: 0, muted: true, effects: [], parameterTracks: [],
      }] },
      { id: "audio-track", kind: "audio", lane: { authoredTrack: 0, displayTrack: 1 }, clips: [{
        id: "audio-clip", assetId: "audio-asset", audioDetachedFrom: "video-clip",
        binding: { sourceFile: "index.html", domId: "detached" },
        startFrame: 0, durationFrames: 60, sourceInFrame: 0, muted: false, effects: [], parameterTracks: [],
      }] },
    ] },
  });
  const files = new Map([
    [NATIVE_PROJECT_DOCUMENT_PATH, serializeNativeProjectDocument(project)],
    ["index.html", '<html><body><hf-audio-group id="bus"></hf-audio-group><video id="camera" src="media/camera.mp4" muted data-has-audio="false"></video><audio id="detached" src="media/camera.mp4"></audio></body></html>'],
  ]);
  const recordEdit = vi.fn(async (_entry: RecordEditInput) => {});
  const editing = {
    readOptionalProjectFile: async (path: string) => files.get(path),
    writeProjectFile: async (path: string, content: string, expected?: string) => {
      expect(files.get(path)).toBe(expected);
      files.set(path, content);
    },
    onNativeDocumentCommitted: vi.fn(),
  };
  const selection = (id: string): DomEditSelection => {
    const element = document.createElement(id === "camera" ? "video" : id === "bus" ? "hf-audio-group" : "audio");
    element.id = id;
    if (id !== "bus") element.setAttribute("data-studio-clip-id", id === "camera" ? "video-clip" : "audio-clip");
    return { id, element, sourceFile: "index.html" } as DomEditSelection;
  };
  return { files, editing, recordEdit, selection };
}

describe("native inspector media attributes", () => {
  it("accepts the inspector's six-decimal +12 dB endpoint", async () => {
    const { files, editing, recordEdit, selection } = fixture();
    await commitNativeMediaAttributes(selection("detached"), [
      { type: "attribute", property: "volume", value: "3.981072" },
    ], "index.html", editing as Parameters<typeof commitNativeMediaAttributes>[3], recordEdit);
    const native = parseNativeProjectDocument(JSON.parse(files.get(NATIVE_PROJECT_DOCUMENT_PATH)!));
    expect(native.sequence.tracks[1]!.clips[0]!.staticParameters?.["audio.volume"])
      .toBeCloseTo(10 ** (12 / 20), 8);
  });

  it("routes group rack FX and level through native bus persistence", async () => {
    const { files, editing, recordEdit, selection } = fixture();
    const chain = '{"version":1,"nodes":[]}';
    expect(await commitNativeMediaAttributes(selection("bus"), [
      { type: "attribute", property: "fx-chain", value: chain },
    ], "index.html", editing as Parameters<typeof commitNativeMediaAttributes>[3], recordEdit)).toBe(true);
    expect(await commitNativeMediaAttributes(selection("bus"), [
      { type: "attribute", property: "volume", value: "0.5" },
    ], "index.html", editing as Parameters<typeof commitNativeMediaAttributes>[3], recordEdit)).toBe(true);
    const native = parseNativeProjectDocument(JSON.parse(files.get(NATIVE_PROJECT_DOCUMENT_PATH)!));
    expect(native.revision).toBe(2);
    expect(native.sequence.audioGroups?.[0]).toMatchObject({ fxChain: chain, volume: 0.5 });
    expect(files.get("index.html")).toContain('data-volume="0.5"');
    expect(recordEdit).toHaveBeenCalledTimes(2);
  });

  it("keeps bus gain in one native and HTML history entry across reopen, undo and redo", async () => {
    const { files, editing, recordEdit, selection } = fixture();
    expect(await commitNativeMediaAttributes(selection("bus"), [
      { type: "attribute", property: "volume", value: "0.5" },
    ], "index.html", editing as Parameters<typeof commitNativeMediaAttributes>[3], recordEdit)).toBe(true);
    expect(recordEdit).toHaveBeenCalledTimes(1);
    const entry = recordEdit.mock.calls[0]![0];
    expect(Object.keys(entry.files).sort()).toEqual([NATIVE_PROJECT_DOCUMENT_PATH, "index.html"].sort());
    const reopen = () => parseNativeProjectDocument(JSON.parse(files.get(NATIVE_PROJECT_DOCUMENT_PATH)!));
    expect(reopen().sequence.audioGroups?.[0]?.volume).toBe(0.5);
    expect(files.get("index.html")).toContain('data-volume="0.5"');

    for (const [path, snapshot] of Object.entries(entry.files)) files.set(path, snapshot.before);
    expect(reopen().sequence.audioGroups?.[0]?.volume).toBe(1);
    expect(files.get("index.html")).not.toContain("data-volume");

    for (const [path, snapshot] of Object.entries(entry.files)) files.set(path, snapshot.after);
    expect(reopen().sequence.audioGroups?.[0]?.volume).toBe(0.5);
    expect(files.get("index.html")).toContain('data-volume="0.5"');
  });

  it("saves gain and FX to native export and HTML, then preserves them on reattach", async () => {
    const { files, editing, recordEdit, selection } = fixture();
    const chain = '{"version":1,"nodes":[]}';
    expect(await commitNativeMediaAttributes(selection("detached"), [
      { type: "attribute", property: "volume", value: "0.4" },
      { type: "attribute", property: "fx-chain", value: chain },
    ], "index.html", editing as Parameters<typeof commitNativeMediaAttributes>[3], recordEdit)).toBe(true);
    const native = parseNativeProjectDocument(JSON.parse(files.get(NATIVE_PROJECT_DOCUMENT_PATH)!));
    expect(native.revision).toBe(1);
    expect(native.sequence.tracks[1]!.clips[0]!.staticParameters?.["audio.volume"]).toBe(0.4);
    expect(native.sequence.tracks[1]!.clips[0]!.audioFxChain).toBe(chain);
    expect(files.get("index.html")).toContain('data-volume="0.4"');
    expect(recordEdit).toHaveBeenCalledTimes(1);
    const attached = await commitNativeTimelineAudio({
      expectedRevision: 1, action: "reattach", clipId: "audio-clip", ...editing, recordEdit,
    });
    expect(attached.sequence.tracks[0]!.clips[0]!.staticParameters?.["audio.volume"]).toBe(0.4);
    expect(attached.sequence.tracks[0]!.clips[0]!.audioFxChain).toBe(chain);
    expect(recordEdit).toHaveBeenCalledTimes(2);
  });
  it("refuses to unmute a video while its sound is detached", async () => {
    const { files, editing, recordEdit, selection } = fixture();
    const before = new Map(files);
    await expect(commitNativeMediaAttributes(selection("camera"), [
      { type: "html-attribute", property: "muted", value: null },
    ], "index.html", editing as Parameters<typeof commitNativeMediaAttributes>[3], recordEdit))
      .rejects.toThrow("sound is detached");
    expect(files).toEqual(before);
    expect(recordEdit).not.toHaveBeenCalled();
  });
});
