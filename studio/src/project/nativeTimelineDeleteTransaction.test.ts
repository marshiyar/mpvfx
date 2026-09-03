// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
  parseNativeProjectDocument,
  serializeNativeProjectDocument,
  type NativeClipDomBinding,
  type NativeProjectDocument,
} from "./nativeProjectDocument";
import { NativeProjectRevisionConflictError } from "./nativeProjectPersistence";
import {
  NativeTimelineDeleteCompatibilityError,
  commitNativeTimelineDelete,
  type NativeTimelineDeleteCompatibilityEdit,
} from "./nativeTimelineDeleteTransaction";

function project(revision = 8): NativeProjectDocument {
  return parseNativeProjectDocument({
    schemaVersion: NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
    id: "project:delete-transaction",
    revision,
    frameRate: { numerator: 30, denominator: 1 },
    canvas: { width: 1920, height: 1080, background: "#000000" },
    assets: [
      { id: "asset:a", kind: "video", name: "a.mov", durationFrames: 900 },
      { id: "asset:b", kind: "video", name: "b.mov", durationFrames: 900 },
      { id: "asset:c", kind: "audio", name: "c.wav", durationFrames: 900 },
    ],
    sequence: {
      id: "sequence:main",
      name: "Main",
      tracks: [{
        id: "video-track",
        kind: "video",
        lane: { authoredTrack: 0, displayTrack: 0 },
        clips: [{
          id: "clip:a", assetId: "asset:a",
          binding: { sourceFile: "z.html", domId: "clip-a" },
          startFrame: 30, durationFrames: 120, sourceInFrame: 11,
          playbackRate: { numerator: 1, denominator: 1 }, muted: true,
          staticParameters: { opacity: 0.7 },
          effects: [{ id: "fx:a", effectId: "grade", enabled: true }],
          parameterTracks: [],
        }, {
          id: "clip:b", assetId: "asset:b",
          binding: { sourceFile: "z.html", domId: "clip-b" },
          startFrame: 300, durationFrames: 60, sourceInFrame: 22,
          playbackRate: { numerator: 2, denominator: 1 }, muted: false,
          staticParameters: { "transform.position.x": 20 }, effects: [], parameterTracks: [],
        }],
      }, {
        id: "audio-track",
        kind: "audio",
        lane: { authoredTrack: 1, displayTrack: 1 },
        clips: [{
          id: "clip:c", assetId: "asset:c",
          binding: { sourceFile: "a.html", selector: ".clip-c", selectorIndex: 0 },
          startFrame: 10, durationFrames: 50, sourceInFrame: 2,
          playbackRate: { numerator: 1, denominator: 1 }, muted: false,
          staticParameters: { "audio.volume": 0.8 }, effects: [], parameterTracks: [],
        }],
      }],
    },
  });
}

const targets = [
  { id: "clip-a", sourceFile: "z.html" },
  { sourceFile: "a.html", selector: ".clip-c", selectorIndex: 0 },
] as const;

const removeCompatibilityTarget = (
  content: string,
  edit: NativeTimelineDeleteCompatibilityEdit,
): string => {
  const binding = edit.binding as NativeClipDomBinding;
  const identity = binding.domId ?? (binding.selector === ".clip-c" ? "clip-c" : null);
  return identity
    ? content.replace(new RegExp(`<div id="${identity}"[^>]*></div>`, "g"), "")
    : content;
};

function memory(options?: {
  revision?: number;
  missingPath?: string;
  failWritePath?: string;
  failHistory?: boolean;
  abortOnWritePath?: string;
}) {
  const nativeBefore = serializeNativeProjectDocument(project(options?.revision ?? 8));
  const compatibilityBefore = {
    "a.html": '<main data-composition-id="a" data-duration="9"><div id="clip-c" data-start="0.333" data-duration="1.667"></div><div id="keep-a" data-start="2" data-duration="3"></div></main>',
    "z.html": '<main data-composition-id="z" data-duration="20"><div id="clip-a" data-start="1" data-duration="4"></div><div id="clip-b" data-start="10" data-duration="2"></div></main>',
  } as const;
  const files = new Map<string, string>([
    [NATIVE_PROJECT_DOCUMENT_PATH, nativeBefore],
    ...Object.entries(compatibilityBefore),
  ]);
  if (options?.missingPath) files.delete(options.missingPath);
  const events: string[] = [];
  const controller = new AbortController();
  const readOptionalProjectFile = vi.fn(async (path: string) => {
    events.push(`read:${path}`);
    return files.get(path);
  });
  const writeProjectFile = vi.fn(async (path: string, content: string, expected?: string) => {
    events.push(`write:${path}`);
    if (files.get(path) !== expected) throw new Error(`CAS conflict: ${path}`);
    if (options?.failWritePath === path && content !== files.get(path)) {
      throw new Error(`write failed: ${path}`);
    }
    files.set(path, content);
    if (options?.abortOnWritePath === path && content !== expected) {
      controller.abort(new Error("delete stopped"));
    }
  });
  const recordEdit = vi.fn(async () => {
    events.push("history");
    if (options?.failHistory) throw new Error("history failed");
  });
  const onCommitted = vi.fn(() => events.push("published"));
  return {
    nativeBefore, compatibilityBefore, files, events, controller,
    readOptionalProjectFile, writeProjectFile, recordEdit, onCommitted,
  };
}

describe("native timeline delete transaction", () => {
  it("uses one durable file transaction for every snapshot before publication", async () => {
    const state = memory();
    let resolveCommit!: () => void;
    const commitFileTransaction = vi.fn(() => new Promise<void>((resolve) => { resolveCommit = resolve; }));
    const pending = commitNativeTimelineDelete({
      expectedRevision: 8,
      targets,
      readOptionalProjectFile: state.readOptionalProjectFile,
      writeProjectFile: state.writeProjectFile,
      recordEdit: state.recordEdit,
      commitFileTransaction,
      removeCompatibilityTarget,
      onCommitted: state.onCommitted,
    });

    await vi.waitFor(() => expect(commitFileTransaction).toHaveBeenCalledOnce());
    expect(state.writeProjectFile).not.toHaveBeenCalled();
    expect(state.recordEdit).not.toHaveBeenCalled();
    expect(state.onCommitted).not.toHaveBeenCalled();
    expect(commitFileTransaction).toHaveBeenCalledWith({
      files: [
        expect.objectContaining({ path: NATIVE_PROJECT_DOCUMENT_PATH, expectedBefore: state.nativeBefore }),
        expect.objectContaining({ path: "a.html", expectedBefore: state.compatibilityBefore["a.html"] }),
        expect.objectContaining({ path: "z.html", expectedBefore: state.compatibilityBefore["z.html"] }),
      ],
      history: { label: "Delete timeline clips", kind: "timeline" },
    });
    resolveCommit();
    await pending;
    expect(state.onCommitted).toHaveBeenCalledOnce();

    const rejectedState = memory();
    await expect(commitNativeTimelineDelete({
      expectedRevision: 8,
      targets,
      readOptionalProjectFile: rejectedState.readOptionalProjectFile,
      writeProjectFile: rejectedState.writeProjectFile,
      recordEdit: rejectedState.recordEdit,
      commitFileTransaction: vi.fn(async () => { throw new Error("durable delete failed"); }),
      removeCompatibilityTarget,
      onCommitted: rejectedState.onCommitted,
    })).rejects.toThrow("durable delete failed");
    expect(rejectedState.onCommitted).not.toHaveBeenCalled();
  });

  it("deletes clips across sorted source files with one revision and one history entry", async () => {
    const state = memory();
    const result = await commitNativeTimelineDelete({
      expectedRevision: 8,
      targets,
      readOptionalProjectFile: state.readOptionalProjectFile,
      writeProjectFile: state.writeProjectFile,
      recordEdit: state.recordEdit,
      removeCompatibilityTarget,
      onCommitted: state.onCommitted,
    });

    expect(result.committed).toBe(true);
    if (!result.committed) return;
    expect(result.document.revision).toBe(9);
    expect(result.document.sequence.tracks[0]!.clips.map((clip) => clip.id)).toEqual(["clip:b"]);
    expect(result.document.sequence.tracks[1]!.clips).toEqual([]);
    expect(result.document.sequence.tracks[0]!.clips[0]).toMatchObject({
      id: "clip:b", sourceInFrame: 22, playbackRate: { numerator: 2, denominator: 1 },
      staticParameters: { "transform.position.x": 20 },
    });
    expect(result.compatibilityContents["a.html"]).not.toContain('id="clip-c"');
    expect(result.compatibilityContents["a.html"]).toContain('data-duration="5"');
    expect(result.compatibilityContents["z.html"]).not.toContain('id="clip-a"');
    expect(result.compatibilityContents["z.html"]).toContain('data-duration="12"');
    expect(state.events.filter((event) => event.startsWith("write:"))).toEqual([
      `write:${NATIVE_PROJECT_DOCUMENT_PATH}`, "write:a.html", "write:z.html",
    ]);
    expect(state.recordEdit).toHaveBeenCalledOnce();
    expect(state.recordEdit).toHaveBeenCalledWith({
      label: "Delete timeline clips",
      kind: "timeline",
      files: {
        [NATIVE_PROJECT_DOCUMENT_PATH]: {
          before: state.nativeBefore,
          after: state.files.get(NATIVE_PROJECT_DOCUMENT_PATH),
        },
        "a.html": { before: state.compatibilityBefore["a.html"], after: state.files.get("a.html") },
        "z.html": { before: state.compatibilityBefore["z.html"], after: state.files.get("z.html") },
      },
    });
    expect(state.events.at(-1)).toBe("published");
    expect(state.onCommitted).toHaveBeenCalledWith(result.document);
  });

  it("deletes multiple clips in one source by accumulating callback output", async () => {
    const state = memory();
    const result = await commitNativeTimelineDelete({
      expectedRevision: 8,
      targets: [
        { id: "clip-a", sourceFile: "z.html" },
        { id: "clip-b", sourceFile: "z.html" },
      ],
      readOptionalProjectFile: state.readOptionalProjectFile,
      writeProjectFile: state.writeProjectFile,
      recordEdit: state.recordEdit,
      removeCompatibilityTarget,
    });

    expect(result.committed).toBe(true);
    if (!result.committed) return;
    expect(result.compatibilityContents["z.html"]).not.toMatch(/id="clip-[ab]"/);
    expect(state.events.filter((event) => event === "write:z.html")).toHaveLength(1);
    expect(state.recordEdit).toHaveBeenCalledOnce();
  });

  it("performs no writes when any compatibility source is missing", async () => {
    const state = memory({ missingPath: "z.html" });
    const result = await commitNativeTimelineDelete({
      expectedRevision: 8, targets,
      readOptionalProjectFile: state.readOptionalProjectFile,
      writeProjectFile: state.writeProjectFile,
      recordEdit: state.recordEdit,
      removeCompatibilityTarget,
      onCommitted: state.onCommitted,
    });

    expect(result).toEqual({ committed: false, reason: "missing-compatibility-file", sourceFile: "z.html" });
    expect(state.writeProjectFile).not.toHaveBeenCalled();
    expect(state.recordEdit).not.toHaveBeenCalled();
    expect(state.onCommitted).not.toHaveBeenCalled();
  });

  it("rejects when the callback fails to match any one exact target", async () => {
    const state = memory();
    await expect(commitNativeTimelineDelete({
      expectedRevision: 8, targets,
      readOptionalProjectFile: state.readOptionalProjectFile,
      writeProjectFile: state.writeProjectFile,
      recordEdit: state.recordEdit,
      removeCompatibilityTarget: (content, edit) =>
        edit.address.clipId === "clip:a" ? content : removeCompatibilityTarget(content, edit),
    })).rejects.toBeInstanceOf(NativeTimelineDeleteCompatibilityError);
    expect(state.writeProjectFile).not.toHaveBeenCalled();
    expect(state.recordEdit).not.toHaveBeenCalled();
  });

  it("rejects a stale native revision before compatibility reads or writes", async () => {
    const state = memory({ revision: 9 });
    await expect(commitNativeTimelineDelete({
      expectedRevision: 8, targets,
      readOptionalProjectFile: state.readOptionalProjectFile,
      writeProjectFile: state.writeProjectFile,
      recordEdit: state.recordEdit,
      removeCompatibilityTarget,
      onCommitted: state.onCommitted,
    })).rejects.toBeInstanceOf(NativeProjectRevisionConflictError);
    expect(state.readOptionalProjectFile).toHaveBeenCalledTimes(1);
    expect(state.writeProjectFile).not.toHaveBeenCalled();
    expect(state.recordEdit).not.toHaveBeenCalled();
    expect(state.onCommitted).not.toHaveBeenCalled();
  });

  it("rolls successful writes back in reverse order when a later file write fails", async () => {
    const state = memory({ failWritePath: "z.html" });
    await expect(commitNativeTimelineDelete({
      expectedRevision: 8, targets,
      readOptionalProjectFile: state.readOptionalProjectFile,
      writeProjectFile: state.writeProjectFile,
      recordEdit: state.recordEdit,
      removeCompatibilityTarget,
      onCommitted: state.onCommitted,
    })).rejects.toThrow("write failed: z.html");
    expect(state.files.get(NATIVE_PROJECT_DOCUMENT_PATH)).toBe(state.nativeBefore);
    expect(state.files.get("a.html")).toBe(state.compatibilityBefore["a.html"]);
    expect(state.files.get("z.html")).toBe(state.compatibilityBefore["z.html"]);
    expect(state.events.filter((event) => event.startsWith("write:")).slice(-2)).toEqual([
      "write:a.html", `write:${NATIVE_PROJECT_DOCUMENT_PATH}`,
    ]);
    expect(state.recordEdit).not.toHaveBeenCalled();
    expect(state.onCommitted).not.toHaveBeenCalled();
  });

  it("rolls every file back when history registration fails", async () => {
    const state = memory({ failHistory: true });
    await expect(commitNativeTimelineDelete({
      expectedRevision: 8, targets,
      readOptionalProjectFile: state.readOptionalProjectFile,
      writeProjectFile: state.writeProjectFile,
      recordEdit: state.recordEdit,
      removeCompatibilityTarget,
      onCommitted: state.onCommitted,
    })).rejects.toThrow("history failed");
    expect(state.files.get(NATIVE_PROJECT_DOCUMENT_PATH)).toBe(state.nativeBefore);
    expect(state.files.get("a.html")).toBe(state.compatibilityBefore["a.html"]);
    expect(state.files.get("z.html")).toBe(state.compatibilityBefore["z.html"]);
    expect(state.events.filter((event) => event.startsWith("write:")).slice(-3)).toEqual([
      "write:z.html", "write:a.html", `write:${NATIVE_PROJECT_DOCUMENT_PATH}`,
    ]);
    expect(state.onCommitted).not.toHaveBeenCalled();
  });

  it("rolls back if cancellation arrives between durable writes", async () => {
    const state = memory({ abortOnWritePath: "a.html" });
    await expect(commitNativeTimelineDelete({
      expectedRevision: 8, targets,
      readOptionalProjectFile: state.readOptionalProjectFile,
      writeProjectFile: state.writeProjectFile,
      recordEdit: state.recordEdit,
      removeCompatibilityTarget,
      onCommitted: state.onCommitted,
      signal: state.controller.signal,
    })).rejects.toThrow("delete stopped");
    expect(state.files.get(NATIVE_PROJECT_DOCUMENT_PATH)).toBe(state.nativeBefore);
    expect(state.files.get("a.html")).toBe(state.compatibilityBefore["a.html"]);
    expect(state.recordEdit).not.toHaveBeenCalled();
    expect(state.onCommitted).not.toHaveBeenCalled();
  });
});
