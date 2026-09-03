import { describe, expect, it, vi } from "vitest";

import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
  parseNativeProjectDocument,
  serializeNativeProjectDocument,
} from "./nativeProjectDocument";
import { NativeProjectRevisionConflictError } from "./nativeProjectPersistence";
import {
  NativeTimelineAssetInsertCompatibilityError,
  commitNativeTimelineAssetInsertions,
  type NativeTimelineAssetCompatibilityInsertion,
  type NativeTimelineAssetInsertRequest,
} from "./nativeTimelineAssetInsertTransaction";

const frameRate = { numerator: 30, denominator: 1 } as const;
const nativeBefore = serializeNativeProjectDocument(parseNativeProjectDocument({
  schemaVersion: NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
  id: "project:transaction",
  revision: 3,
  frameRate,
  canvas: { width: 1920, height: 1080, background: "#000" },
  assets: [],
  sequence: { id: "sequence:main", name: "Main", tracks: [] },
}));

const requests: readonly NativeTimelineAssetInsertRequest[] = [{
  assetPath: "media/a.mov",
  kind: "video",
  sourceFile: "z.html",
  requestedStartSeconds: 1,
  requestedDurationSeconds: 2,
  sourceDurationSeconds: 10,
  requestedTrack: 0,
}, {
  assetPath: "media/voice.wav",
  kind: "audio",
  sourceFile: "a.html",
  requestedStartSeconds: 4,
  requestedDurationSeconds: 3,
  sourceDurationSeconds: 8,
  requestedTrack: 2,
}];

function patchCompatibilityContent(
  content: string,
  edit: NativeTimelineAssetCompatibilityInsertion,
) {
  const base = edit.assetPath.split("/").at(-1)!.split(".")[0]!;
  let id = base;
  let suffix = 2;
  while (content.includes(`id="${id}"`)) id = `${base}-${suffix++}`;
  return {
    content: `${content}<${edit.kind === "image" ? "img" : edit.kind} id="${id}" data-start="${edit.compatibilityStartSeconds}" data-duration="${edit.compatibilityDurationSeconds}"></${edit.kind}>`,
    binding: { sourceFile: edit.sourceFile, domId: id, hfId: `hf-${id}` },
  };
}

function memory(options?: {
  revision?: number;
  missingPath?: string;
  failWritePath?: string;
  failHistory?: boolean;
  abortOnWritePath?: string;
}) {
  const currentNative = options?.revision === undefined
    ? nativeBefore
    : serializeNativeProjectDocument({
        ...parseNativeProjectDocument(JSON.parse(nativeBefore)),
        revision: options.revision,
      });
  const compatibilityBefore = {
    "a.html": '<main id="root"></main>',
    "z.html": '<main id="root"><video id="a"></video></main>',
  };
  const files = new Map<string, string>([
    [NATIVE_PROJECT_DOCUMENT_PATH, currentNative],
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
    if (options?.failWritePath === path && content !== expected) throw new Error(`write failed: ${path}`);
    files.set(path, content);
    if (options?.abortOnWritePath === path && content !== expected) {
      controller.abort(new Error("cancel insertion"));
    }
  });
  const recordEdit = vi.fn(async () => {
    events.push("history");
    if (options?.failHistory) throw new Error("history failed");
  });
  const onCommitted = vi.fn(() => events.push("published"));
  return {
    files, events, controller, compatibilityBefore, currentNative,
    readOptionalProjectFile, writeProjectFile, recordEdit, onCommitted,
  };
}

describe("native timeline asset insertion transaction", () => {
  it("patches all compatibility content in memory, commits one revision/history, then publishes", async () => {
    const state = memory();
    const result = await commitNativeTimelineAssetInsertions({
      expectedRevision: 3,
      insertions: requests,
      readOptionalProjectFile: state.readOptionalProjectFile,
      writeProjectFile: state.writeProjectFile,
      recordEdit: state.recordEdit,
      patchCompatibilityContent,
      onCommitted: state.onCommitted,
    });

    expect(result.committed).toBe(true);
    if (!result.committed) return;
    expect(result.document.revision).toBe(4);
    expect(result.document.sequence.tracks.flatMap((track) => track.clips).map((clip) => clip.binding))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ sourceFile: "z.html", domId: "a-2" }),
        expect.objectContaining({ sourceFile: "a.html", domId: "voice" }),
      ]));
    expect(state.events.filter((event) => event.startsWith("write:"))).toEqual([
      `write:${NATIVE_PROJECT_DOCUMENT_PATH}`,
      "write:a.html",
      "write:z.html",
    ]);
    expect(state.recordEdit).toHaveBeenCalledOnce();
    expect(state.recordEdit).toHaveBeenCalledWith(expect.objectContaining({
      label: "Add timeline assets",
      kind: "timeline",
      files: expect.objectContaining({
        [NATIVE_PROJECT_DOCUMENT_PATH]: { before: state.currentNative, after: state.files.get(NATIVE_PROJECT_DOCUMENT_PATH) },
        "a.html": { before: state.compatibilityBefore["a.html"], after: state.files.get("a.html") },
        "z.html": { before: state.compatibilityBefore["z.html"], after: state.files.get("z.html") },
      }),
    }));
    expect(state.events.at(-1)).toBe("published");
  });

  it("uses one optional durable commit and never calls browser writers/history", async () => {
    const state = memory();
    let resolveCommit!: () => void;
    const commitFileTransaction = vi.fn(() => new Promise<void>((resolve) => { resolveCommit = resolve; }));
    const pending = commitNativeTimelineAssetInsertions({
      expectedRevision: 3,
      insertions: requests,
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
        expect.objectContaining({ path: NATIVE_PROJECT_DOCUMENT_PATH, expectedBefore: state.currentNative }),
        expect.objectContaining({ path: "a.html", expectedBefore: state.compatibilityBefore["a.html"] }),
        expect.objectContaining({ path: "z.html", expectedBefore: state.compatibilityBefore["z.html"] }),
      ],
      history: { label: "Add timeline assets", kind: "timeline" },
    });
    resolveCommit();
    await pending;
    expect(state.onCommitted).toHaveBeenCalledOnce();
  });

  it.each([
    ["later file write", { failWritePath: "z.html" }, "write failed: z.html"],
    ["history", { failHistory: true }, "history failed"],
    ["abort", { abortOnWritePath: "a.html" }, "cancel insertion"],
  ])("rolls back all files when %s fails", async (_label, options, message) => {
    const state = memory(options);
    await expect(commitNativeTimelineAssetInsertions({
      expectedRevision: 3,
      insertions: requests,
      readOptionalProjectFile: state.readOptionalProjectFile,
      writeProjectFile: state.writeProjectFile,
      recordEdit: state.recordEdit,
      patchCompatibilityContent,
      onCommitted: state.onCommitted,
      signal: state.controller.signal,
    })).rejects.toThrow(message);
    expect(state.files.get(NATIVE_PROJECT_DOCUMENT_PATH)).toBe(state.currentNative);
    expect(state.files.get("a.html")).toBe(state.compatibilityBefore["a.html"]);
    expect(state.files.get("z.html")).toBe(state.compatibilityBefore["z.html"]);
    expect(state.onCommitted).not.toHaveBeenCalled();
  });

  it("does no writes for missing native/source files, revision conflict, or planner rejection", async () => {
    for (const scenario of ["native", "source", "revision", "invalid"] as const) {
      const state = memory({
        ...(scenario === "native" ? { missingPath: NATIVE_PROJECT_DOCUMENT_PATH } : {}),
        ...(scenario === "source" ? { missingPath: "z.html" } : {}),
        ...(scenario === "revision" ? { revision: 4 } : {}),
      });
      let thrown: unknown;
      let result: Awaited<ReturnType<typeof commitNativeTimelineAssetInsertions>> | undefined;
      try {
        result = await commitNativeTimelineAssetInsertions({
          expectedRevision: 3,
          insertions: scenario === "invalid"
            ? [{ ...requests[0]!, requestedDurationSeconds: -1 }]
            : requests,
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

  it("does not write when an adapter returns unchanged content or an invalid actual binding", async () => {
    for (const invalid of ["unchanged", "binding"] as const) {
      const state = memory();
      await expect(commitNativeTimelineAssetInsertions({
        expectedRevision: 3,
        insertions: [requests[0]!],
        readOptionalProjectFile: state.readOptionalProjectFile,
        writeProjectFile: state.writeProjectFile,
        recordEdit: state.recordEdit,
        patchCompatibilityContent: (content, edit) => invalid === "unchanged"
          ? { content, binding: { sourceFile: edit.sourceFile, domId: "a" } }
          : { content: `${content}changed`, binding: { sourceFile: edit.sourceFile } },
      })).rejects.toBeInstanceOf(NativeTimelineAssetInsertCompatibilityError);
      expect(state.writeProjectFile).not.toHaveBeenCalled();
      expect(state.recordEdit).not.toHaveBeenCalled();
    }
  });

  it("does not write when actual adapter bindings collide after every patch was prepared", async () => {
    const state = memory();
    const sameSourceRequests = [requests[0]!, {
      ...requests[0]!,
      assetPath: "media/b.mov",
      requestedStartSeconds: 6,
    }];
    const result = await commitNativeTimelineAssetInsertions({
      expectedRevision: 3,
      insertions: sameSourceRequests,
      readOptionalProjectFile: state.readOptionalProjectFile,
      writeProjectFile: state.writeProjectFile,
      recordEdit: state.recordEdit,
      patchCompatibilityContent: (content, edit) => ({
        content: `${content}<video data-asset="${edit.assetPath}"></video>`,
        binding: { sourceFile: edit.sourceFile, domId: "adapter-duplicate" },
      }),
      onCommitted: state.onCommitted,
    });

    expect(result).toEqual({ committed: false, reason: "binding-collision" });
    expect(state.writeProjectFile).not.toHaveBeenCalled();
    expect(state.recordEdit).not.toHaveBeenCalled();
    expect(state.onCommitted).not.toHaveBeenCalled();
    expect(state.files.get("z.html")).toBe(state.compatibilityBefore["z.html"]);
  });

  it("honors an already-aborted request before reading or patching anything", async () => {
    const state = memory();
    const controller = new AbortController();
    controller.abort(new Error("cancel before insertion"));
    const patch = vi.fn(patchCompatibilityContent);
    await expect(commitNativeTimelineAssetInsertions({
      expectedRevision: 3,
      insertions: requests,
      readOptionalProjectFile: state.readOptionalProjectFile,
      writeProjectFile: state.writeProjectFile,
      recordEdit: state.recordEdit,
      patchCompatibilityContent: patch,
      signal: controller.signal,
    })).rejects.toThrow("cancel before insertion");
    expect(state.readOptionalProjectFile).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
    expect(state.writeProjectFile).not.toHaveBeenCalled();
  });
});
