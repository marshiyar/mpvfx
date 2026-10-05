import { describe, expect, it, vi } from "vitest";
import type { PreviewElementState } from "../../../../shared/preview/agentProtocol";
import { NATIVE_PROJECT_DOCUMENT_PATH, parseNativeProjectDocument, serializeNativeProjectDocument } from "../../../../shared/project/nativeProjectDocument";
import { commitRemoteStackingBatch } from "../remoteStackingBatchTransaction";

const project = parseNativeProjectDocument({
  schemaVersion: 1, id: "project", revision: 2,
  frameRate: { numerator: 30, denominator: 1 },
  canvas: { width: 100, height: 100, background: "#000000" },
  assets: [{ id: "asset", kind: "image", name: "Card", source: "card.png", durationFrames: 300 }],
  sequence: { id: "main", name: "Main", tracks: [{ id: "track", kind: "mixed", clips: [
    { id: "clip-a", assetId: "asset", binding: { sourceFile: "index.html", domId: "a", hfId: "hf-a" },
      startFrame: 0, durationFrames: 60, sourceInFrame: 0, muted: false, effects: [], parameterTracks: [] },
    { id: "clip-b", assetId: "asset", binding: { sourceFile: "scene.html", domId: "b", hfId: "hf-b" },
      startFrame: 0, durationFrames: 60, sourceInFrame: 0, muted: false, effects: [], parameterTracks: [] },
  ] }] },
});
function state(id: string, sourceFile: string, position: string): PreviewElementState {
  return { handle: id === "a" ? "e1" : "e2", tag: "div", id, className: "", text: "", textEditable: false,
    rect: { x: 0, y: 0, width: 20, height: 20 }, visible: true, parent: null,
    sourceFile, compositionPath: sourceFile,
    dataAttributes: { "studio-clip-id": `clip-${id}`, "hf-id": `hf-${id}` },
    inlineStyles: {}, computedStyles: { position } };
}
const first = state("a", "index.html", "static");
const second = state("b", "scene.html", "absolute");

function harness() {
  const files = new Map([
    [NATIVE_PROJECT_DOCUMENT_PATH, serializeNativeProjectDocument(project)],
    ["index.html", '<div id="a" data-hf-id="hf-a"></div>'],
    ["scene.html", '<div id="b" data-hf-id="hf-b"></div>'],
  ]);
  const readOptionalProjectFile = vi.fn(async (path: string) => files.get(path) ?? null);
  const writeProjectFile = vi.fn(async (path: string, content: string, expected?: string) => {
    if (expected !== undefined && files.get(path) !== expected) throw new Error("stale source");
    files.set(path, content);
  });
  const recordEdit = vi.fn(async () => {});
  return { files, deps: { readOptionalProjectFile, writeProjectFile, recordEdit }, recordEdit };
}

describe("isolated lane stacking batch", () => {
  it("persists cascaded clips across files in one undo snapshot with static positioning", async () => {
    const { files, deps, recordEdit } = harness();
    expect(await commitRemoteStackingBatch([
      { state: first, zIndex: 5 }, { state: second, zIndex: 6 },
    ], "clip-lane-move:7", deps)).toBe(true);
    expect(files.get("index.html")).toContain("z-index: 5");
    expect(files.get("index.html")).toContain("position: relative");
    expect(files.get("scene.html")).toContain("z-index: 6");
    expect(files.get("scene.html")).not.toContain("position: relative");
    expect(recordEdit).toHaveBeenCalledTimes(1);
    const entry = recordEdit.mock.calls[0]![0] as { coalesceKey?: string; coalesceMs?: number;
      files: Record<string, { before: string; after: string }> };
    expect(entry.coalesceKey).toBe("clip-lane-move:7");
    expect(entry.coalesceMs).toBe(60_000);
    expect(Object.keys(entry.files).sort()).toEqual(["index.html", "scene.html"]);
    for (const [path, snapshot] of Object.entries(entry.files)) {
      expect(snapshot.after).toBe(files.get(path));
      files.set(path, snapshot.before);
    }
    expect(files.get("index.html")).not.toContain("z-index");
    expect(files.get("scene.html")).not.toContain("z-index");
  });

  it("refuses a forged or ambiguous member before writing any file", async () => {
    const { files, deps } = harness();
    await expect(commitRemoteStackingBatch([
      { state: first, zIndex: 5 }, { state: { ...second, id: "other" }, zIndex: 6 },
    ], undefined, deps)).rejects.toThrow(/no longer matches/);
    expect(deps.writeProjectFile).not.toHaveBeenCalled();
    files.set("scene.html", '<div id="b" data-hf-id="hf-b"></div><div id="b"></div>');
    await expect(commitRemoteStackingBatch([{ state: second, zIndex: 5 }], undefined, deps))
      .rejects.toThrow(/uniquely/);
    expect(deps.writeProjectFile).not.toHaveBeenCalled();
  });

  it("restores all files when history fails and rejects out-of-range z", async () => {
    const { files, deps } = harness();
    const originals = new Map(files);
    deps.recordEdit.mockRejectedValueOnce(new Error("history failed"));
    await expect(commitRemoteStackingBatch([
      { state: first, zIndex: 5 }, { state: second, zIndex: 6 },
    ], undefined, deps)).rejects.toThrow("history failed");
    expect(files).toEqual(originals);
    await expect(commitRemoteStackingBatch([{ state: first, zIndex: 999999 }], undefined, deps))
      .rejects.toThrow(/bounded range/);
    expect(files).toEqual(originals);
  });
});
