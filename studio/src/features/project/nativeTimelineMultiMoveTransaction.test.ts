import { describe, expect, it, vi } from "vitest";

import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
  parseNativeProjectDocument,
  serializeNativeProjectDocument,
  type NativeProjectDocument,
} from "../../../shared/project/nativeProjectDocument";
import { NativeProjectRevisionConflictError } from "./nativeProjectPersistence";
import {
  NativeTimelineMultiMoveCompatibilityError,
  commitNativeTimelineMultiMove,
  type NativeTimelineMultiMoveCompatibilityEdit,
} from "./nativeTimelineMultiMoveTransaction";
import { buildTimelineMoveTimingPatch, buildPatchTarget } from "../timeline/timelineEditingHelpers";

const frameRate = { numerator: 24_000, denominator: 1_001 } as const;

function project(revision = 6): NativeProjectDocument {
  return parseNativeProjectDocument({
    schemaVersion: NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
    id: "project:transaction",
    revision,
    frameRate,
    canvas: { width: 1920, height: 1080, background: "#000000" },
    assets: [
      { id: "asset:a", kind: "video", name: "a.mov", durationFrames: 900 },
      { id: "asset:b", kind: "video", name: "b.mov", durationFrames: 900 },
    ],
    sequence: {
      id: "sequence:main",
      name: "Main",
      tracks: [{
        id: "source-track",
        kind: "video",
        lane: { authoredTrack: 4, displayTrack: 0 },
        clips: [{
          id: "clip:a",
          assetId: "asset:a",
          binding: { sourceFile: "z.html", domId: "clip-a" },
          startFrame: 24,
          durationFrames: 120,
          sourceInFrame: 0,
          muted: false,
          staticParameters: {},
          effects: [],
          parameterTracks: [],
        }, {
          id: "clip:b",
          assetId: "asset:b",
          binding: { sourceFile: "a.html", domId: "clip-b" },
          startFrame: 180,
          durationFrames: 90,
          sourceInFrame: 10,
          muted: false,
          staticParameters: { opacity: 0.5 },
          effects: [],
          parameterTracks: [],
        }],
      }, {
        id: "destination-track",
        kind: "video",
        lane: { authoredTrack: 8, displayTrack: 1 },
        clips: [],
      }],
    },
  });
}

const changes = [{
  element: { id: "clip-a", sourceFile: "z.html" },
  requestedStartSeconds: (48.8 * frameRate.denominator) / frameRate.numerator,
}, {
  element: { id: "clip-b", sourceFile: "a.html" },
  requestedStartSeconds: (240.2 * frameRate.denominator) / frameRate.numerator,
  destinationAuthoredTrack: 8,
}] as const;

const patchCompatibilityContent = (
  content: string,
  edit: NativeTimelineMultiMoveCompatibilityEdit,
): string => content
  .replace(
    new RegExp(`(<[^>]+id="${edit.binding.domId}"[^>]+data-start=")[^"]*`),
    `$1${edit.exactStartSeconds}`,
  )
  .replace(
    new RegExp(`(<[^>]+id="${edit.binding.domId}"[^>]+data-track-index=")[^"]*`),
    `$1${edit.destination.authoredTrack}`,
  );

function memory(options?: {
  revision?: number;
  missingPath?: string;
  failWritePath?: string;
  failHistory?: boolean;
  abortOnWritePath?: string;
}) {
  const nativeBefore = serializeNativeProjectDocument(project(options?.revision ?? 6));
  const compatibilityBefore = {
    "a.html": '<div id="clip-b" data-start="7.5075" data-track-index="4"></div>',
    "z.html": '<div id="clip-a" data-start="1.001" data-track-index="4"></div>',
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
    if (options?.abortOnWritePath === path && content !== expected) controller.abort(new Error("stop now"));
  });
  const recordEdit = vi.fn(async () => {
    events.push("history");
    if (options?.failHistory) throw new Error("history failed");
  });
  const onCommitted = vi.fn(() => events.push("published"));
  return {
    nativeBefore,
    compatibilityBefore,
    files,
    events,
    controller,
    readOptionalProjectFile,
    writeProjectFile,
    recordEdit,
    onCommitted,
  };
}

describe("native timeline multi-file move transaction", () => {
  it("accepts an unchanged split piece alongside a clip that really moves", async () => {
    const splitId = "native-split:native-clip:file:10:index.html|hf:39:hf-a9d71aab-03d9-40c3-be22-b6f8f4341bd8|dom:23:cs146-assignment6-watch|frame:1099";
    const splitStart = 1099 / 30;
    const native = parseNativeProjectDocument({
      schemaVersion: 1, id: "project:split-move", revision: 0,
      frameRate: { numerator: 30, denominator: 1 },
      canvas: { width: 1920, height: 1080, background: "#000" },
      assets: [{ id: "asset:video", kind: "video", name: "class.mov", durationFrames: 300 }],
      sequence: { id: "sequence:main", name: "Main", tracks: [{
        id: "track:video", kind: "video", lane: { authoredTrack: 0, displayTrack: 0 }, clips: [{
          id: splitId, assetId: "asset:video",
          binding: { sourceFile: "index.html", domId: "cs146-assignment6-watch-split" },
          startFrame: 1099, durationFrames: 30, sourceInFrame: 0, muted: false,
          effects: [], parameterTracks: [],
        }, {
          id: "zz-other", assetId: "asset:video",
          binding: { sourceFile: "index.html", domId: "other" },
          startFrame: 1200, durationFrames: 30, sourceInFrame: 0, muted: false,
          effects: [], parameterTracks: [],
        }],
      }] },
    });
    const source = `<main data-composition-id="main" data-duration="41"><video id="cs146-assignment6-watch-split" data-start="${splitStart}" data-duration="1"></video><video id="other" data-start="40" data-duration="1"></video></main>`;
    const files = new Map([
      [NATIVE_PROJECT_DOCUMENT_PATH, serializeNativeProjectDocument(native)],
      ["index.html", source],
    ]);
    const recordEdit = vi.fn(async () => {});
    const result = await commitNativeTimelineMultiMove({
      expectedRevision: 0,
      changes: [
        { element: { attributes: { "data-studio-clip-id": splitId } }, requestedStartSeconds: splitStart },
        { element: { attributes: { "data-studio-clip-id": "zz-other" } }, requestedStartSeconds: 41 },
      ],
      readOptionalProjectFile: async path => files.get(path),
      writeProjectFile: async (path, content, expected) => {
        expect(files.get(path)).toBe(expected);
        files.set(path, content);
      },
      recordEdit,
      patchCompatibilityContent: (content, edit) => {
        const target = buildPatchTarget(edit.binding)!;
        return buildTimelineMoveTimingPatch(content, target, edit.exactStartSeconds, 1, undefined, String(edit.exactStartSeconds));
      },
    });
    expect(result.committed).toBe(true);
    expect(files.get("index.html")).toContain(`id="cs146-assignment6-watch-split" data-start="${splitStart}"`);
    expect(files.get("index.html")).toContain('id="other" data-start="41"');
    expect(recordEdit).toHaveBeenCalledOnce();

    const staleSource = source.replace(`data-start="${splitStart}"`, 'data-start="35"');
    const staleFiles = new Map([
      [NATIVE_PROJECT_DOCUMENT_PATH, serializeNativeProjectDocument(native)],
      ["index.html", staleSource],
    ]);
    await expect(commitNativeTimelineMultiMove({
      expectedRevision: 0,
      changes: [{ element: { attributes: { "data-studio-clip-id": splitId } }, requestedStartSeconds: splitStart }],
      readOptionalProjectFile: async path => staleFiles.get(path),
      writeProjectFile: async () => { throw new Error("No write is allowed for stale timing"); },
      recordEdit: async () => { throw new Error("No history is allowed for stale timing"); },
      patchCompatibilityContent: content => content,
    })).rejects.toThrow(`Compatibility source index.html did not accept the patch for native clip ${splitId}`);
  });
  it("moves a preview-identified clip after its hf identity was omitted from authored source", async () => {
    const id = "native-clip:file:10:index.html|hf:39:hf-a9d71aab-03d9-40c3-be22-b6f8f4341bd8|dom:23:cs146-assignment6-watch";
    const source = '<main data-composition-id="main" data-duration="2"><video id="cs146-assignment6-watch" data-start="0" data-duration="2"></video></main>';
    const native = parseNativeProjectDocument({
      schemaVersion: 1, id: "project:binding-repair", revision: 0,
      frameRate: { numerator: 30, denominator: 1 },
      canvas: { width: 1920, height: 1080, background: "#000" },
      assets: [{ id: "asset:a", kind: "video", name: "a.mov", durationFrames: 300 }],
      sequence: { id: "sequence:main", name: "Main", tracks: [{
        id: "track:video", kind: "video", lane: { authoredTrack: 0, displayTrack: 0 }, clips: [{
          id, assetId: "asset:a", binding: { sourceFile: "index.html", domId: "cs146-assignment6-watch", hfId: "hf-a9d71aab-03d9-40c3-be22-b6f8f4341bd8" },
          startFrame: 0, durationFrames: 60, sourceInFrame: 0, muted: false,
          effects: [], parameterTracks: [],
        }],
      }] },
    });
    const files = new Map([
      [NATIVE_PROJECT_DOCUMENT_PATH, serializeNativeProjectDocument(native)],
      ["index.html", source],
    ]);
    const recordEdit = vi.fn(async () => {});
    const result = await commitNativeTimelineMultiMove({
      expectedRevision: 0,
      changes: [{ element: { attributes: { "data-studio-clip-id": id } }, requestedStartSeconds: 1 }],
      readOptionalProjectFile: async path => files.get(path),
      writeProjectFile: async (path, content, expected) => {
        expect(files.get(path)).toBe(expected);
        files.set(path, content);
      },
      recordEdit,
      patchCompatibilityContent: (content, edit) => {
        // The preview locator can be stale; the transaction supplies the
        // persisted binding that actually owns this source node.
        const target = buildPatchTarget(edit.binding);
        return target ? buildTimelineMoveTimingPatch(content, target, edit.exactStartSeconds, 2) : content;
      },
    });
    expect(result.committed).toBe(true);
    expect(files.get("index.html")).toContain('data-start="1"');
    expect(files.get("index.html")).toContain('data-hf-id="hf-a9d71aab-03d9-40c3-be22-b6f8f4341bd8"');
    expect(recordEdit).toHaveBeenCalledOnce();
  });
  it("uses one durable file transaction for every snapshot before publication", async () => {
    const state = memory();
    let resolveCommit!: () => void;
    const commitFileTransaction = vi.fn(() => new Promise<void>((resolve) => { resolveCommit = resolve; }));
    const pending = commitNativeTimelineMultiMove({
      expectedRevision: 6,
      changes,
      readOptionalProjectFile: state.readOptionalProjectFile,
      writeProjectFile: state.writeProjectFile,
      recordEdit: state.recordEdit,
      commitFileTransaction,
      patchCompatibilityContent,
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
      history: {
        label: "Move timeline clips",
        kind: "timeline",
        coalesceKey: "timeline-move-many:clip:a,clip:b",
      },
    });
    resolveCommit();
    await pending;
    expect(state.onCommitted).toHaveBeenCalledOnce();

    const rejectedState = memory();
    await expect(commitNativeTimelineMultiMove({
      expectedRevision: 6,
      changes,
      readOptionalProjectFile: rejectedState.readOptionalProjectFile,
      writeProjectFile: rejectedState.writeProjectFile,
      recordEdit: rejectedState.recordEdit,
      commitFileTransaction: vi.fn(async () => { throw new Error("durable group move failed"); }),
      patchCompatibilityContent,
      onCommitted: rejectedState.onCommitted,
    })).rejects.toThrow("durable group move failed");
    expect(rejectedState.onCommitted).not.toHaveBeenCalled();
  });

  it("commits all native moves and sorted compatibility files in one revision and history entry", async () => {
    const state = memory();
    const result = await commitNativeTimelineMultiMove({
      expectedRevision: 6,
      changes,
      readOptionalProjectFile: state.readOptionalProjectFile,
      writeProjectFile: state.writeProjectFile,
      recordEdit: state.recordEdit,
      patchCompatibilityContent,
      onCommitted: state.onCommitted,
    });

    expect(result.committed).toBe(true);
    if (!result.committed) return;
    expect(result.document.revision).toBe(7);
    expect(result.moves.map((move) => [move.address.clipId, move.startFrame])).toEqual([
      ["clip:a", 48],
      ["clip:b", 240],
    ]);
    expect(result.compatibilityContents).toEqual({
      "a.html": expect.stringContaining('data-track-index="8"'),
      "z.html": expect.stringContaining('data-start="2.002"'),
    });
    expect(state.events.filter((event) => event.startsWith("write:"))).toEqual([
      `write:${NATIVE_PROJECT_DOCUMENT_PATH}`,
      "write:a.html",
      "write:z.html",
    ]);
    expect(state.recordEdit).toHaveBeenCalledOnce();
    expect(state.recordEdit).toHaveBeenCalledWith({
      label: "Move timeline clips",
      kind: "timeline",
      coalesceKey: "timeline-move-many:clip:a,clip:b",
      files: {
        [NATIVE_PROJECT_DOCUMENT_PATH]: {
          before: state.nativeBefore,
          after: state.files.get(NATIVE_PROJECT_DOCUMENT_PATH),
        },
        "a.html": {
          before: state.compatibilityBefore["a.html"],
          after: state.files.get("a.html"),
        },
        "z.html": {
          before: state.compatibilityBefore["z.html"],
          after: state.files.get("z.html"),
        },
      },
    });
    expect(state.events.at(-1)).toBe("published");
    expect(state.onCommitted).toHaveBeenCalledWith(result.document);
  });

  it("rolls successful writes back in reverse order when a later source write fails", async () => {
    const state = memory({ failWritePath: "z.html" });

    await expect(commitNativeTimelineMultiMove({
      expectedRevision: 6,
      changes,
      readOptionalProjectFile: state.readOptionalProjectFile,
      writeProjectFile: state.writeProjectFile,
      recordEdit: state.recordEdit,
      patchCompatibilityContent,
      onCommitted: state.onCommitted,
    })).rejects.toThrow("write failed: z.html");

    expect(state.files.get(NATIVE_PROJECT_DOCUMENT_PATH)).toBe(state.nativeBefore);
    expect(state.files.get("a.html")).toBe(state.compatibilityBefore["a.html"]);
    expect(state.files.get("z.html")).toBe(state.compatibilityBefore["z.html"]);
    expect(state.events.filter((event) => event.startsWith("write:")).slice(-2)).toEqual([
      "write:a.html",
      `write:${NATIVE_PROJECT_DOCUMENT_PATH}`,
    ]);
    expect(state.recordEdit).not.toHaveBeenCalled();
    expect(state.onCommitted).not.toHaveBeenCalled();
  });

  it("rolls every durable file back in reverse order when history registration fails", async () => {
    const state = memory({ failHistory: true });

    await expect(commitNativeTimelineMultiMove({
      expectedRevision: 6,
      changes,
      readOptionalProjectFile: state.readOptionalProjectFile,
      writeProjectFile: state.writeProjectFile,
      recordEdit: state.recordEdit,
      patchCompatibilityContent,
      onCommitted: state.onCommitted,
    })).rejects.toThrow("history failed");

    expect(state.files.get(NATIVE_PROJECT_DOCUMENT_PATH)).toBe(state.nativeBefore);
    expect(state.files.get("a.html")).toBe(state.compatibilityBefore["a.html"]);
    expect(state.files.get("z.html")).toBe(state.compatibilityBefore["z.html"]);
    expect(state.events.filter((event) => event.startsWith("write:")).slice(-3)).toEqual([
      "write:z.html",
      "write:a.html",
      `write:${NATIVE_PROJECT_DOCUMENT_PATH}`,
    ]);
    expect(state.onCommitted).not.toHaveBeenCalled();
  });

  it("performs no durable work when one compatibility source is missing", async () => {
    const state = memory({ missingPath: "z.html" });
    const result = await commitNativeTimelineMultiMove({
      expectedRevision: 6,
      changes,
      readOptionalProjectFile: state.readOptionalProjectFile,
      writeProjectFile: state.writeProjectFile,
      recordEdit: state.recordEdit,
      patchCompatibilityContent,
      onCommitted: state.onCommitted,
    });

    expect(result).toEqual({ committed: false, reason: "missing-compatibility-file", sourceFile: "z.html" });
    expect(state.writeProjectFile).not.toHaveBeenCalled();
    expect(state.recordEdit).not.toHaveBeenCalled();
    expect(state.onCommitted).not.toHaveBeenCalled();
  });

  it("performs no write, history, or publication on a revision conflict", async () => {
    const state = memory({ revision: 7 });

    await expect(commitNativeTimelineMultiMove({
      expectedRevision: 6,
      changes,
      readOptionalProjectFile: state.readOptionalProjectFile,
      writeProjectFile: state.writeProjectFile,
      recordEdit: state.recordEdit,
      patchCompatibilityContent,
      onCommitted: state.onCommitted,
    })).rejects.toBeInstanceOf(NativeProjectRevisionConflictError);
    expect(state.writeProjectFile).not.toHaveBeenCalled();
    expect(state.recordEdit).not.toHaveBeenCalled();
    expect(state.onCommitted).not.toHaveBeenCalled();
  });

  it("rolls back if cancellation arrives between durable writes", async () => {
    const state = memory({ abortOnWritePath: "a.html" });

    await expect(commitNativeTimelineMultiMove({
      expectedRevision: 6,
      changes,
      readOptionalProjectFile: state.readOptionalProjectFile,
      writeProjectFile: state.writeProjectFile,
      recordEdit: state.recordEdit,
      patchCompatibilityContent,
      onCommitted: state.onCommitted,
      signal: state.controller.signal,
    })).rejects.toThrow("stop now");
    expect(state.files.get(NATIVE_PROJECT_DOCUMENT_PATH)).toBe(state.nativeBefore);
    expect(state.files.get("a.html")).toBe(state.compatibilityBefore["a.html"]);
    expect(state.recordEdit).not.toHaveBeenCalled();
    expect(state.onCommitted).not.toHaveBeenCalled();
  });

  it("rejects a compatibility adapter that did not patch one requested element", async () => {
    const state = memory();
    await expect(commitNativeTimelineMultiMove({
      expectedRevision: 6,
      changes,
      readOptionalProjectFile: state.readOptionalProjectFile,
      writeProjectFile: state.writeProjectFile,
      recordEdit: state.recordEdit,
      patchCompatibilityContent: (content, edit) =>
        edit.address.clipId === "clip:a" ? content : patchCompatibilityContent(content, edit),
      onCommitted: state.onCommitted,
    })).rejects.toBeInstanceOf(NativeTimelineMultiMoveCompatibilityError);
    expect(state.writeProjectFile).not.toHaveBeenCalled();
    expect(state.recordEdit).not.toHaveBeenCalled();
  });
});
