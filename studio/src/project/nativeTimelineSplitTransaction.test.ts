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
  NativeTimelineSplitCompatibilityError,
  commitNativeTimelineSplits,
  type NativeTimelineSplitCompatibilityEdit,
} from "./nativeTimelineSplitTransaction";

const frameRate = { numerator: 30_000, denominator: 1_001 } as const;

function project(revision = 8): NativeProjectDocument {
  return parseNativeProjectDocument({
    schemaVersion: NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
    id: "project:split-transaction",
    revision,
    frameRate,
    canvas: { width: 1920, height: 1080, background: "#000" },
    assets: [
      { id: "asset:a", kind: "video", name: "a.mov", durationFrames: 900 },
      { id: "asset:b", kind: "video", name: "b.mov", durationFrames: 900 },
    ],
    sequence: { id: "sequence:main", name: "Main", tracks: [{
      id: "track:video", kind: "video", lane: { authoredTrack: 0, displayTrack: 0 }, clips: [{
        id: "native:a", assetId: "asset:a",
        binding: { sourceFile: "z.html", domId: "clip" },
        startFrame: 30, durationFrames: 120, sourceInFrame: 10,
        playbackRate: { numerator: 2, denominator: 1 }, muted: false,
        staticParameters: { opacity: 0.8 }, effects: [], parameterTracks: [],
      }, {
        id: "native:b", assetId: "asset:b",
        binding: { sourceFile: "a.html", domId: "other" },
        startFrame: 180, durationFrames: 120, sourceInFrame: 0,
        muted: true, staticParameters: {}, effects: [], parameterTracks: [],
      }],
    }] },
  });
}

const splits = [{
  element: { id: "clip", sourceFile: "z.html" },
  requestedSplitSeconds: (60 * frameRate.denominator) / frameRate.numerator,
}, {
  element: { id: "other", sourceFile: "a.html" },
  requestedSplitSeconds: (210 * frameRate.denominator) / frameRate.numerator,
}] as const;

function patchCompatibilityContent(
  content: string,
  edit: NativeTimelineSplitCompatibilityEdit,
): { content: string; rightBinding: NativeClipDomBinding } {
  const base = `${edit.leftBinding.domId}-split`;
  let actual = base;
  let suffix = 2;
  while (content.includes(`id="${actual}"`)) actual = `${base}-${suffix++}`;
  const marker = `<div id="${edit.leftBinding.domId}"`;
  return {
    content: content.replace(marker, `<div id="${actual}" data-start="${edit.compatibilitySplitTime}"></div>${marker}`),
    rightBinding: { sourceFile: edit.sourceFile, domId: actual },
  };
}

function memory(options?: {
  revision?: number;
  missingPath?: string;
  failWritePath?: string;
  failHistory?: boolean;
  abortOnWritePath?: string;
}) {
  const nativeBefore = serializeNativeProjectDocument(project(options?.revision));
  const compatibilityBefore = {
    "a.html": '<div id="other" data-start="6.006"></div>',
    "z.html": '<div id="clip-split"></div><div id="clip" data-start="1.001"></div>',
  };
  const files = new Map<string, string>([[NATIVE_PROJECT_DOCUMENT_PATH, nativeBefore], ...Object.entries(compatibilityBefore)]);
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
    if (options?.failWritePath === path && content !== expected) throw new Error(`write failed: ${path}`);
    files.set(path, content);
    if (options?.abortOnWritePath === path && content !== expected) controller.abort(new Error("cancel split"));
  });
  const recordEdit = vi.fn(async () => {
    events.push("history");
    if (options?.failHistory) throw new Error("history failed");
  });
  const onCommitted = vi.fn(() => events.push("published"));
  return { nativeBefore, compatibilityBefore, files, events, controller, readOptionalProjectFile, writeProjectFile, recordEdit, onCommitted };
}

describe("native timeline split transaction", () => {
  it("uses one durable file transaction for every snapshot before publication", async () => {
    const state = memory();
    let resolveCommit!: () => void;
    const commitFileTransaction = vi.fn(() => new Promise<void>((resolve) => { resolveCommit = resolve; }));
    const pending = commitNativeTimelineSplits({
      expectedRevision: 8,
      splits,
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
        label: "Split timeline clips",
        kind: "timeline",
        coalesceKey: "timeline-split:native:a,native:b",
      },
    });
    resolveCommit();
    await pending;
    expect(state.onCommitted).toHaveBeenCalledOnce();

    const rejectedState = memory();
    await expect(commitNativeTimelineSplits({
      expectedRevision: 8,
      splits,
      readOptionalProjectFile: rejectedState.readOptionalProjectFile,
      writeProjectFile: rejectedState.writeProjectFile,
      recordEdit: rejectedState.recordEdit,
      commitFileTransaction: vi.fn(async () => { throw new Error("durable split failed"); }),
      patchCompatibilityContent,
      onCommitted: rejectedState.onCommitted,
    })).rejects.toThrow("durable split failed");
    expect(rejectedState.onCommitted).not.toHaveBeenCalled();
  });

  it("commits a multi-file batch in deterministic order with actual collision-safe identities", async () => {
    const state = memory();
    const result = await commitNativeTimelineSplits({
      expectedRevision: 8,
      splits,
      readOptionalProjectFile: state.readOptionalProjectFile,
      writeProjectFile: state.writeProjectFile,
      recordEdit: state.recordEdit,
      patchCompatibilityContent,
      onCommitted: state.onCommitted,
    });

    expect(result.committed).toBe(true);
    if (!result.committed) return;
    expect(result.document.revision).toBe(9);
    const nativeA = result.document.sequence.tracks[0]!.clips.find((clip) => clip.startFrame === 60)!;
    expect(nativeA.binding).toEqual({ sourceFile: "z.html", domId: "clip-split-2" });
    expect(nativeA.sourceInFrame).toBe(70);
    expect(result.compatibilityContents["z.html"]).toContain('id="clip-split-2" data-start="2.002"');
    expect(state.events.filter((event) => event.startsWith("write:"))).toEqual([
      `write:${NATIVE_PROJECT_DOCUMENT_PATH}`,
      "write:a.html",
      "write:z.html",
    ]);
    expect(state.recordEdit).toHaveBeenCalledOnce();
    expect(state.recordEdit).toHaveBeenCalledWith(expect.objectContaining({
      label: "Split timeline clips",
      kind: "timeline",
      coalesceKey: "timeline-split:native:a,native:b",
      files: expect.objectContaining({
        [NATIVE_PROJECT_DOCUMENT_PATH]: { before: state.nativeBefore, after: state.files.get(NATIVE_PROJECT_DOCUMENT_PATH) },
        "a.html": { before: state.compatibilityBefore["a.html"], after: state.files.get("a.html") },
        "z.html": { before: state.compatibilityBefore["z.html"], after: state.files.get("z.html") },
      }),
    }));
    expect(state.events.at(-1)).toBe("published");
  });

  it.each([
    ["later source write", { failWritePath: "z.html" }, "write failed: z.html"],
    ["history registration", { failHistory: true }, "history failed"],
    ["cancellation", { abortOnWritePath: "a.html" }, "cancel split"],
  ])("rolls every durable file back in reverse order after %s fails", async (_label, options, message) => {
    const state = memory(options);
    await expect(commitNativeTimelineSplits({
      expectedRevision: 8, splits,
      readOptionalProjectFile: state.readOptionalProjectFile,
      writeProjectFile: state.writeProjectFile,
      recordEdit: state.recordEdit,
      patchCompatibilityContent,
      onCommitted: state.onCommitted,
      signal: state.controller.signal,
    })).rejects.toThrow(message);
    expect(state.files.get(NATIVE_PROJECT_DOCUMENT_PATH)).toBe(state.nativeBefore);
    expect(state.files.get("a.html")).toBe(state.compatibilityBefore["a.html"]);
    expect(state.files.get("z.html")).toBe(state.compatibilityBefore["z.html"]);
    expect(state.onCommitted).not.toHaveBeenCalled();
  });

  it("does no writes for a missing source, revision conflict, invalid split, or mixed unbound batch", async () => {
    for (const scenario of ["missing", "revision", "invalid", "unbound"] as const) {
      const state = memory({
        ...(scenario === "missing" ? { missingPath: "z.html" } : {}),
        ...(scenario === "revision" ? { revision: 9 } : {}),
      });
      const requested = scenario === "invalid"
        ? [{ ...splits[0], requestedSplitSeconds: (30 * frameRate.denominator) / frameRate.numerator }]
        : scenario === "unbound"
          ? [...splits, { element: { id: "missing" }, requestedSplitSeconds: 2 }]
          : splits;
      let thrown: unknown;
      let result: Awaited<ReturnType<typeof commitNativeTimelineSplits>> | undefined;
      try {
        result = await commitNativeTimelineSplits({
          expectedRevision: 8, splits: requested,
          readOptionalProjectFile: state.readOptionalProjectFile,
          writeProjectFile: state.writeProjectFile,
          recordEdit: state.recordEdit,
          patchCompatibilityContent,
          onCommitted: state.onCommitted,
        });
      } catch (error) { thrown = error; }
      if (scenario === "revision") expect(thrown).toBeInstanceOf(NativeProjectRevisionConflictError);
      else expect(result).toMatchObject({ committed: false });
      expect(state.writeProjectFile).not.toHaveBeenCalled();
      expect(state.recordEdit).not.toHaveBeenCalled();
      expect(state.onCommitted).not.toHaveBeenCalled();
    }
  });

  it("rejects an adapter that changes content without returning a usable right binding", async () => {
    const state = memory();
    await expect(commitNativeTimelineSplits({
      expectedRevision: 8,
      splits: [splits[0]],
      readOptionalProjectFile: state.readOptionalProjectFile,
      writeProjectFile: state.writeProjectFile,
      recordEdit: state.recordEdit,
      patchCompatibilityContent: (content) => ({ content: `${content} changed`, rightBinding: { sourceFile: "z.html" } }),
    })).rejects.toBeInstanceOf(NativeTimelineSplitCompatibilityError);
    expect(state.writeProjectFile).not.toHaveBeenCalled();
  });
});
