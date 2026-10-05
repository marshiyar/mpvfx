import { describe, expect, it, vi } from "vitest";
import type { PreviewElementState } from "../../../../shared/preview/agentProtocol";
import { NATIVE_PROJECT_DOCUMENT_PATH, parseNativeProjectDocument, serializeNativeProjectDocument } from "../../../../shared/project/nativeProjectDocument";
import { commitRemoteInspectorSourcePatch, commitRemoteLegacyInspectorSourcePatch,
  commitRemoteLegacyGradePreset } from "../remoteInspectorSourceTransaction";

const project = parseNativeProjectDocument({
  schemaVersion: 1, id: "project", revision: 2,
  frameRate: { numerator: 30, denominator: 1 },
  canvas: { width: 100, height: 100, background: "#000000" },
  assets: [{ id: "asset", kind: "image", name: "Card", source: "card.png", durationFrames: 300 }],
  sequence: { id: "main", name: "Main", tracks: [{ id: "track", kind: "mixed", clips: [{
    id: "clip", assetId: "asset", binding: { sourceFile: "index.html", domId: "card", hfId: "hf-card" },
    startFrame: 0, durationFrames: 60, sourceInFrame: 0, muted: false, effects: [], parameterTracks: [],
  }] }] },
});
const state: PreviewElementState = {
  handle: "e1", tag: "div", id: "card", className: "", text: "Before", textEditable: true,
  rect: { x: 0, y: 0, width: 100, height: 100 }, visible: true, parent: null,
  sourceFile: "index.html", compositionPath: "index.html",
  dataAttributes: { "studio-clip-id": "clip", "hf-id": "hf-card" },
  inlineStyles: {}, computedStyles: {},
};

function harness(html = '<html><body><div id="card" data-hf-id="hf-card">Before</div></body></html>') {
  const files = new Map([[NATIVE_PROJECT_DOCUMENT_PATH, serializeNativeProjectDocument(project)], ["index.html", html]]);
  const readOptionalProjectFile = vi.fn(async (path: string) => files.get(path) ?? null);
  const writeProjectFile = vi.fn(async (path: string, content: string, expected?: string) => {
    if (expected !== undefined && files.get(path) !== expected) throw new Error("stale source");
    files.set(path, content);
  });
  const recordEdit = vi.fn(async () => {});
  return { files, deps: { readOptionalProjectFile, writeProjectFile, recordEdit }, recordEdit };
}

describe("remote inspector durable source edits", () => {
  it("saves an exact bound style and text patch with one undoable file snapshot", async () => {
    const { files, deps, recordEdit } = harness();
    expect(await commitRemoteInspectorSourcePatch(state, [
      { type: "inline-style", property: "color", value: "#f00" },
      { type: "text-content", property: "textContent", value: "After" },
    ], "Edit card", deps)).toBe(true);
    const after = files.get("index.html")!;
    expect(after).toContain("color: #f00");
    expect(after).toContain("After</div>");
    expect(recordEdit).toHaveBeenCalledTimes(1);
    const history = recordEdit.mock.calls[0]![0] as { files: Record<string, { before: string; after: string }> };
    expect(history.files["index.html"]?.before).toContain("Before</div>");
    expect(history.files["index.html"]?.after).toBe(after);
    expect(files.get(NATIVE_PROJECT_DOCUMENT_PATH)).toBe(serializeNativeProjectDocument(project));
  });

  it("rejects preview identity forgery and ambiguous authored bindings without writing", async () => {
    const { deps, files } = harness();
    await expect(commitRemoteInspectorSourcePatch({ ...state, id: "other" }, [
      { type: "text-content", property: "textContent", value: "No" },
    ], "Edit", deps)).rejects.toThrow(/no longer matches/);
    files.set("index.html", '<div id="card" data-hf-id="hf-card">One</div><div id="card">Two</div>');
    await expect(commitRemoteInspectorSourcePatch(state, [
      { type: "text-content", property: "textContent", value: "No" },
    ], "Edit", deps)).rejects.toThrow(/uniquely/);
    expect(deps.writeProjectFile).not.toHaveBeenCalled();
  });

  it("restores the original source if history fails", async () => {
    const { deps, files } = harness();
    deps.recordEdit.mockRejectedValueOnce(new Error("history unavailable"));
    const before = files.get("index.html");
    await expect(commitRemoteInspectorSourcePatch(state, [
      { type: "inline-style", property: "color", value: "#f00" },
    ], "Edit", deps)).rejects.toThrow("history unavailable");
    expect(files.get("index.html")).toBe(before);
  });

  it("resets authored design while retaining clip identity and text", async () => {
    const { files, deps } = harness('<div id="card" data-hf-id="hf-card" style="color: red; font-size: 20px" data-start="3">Before</div>');
    expect(await commitRemoteInspectorSourcePatch(state, "reset-design", "Reset design", deps)).toBe(true);
    const after = files.get("index.html")!;
    expect(after).toContain('id="card"');
    expect(after).toContain("Before</div>");
    expect(after).toContain('data-start="3"');
    expect(after).not.toContain("color: red");
    expect(after).not.toContain("font-size: 20px");
  });

  it("refuses to replace nested authored markup from a stale preview leaf claim", async () => {
    const { deps } = harness('<div id="card" data-hf-id="hf-card"><span>Keep me</span></div>');
    await expect(commitRemoteInspectorSourcePatch(state, [
      { type: "text-content", property: "textContent", value: "No" },
    ], "Edit text", deps)).rejects.toThrow(/plain-text leaf/);
    expect(deps.writeProjectFile).not.toHaveBeenCalled();
  });

  it("refuses event attributes and unsafe CSS values before reading or writing", async () => {
    const { deps } = harness();
    await expect(commitRemoteInspectorSourcePatch(state, [
      { type: "html-attribute", property: "onclick", value: "alert(1)" },
    ], "Edit", deps)).rejects.toThrow(/not supported/);
    await expect(commitRemoteInspectorSourcePatch(state, [
      { type: "inline-style", property: "clip-path", value: "url(https://example.test/x)" },
    ], "Edit", deps)).rejects.toThrow(/not supported/);
    expect(deps.readOptionalProjectFile).not.toHaveBeenCalled();
  });

  it("does not silently mint an unsaved sidecar identity for a selector-only clip", async () => {
    const { deps, files } = harness();
    const selectorOnly = structuredClone(project);
    selectorOnly.sequence.tracks[0]!.clips[0]!.binding = { sourceFile: "index.html", selector: "#card" };
    files.set(NATIVE_PROJECT_DOCUMENT_PATH, serializeNativeProjectDocument(selectorOnly));
    await expect(commitRemoteInspectorSourcePatch(state, [
      { type: "inline-style", property: "color", value: "#f00" },
    ], "Edit", deps)).rejects.toThrow(/stable source identity/);
    expect(deps.writeProjectFile).not.toHaveBeenCalled();
  });

  it("refuses truncated authored text even when the preview script shortened it", async () => {
    const { deps } = harness(`<div id="card" data-hf-id="hf-card">${"A".repeat(300)}</div>`);
    await expect(commitRemoteInspectorSourcePatch(state, [
      { type: "text-content", property: "textContent", value: "Short" },
    ], "Edit text", deps)).rejects.toThrow(/plain-text leaf/);
    expect(deps.writeProjectFile).not.toHaveBeenCalled();
  });

  it("supports bounded, source-bound z-index reordering", async () => {
    const { files, deps } = harness();
    expect(await commitRemoteInspectorSourcePatch(state, [
      { type: "inline-style", property: "z-index", value: "42" },
    ], "Reorder layer", deps)).toBe(true);
    expect(files.get("index.html")).toContain("z-index: 42");
    await expect(commitRemoteInspectorSourcePatch(state, [
      { type: "inline-style", property: "z-index", value: "999999" },
    ], "Reorder layer", deps)).rejects.toThrow(/not supported/);
  });

  it("persists common fill and typography styles in one history entry", async () => {
    const { files, deps, recordEdit } = harness();
    expect(await commitRemoteInspectorSourcePatch(state, [
      { type: "inline-style", property: "background-color", value: "#123456" },
      { type: "inline-style", property: "font-weight", value: "700" },
      { type: "inline-style", property: "text-align", value: "center" },
      { type: "inline-style", property: "border-radius", value: "12px" },
    ], "Edit card", deps)).toBe(true);
    const after = files.get("index.html")!;
    expect(after).toContain("background-color: #123456");
    expect(after).toContain("font-weight: 700");
    expect(after).toContain("text-align: center");
    expect(after).toContain("border-radius: 12px");
    expect(recordEdit).toHaveBeenCalledTimes(1);
  });

  it("refuses stylesheet injection in added common style controls", async () => {
    const { deps } = harness();
    await expect(commitRemoteInspectorSourcePatch(state, [
      { type: "inline-style", property: "background-color", value: "url(https://example.test/x)" },
    ], "Edit", deps)).rejects.toThrow(/not supported/);
    await expect(commitRemoteInspectorSourcePatch(state, [
      { type: "inline-style", property: "border-radius", value: "12px;position:absolute" },
    ], "Edit", deps)).rejects.toThrow(/not supported/);
    expect(deps.readOptionalProjectFile).not.toHaveBeenCalled();
  });

  it("saves bounded border, gradient, and filter styles with one source snapshot", async () => {
    const { files, deps, recordEdit } = harness();
    expect(await commitRemoteInspectorSourcePatch(state, [
      { type: "inline-style", property: "border-color", value: "#abcdef" },
      { type: "inline-style", property: "background-image", value: "linear-gradient(90deg,#000000,#ffffff)" },
      { type: "inline-style", property: "filter", value: "blur(4px)" },
    ], "Edit visual style", deps)).toBe(true);
    expect(files.get("index.html")).toContain("border-color: #abcdef");
    expect(files.get("index.html")).toContain("linear-gradient(90deg,#000000,#ffffff)");
    expect(files.get("index.html")).toContain("filter: blur(4px)");
    expect(recordEdit).toHaveBeenCalledTimes(1);
    await expect(commitRemoteInspectorSourcePatch(state, [
      { type: "inline-style", property: "background-image", value: "url(https://bad.example/x)" },
    ], "Edit", deps)).rejects.toThrow(/not supported/);
  });
});

describe("legacy-only isolated inspector source edits", () => {
  it("saves and clears a verified source-bound video grade preset in one history entry", async () => {
    const video = { ...state, tag: "video", text: "", textEditable: false };
    const { files, deps, recordEdit } = harness('<video id="card" data-hf-id="hf-card" src="clip.mp4"></video>');
    files.delete(NATIVE_PROJECT_DOCUMENT_PATH);
    expect(await commitRemoteLegacyGradePreset(video, "warm-daylight", "index.html", deps)).toBe(true);
    expect(files.get("index.html")).toContain('data-color-grading=');
    expect(files.get("index.html")).toContain("warm-daylight");
    expect(recordEdit).toHaveBeenCalledTimes(1);
    expect(await commitRemoteLegacyGradePreset(video, null, "index.html", deps)).toBe(true);
    expect(files.get("index.html")).not.toContain('data-color-grading=');
    await expect(commitRemoteLegacyGradePreset(video, "unknown-preset", "index.html", deps))
      .rejects.toThrow(/unsupported/);
  });

  it("saves plain text and bounded style with one source history entry", async () => {
    const { files, deps, recordEdit } = harness();
    files.delete(NATIVE_PROJECT_DOCUMENT_PATH);
    expect(await commitRemoteLegacyInspectorSourcePatch(state, [
      { type: "text-content", property: "textContent", value: "After" },
      { type: "inline-style", property: "color", value: "#123456" },
    ], "Edit card", "index.html", deps)).toBe(true);
    expect(files.get("index.html")).toContain("After</div>");
    expect(files.get("index.html")).toContain("color: #123456");
    expect(recordEdit).toHaveBeenCalledTimes(1);
  });

  it("rejects drifted composition or duplicate authored identity before writing", async () => {
    const { files, deps } = harness();
    files.delete(NATIVE_PROJECT_DOCUMENT_PATH);
    await expect(commitRemoteLegacyInspectorSourcePatch(state, [
      { type: "text-content", property: "textContent", value: "No" },
    ], "Edit", "other.html", deps)).rejects.toThrow(/active composition/);
    files.set("index.html", '<div id="card" data-hf-id="hf-card">One</div><div id="card">Two</div>');
    await expect(commitRemoteLegacyInspectorSourcePatch(state, [
      { type: "text-content", property: "textContent", value: "No" },
    ], "Edit", "index.html", deps)).rejects.toThrow(/not unique/);
    expect(deps.writeProjectFile).not.toHaveBeenCalled();
  });

  it("refuses destructive nested text replacement and restores source after history failure", async () => {
    const { files, deps } = harness('<div id="card" data-hf-id="hf-card"><span>Keep</span></div>');
    files.delete(NATIVE_PROJECT_DOCUMENT_PATH);
    await expect(commitRemoteLegacyInspectorSourcePatch(state, [
      { type: "text-content", property: "textContent", value: "No" },
    ], "Edit", "index.html", deps)).rejects.toThrow(/plain-text leaf/);
    const before = files.get("index.html")!;
    deps.recordEdit.mockRejectedValueOnce(new Error("history unavailable"));
    await expect(commitRemoteLegacyInspectorSourcePatch(state, [
      { type: "inline-style", property: "color", value: "#123456" },
    ], "Edit", "index.html", deps)).rejects.toThrow("history unavailable");
    expect(files.get("index.html")).toBe(before);
  });
});
