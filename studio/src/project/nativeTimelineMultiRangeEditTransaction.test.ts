import { describe, expect, it, vi } from "vitest";

import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
  parseNativeProjectDocument,
  serializeNativeProjectDocument,
  type NativeProjectDocument,
} from "./nativeProjectDocument";
import { NativeProjectRevisionConflictError } from "./nativeProjectPersistence";
import {
  NativeTimelineMultiRangeCompatibilityError,
  commitNativeTimelineMultiRangeEdit,
  type NativeTimelineMultiRangeCompatibilityEdit,
} from "./nativeTimelineMultiRangeEditTransaction";

const frameRate = { numerator: 30_000, denominator: 1_001 } as const;
const secondsAtFrame = (frame: number) => (frame * frameRate.denominator) / frameRate.numerator;

function project(revision = 12): NativeProjectDocument {
  return parseNativeProjectDocument({
    schemaVersion: NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
    id: "project:multi-range-transaction",
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
        id: "track:v1",
        kind: "video",
        clips: [{
          id: "clip:a",
          assetId: "asset:a",
          binding: { sourceFile: "z.html", domId: "clip-a" },
          startFrame: 30,
          durationFrames: 120,
          sourceInFrame: 10,
          playbackRate: { numerator: 2, denominator: 1 },
          muted: true,
          staticParameters: { opacity: 0.75 },
          effects: [{ id: "fx:a", effectId: "blur", enabled: true }],
          parameterTracks: [],
        }, {
          id: "clip:b",
          assetId: "asset:b",
          binding: { sourceFile: "a.html", domId: "clip-b" },
          startFrame: 180,
          durationFrames: 90,
          sourceInFrame: 20,
          playbackRate: { numerator: 2, denominator: 1 },
          muted: false,
          staticParameters: {},
          effects: [],
          parameterTracks: [],
        }],
      }],
    },
  });
}

const changes = [{
  element: { id: "clip-a", sourceFile: "z.html" },
  requestedStartSeconds: secondsAtFrame(45),
  requestedDurationSeconds: secondsAtFrame(105),
}, {
  element: { id: "clip-b", sourceFile: "a.html" },
  requestedStartSeconds: secondsAtFrame(180),
  requestedDurationSeconds: secondsAtFrame(60),
}] as const;

const patchCompatibilityContent = (
  content: string,
  edit: NativeTimelineMultiRangeCompatibilityEdit,
): string => content
  .replace(
    new RegExp(`(<[^>]+id="${edit.binding.domId}"[^>]+data-start=")[^"]*`),
    `$1${edit.timing.start}`,
  )
  .replace(
    new RegExp(`(<[^>]+id="${edit.binding.domId}"[^>]+data-duration=")[^"]*`),
    `$1${edit.timing.duration}`,
  )
  .replace(
    new RegExp(`(<[^>]+id="${edit.binding.domId}"[^>]+data-media-start=")[^"]*`),
    `$1${edit.timing.sourceOffset}`,
  );

function memory(options?: {
  revision?: number;
  missingPath?: string;
  failWritePath?: string;
  failHistory?: boolean;
  abortOnWritePath?: string;
}) {
  const nativeBefore = serializeNativeProjectDocument(project(options?.revision ?? 12));
  const compatibilityBefore = {
    "a.html": '<video id="clip-b" data-start="6.006" data-duration="3.003" data-media-start="0.6673333333333333"></video>',
    "z.html": '<video id="clip-a" data-start="1.001" data-duration="4.004" data-media-start="0.33366666666666667"></video>',
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
    if (options?.failWritePath === path && content !== expected) {
      throw new Error(`write failed: ${path}`);
    }
    files.set(path, content);
    if (options?.abortOnWritePath === path && content !== expected) {
      controller.abort(new Error("range edit cancelled"));
    }
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

describe("native timeline multi-file range transaction", () => {
  it("uses one durable file transaction for every snapshot before publication", async () => {
    const state = memory();
    let resolveCommit!: () => void;
    const commitFileTransaction = vi.fn(() => new Promise<void>((resolve) => { resolveCommit = resolve; }));
    const pending = commitNativeTimelineMultiRangeEdit({
      expectedRevision: 12,
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
        label: "Trim timeline clips",
        kind: "timeline",
        coalesceKey: "timeline-resize-many:clip:a,clip:b",
      },
    });
    resolveCommit();
    await pending;
    expect(state.onCommitted).toHaveBeenCalledOnce();

    const rejectedState = memory();
    await expect(commitNativeTimelineMultiRangeEdit({
      expectedRevision: 12,
      changes,
      readOptionalProjectFile: rejectedState.readOptionalProjectFile,
      writeProjectFile: rejectedState.writeProjectFile,
      recordEdit: rejectedState.recordEdit,
      commitFileTransaction: vi.fn(async () => { throw new Error("durable group trim failed"); }),
      patchCompatibilityContent,
      onCommitted: rejectedState.onCommitted,
    })).rejects.toThrow("durable group trim failed");
    expect(rejectedState.onCommitted).not.toHaveBeenCalled();
  });

  it("commits exact multi-file range edits in one revision and one history entry", async () => {
    const state = memory();
    const result = await commitNativeTimelineMultiRangeEdit({
      expectedRevision: 12,
      changes,
      readOptionalProjectFile: state.readOptionalProjectFile,
      writeProjectFile: state.writeProjectFile,
      recordEdit: state.recordEdit,
      patchCompatibilityContent,
      onCommitted: state.onCommitted,
    });

    expect(result.committed).toBe(true);
    if (!result.committed) return;
    expect(result.document.revision).toBe(13);
    expect(result.document.sequence.tracks[0]!.clips).toMatchObject([
      { id: "clip:a", startFrame: 45, durationFrames: 105, sourceInFrame: 40 },
      { id: "clip:b", startFrame: 180, durationFrames: 60, sourceInFrame: 20 },
    ]);
    expect(result.compatibilityContents).toEqual({
      "a.html": expect.stringContaining(`data-duration="${secondsAtFrame(60)}"`),
      "z.html": expect.stringContaining(`data-media-start="${secondsAtFrame(40)}"`),
    });
    expect(state.events.filter((event) => event.startsWith("write:"))).toEqual([
      `write:${NATIVE_PROJECT_DOCUMENT_PATH}`,
      "write:a.html",
      "write:z.html",
    ]);
    expect(state.recordEdit).toHaveBeenCalledOnce();
    expect(state.recordEdit).toHaveBeenCalledWith({
      label: "Trim timeline clips",
      kind: "timeline",
      coalesceKey: "timeline-resize-many:clip:a,clip:b",
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

  it("does no durable work when one requested edit is invalid or one source is missing", async () => {
    const invalidState = memory();
    const invalid = await commitNativeTimelineMultiRangeEdit({
      expectedRevision: 12,
      changes: [changes[0], {
        ...changes[1],
        requestedStartSeconds: secondsAtFrame(190),
        requestedDurationSeconds: secondsAtFrame(50),
      }],
      readOptionalProjectFile: invalidState.readOptionalProjectFile,
      writeProjectFile: invalidState.writeProjectFile,
      recordEdit: invalidState.recordEdit,
      patchCompatibilityContent,
    });
    expect(invalid).toEqual({ committed: false, reason: "unsupported-range-change" });
    expect(invalidState.writeProjectFile).not.toHaveBeenCalled();
    expect(invalidState.recordEdit).not.toHaveBeenCalled();

    const missingState = memory({ missingPath: "z.html" });
    const missing = await commitNativeTimelineMultiRangeEdit({
      expectedRevision: 12,
      changes,
      readOptionalProjectFile: missingState.readOptionalProjectFile,
      writeProjectFile: missingState.writeProjectFile,
      recordEdit: missingState.recordEdit,
      patchCompatibilityContent,
    });
    expect(missing).toEqual({
      committed: false,
      reason: "missing-compatibility-file",
      sourceFile: "z.html",
    });
    expect(missingState.writeProjectFile).not.toHaveBeenCalled();
    expect(missingState.recordEdit).not.toHaveBeenCalled();
  });

  it("rejects an adapter that skips one target before writing any file", async () => {
    const state = memory();
    await expect(commitNativeTimelineMultiRangeEdit({
      expectedRevision: 12,
      changes,
      readOptionalProjectFile: state.readOptionalProjectFile,
      writeProjectFile: state.writeProjectFile,
      recordEdit: state.recordEdit,
      patchCompatibilityContent: (content, edit, sourceFile) =>
        edit.address.clipId === "clip:a"
          ? content
          : patchCompatibilityContent(content, edit, sourceFile),
    })).rejects.toBeInstanceOf(NativeTimelineMultiRangeCompatibilityError);
    expect(state.writeProjectFile).not.toHaveBeenCalled();
    expect(state.recordEdit).not.toHaveBeenCalled();
  });

  it("rolls successful writes back in reverse order on write and history failures", async () => {
    const writeFailure = memory({ failWritePath: "z.html" });
    await expect(commitNativeTimelineMultiRangeEdit({
      expectedRevision: 12,
      changes,
      readOptionalProjectFile: writeFailure.readOptionalProjectFile,
      writeProjectFile: writeFailure.writeProjectFile,
      recordEdit: writeFailure.recordEdit,
      patchCompatibilityContent,
      onCommitted: writeFailure.onCommitted,
    })).rejects.toThrow("write failed: z.html");
    expect(writeFailure.files.get(NATIVE_PROJECT_DOCUMENT_PATH)).toBe(writeFailure.nativeBefore);
    expect(writeFailure.files.get("a.html")).toBe(writeFailure.compatibilityBefore["a.html"]);
    expect(writeFailure.files.get("z.html")).toBe(writeFailure.compatibilityBefore["z.html"]);
    expect(writeFailure.events.filter((event) => event.startsWith("write:")).slice(-2)).toEqual([
      "write:a.html",
      `write:${NATIVE_PROJECT_DOCUMENT_PATH}`,
    ]);
    expect(writeFailure.onCommitted).not.toHaveBeenCalled();

    const historyFailure = memory({ failHistory: true });
    await expect(commitNativeTimelineMultiRangeEdit({
      expectedRevision: 12,
      changes,
      readOptionalProjectFile: historyFailure.readOptionalProjectFile,
      writeProjectFile: historyFailure.writeProjectFile,
      recordEdit: historyFailure.recordEdit,
      patchCompatibilityContent,
      onCommitted: historyFailure.onCommitted,
    })).rejects.toThrow("history failed");
    expect(historyFailure.files.get(NATIVE_PROJECT_DOCUMENT_PATH)).toBe(historyFailure.nativeBefore);
    expect(historyFailure.files.get("a.html")).toBe(historyFailure.compatibilityBefore["a.html"]);
    expect(historyFailure.files.get("z.html")).toBe(historyFailure.compatibilityBefore["z.html"]);
    expect(historyFailure.events.filter((event) => event.startsWith("write:")).slice(-3)).toEqual([
      "write:z.html",
      "write:a.html",
      `write:${NATIVE_PROJECT_DOCUMENT_PATH}`,
    ]);
    expect(historyFailure.onCommitted).not.toHaveBeenCalled();
  });

  it("performs no write on a stale revision and rolls back cancellation between writes", async () => {
    const stale = memory({ revision: 13 });
    await expect(commitNativeTimelineMultiRangeEdit({
      expectedRevision: 12,
      changes,
      readOptionalProjectFile: stale.readOptionalProjectFile,
      writeProjectFile: stale.writeProjectFile,
      recordEdit: stale.recordEdit,
      patchCompatibilityContent,
    })).rejects.toBeInstanceOf(NativeProjectRevisionConflictError);
    expect(stale.writeProjectFile).not.toHaveBeenCalled();
    expect(stale.recordEdit).not.toHaveBeenCalled();

    const cancelled = memory({ abortOnWritePath: "a.html" });
    await expect(commitNativeTimelineMultiRangeEdit({
      expectedRevision: 12,
      changes,
      readOptionalProjectFile: cancelled.readOptionalProjectFile,
      writeProjectFile: cancelled.writeProjectFile,
      recordEdit: cancelled.recordEdit,
      patchCompatibilityContent,
      onCommitted: cancelled.onCommitted,
      signal: cancelled.controller.signal,
    })).rejects.toThrow("range edit cancelled");
    expect(cancelled.files.get(NATIVE_PROJECT_DOCUMENT_PATH)).toBe(cancelled.nativeBefore);
    expect(cancelled.files.get("a.html")).toBe(cancelled.compatibilityBefore["a.html"]);
    expect(cancelled.recordEdit).not.toHaveBeenCalled();
    expect(cancelled.onCommitted).not.toHaveBeenCalled();
  });
});
