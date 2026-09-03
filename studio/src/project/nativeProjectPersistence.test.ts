import { describe, expect, it, vi } from "vitest";

import {
  NativeProjectRevisionConflictError,
  createNativeProjectRepository,
  type NativeProjectPersistenceDependencies,
} from "./nativeProjectPersistence";
import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
  serializeNativeProjectDocument,
  type NativeProjectDocument,
} from "./nativeProjectDocument";
import { serializeStudioFileMutation } from "../utils/studioFileMutationCoordinator";

const project = (revision = 0): NativeProjectDocument => ({
  schemaVersion: NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
  id: "project:demo",
  revision,
  frameRate: { numerator: 30_000, denominator: 1_001 },
  canvas: { width: 1920, height: 1080, background: "#101010" },
  assets: [{ id: "asset:a", kind: "video", name: "a.mov", durationFrames: 300 }],
  sequence: {
    id: "sequence:main",
    name: "Main",
    tracks: [{
      id: "track:v1",
      kind: "video",
      lane: { authoredTrack: 0, displayTrack: 0 },
      clips: [],
    }],
  },
});

const memoryDependencies = (initial: string | null) => {
  let content = initial;
  const events: string[] = [];
  const dependencies: NativeProjectPersistenceDependencies = {
    readOptionalProjectFile: vi.fn(async (path) => {
      events.push(`read:${path}`);
      return content;
    }),
    writeProjectFile: vi.fn(async (path, next, expected) => {
      events.push("write");
      if (content !== (expected ?? null)) throw new Error("optimistic write conflict");
      content = next;
    }),
    recordHistory: vi.fn(async () => {
      events.push("history");
    }),
  };
  return { dependencies, events, getContent: () => content };
};

describe("native project persistence", () => {
  it.each([null, undefined, "", " \n\t "])(
    "loads truly absent or empty optional project content as null: %j",
    async (content) => {
      const repository = createNativeProjectRepository({
        readOptionalProjectFile: async () => content,
        writeProjectFile: async () => undefined,
      });

      await expect(repository.load()).resolves.toBeNull();
    },
  );

  it("loads a valid document with its exact prior bytes", async () => {
    const content = serializeNativeProjectDocument(project());
    const repository = createNativeProjectRepository({
      readOptionalProjectFile: async () => content,
      writeProjectFile: async () => undefined,
    });

    await expect(repository.load()).resolves.toEqual({ document: project(), content });
  });

  it.each(["{", JSON.stringify({ schemaVersion: 1 })])(
    "surfaces malformed project content instead of treating it as missing",
    async (content) => {
      const repository = createNativeProjectRepository({
        readOptionalProjectFile: async () => content,
        writeProjectFile: async () => undefined,
      });

      await expect(repository.load()).rejects.toThrow();
    },
  );

  it("saves deterministically, increments revision once, uses prior bytes for CAS, then records one history entry", async () => {
    const before = serializeNativeProjectDocument(project(4));
    const memory = memoryDependencies(before);
    const repository = createNativeProjectRepository(memory.dependencies);
    const edited = { ...project(4), canvas: { ...project(4).canvas, background: "#222222" } };

    const committed = await repository.save(edited, {
      expectedRevision: 4,
      label: "Change canvas background",
    });

    expect(committed.document.revision).toBe(5);
    expect(committed.content).toBe(serializeNativeProjectDocument(committed.document));
    expect(memory.dependencies.writeProjectFile).toHaveBeenCalledWith(
      NATIVE_PROJECT_DOCUMENT_PATH,
      committed.content,
      before,
    );
    expect(memory.dependencies.recordHistory).toHaveBeenCalledTimes(1);
    expect(memory.dependencies.recordHistory).toHaveBeenCalledWith({
      path: NATIVE_PROJECT_DOCUMENT_PATH,
      before,
      after: committed.content,
      label: "Change canvas background",
      kind: "save",
    });
    expect(memory.events.slice(-2)).toEqual(["write", "history"]);
  });

  it("uses one durable file transaction for native keyframe/project edits when available", async () => {
    const before = serializeNativeProjectDocument(project(4));
    const memory = memoryDependencies(before);
    const commitFileTransaction = vi.fn(async () => undefined);
    const repository = createNativeProjectRepository({
      ...memory.dependencies,
      commitFileTransaction,
    });

    const committed = await repository.transaction(
      { expectedRevision: 4, label: "Set rotation keyframe" },
      (draft) => ({
        ...draft,
        canvas: { ...draft.canvas, background: "#222222" },
      }),
    );

    expect(commitFileTransaction).toHaveBeenCalledWith({
      files: [
        {
          path: NATIVE_PROJECT_DOCUMENT_PATH,
          expectedBefore: before,
          after: committed.content,
        },
      ],
      history: { label: "Set rotation keyframe", kind: "motion" },
    });
    expect(memory.dependencies.writeProjectFile).not.toHaveBeenCalled();
    expect(memory.dependencies.recordHistory).not.toHaveBeenCalled();
  });

  it("durably creates the first native sidecar with a null CAS baseline", async () => {
    const memory = memoryDependencies(null);
    const commitFileTransaction = vi.fn(async () => undefined);
    const repository = createNativeProjectRepository({
      ...memory.dependencies,
      commitFileTransaction,
    });

    const committed = await repository.save(project(), {
      expectedRevision: null,
      label: "Create native project",
    });

    expect(commitFileTransaction).toHaveBeenCalledWith({
      files: [
        {
          path: NATIVE_PROJECT_DOCUMENT_PATH,
          expectedBefore: null,
          after: committed.content,
        },
      ],
      history: { label: "Create native project", kind: "motion" },
    });
  });

  it("does not fall back to direct writes or history when durable commit rejects", async () => {
    const before = serializeNativeProjectDocument(project());
    const memory = memoryDependencies(before);
    const failure = new Error("durable commit rejected");
    const repository = createNativeProjectRepository({
      ...memory.dependencies,
      commitFileTransaction: vi.fn(async () => {
        throw failure;
      }),
    });

    await expect(
      repository.transaction({ expectedRevision: 0 }, (draft) => draft),
    ).rejects.toBe(failure);
    expect(memory.dependencies.writeProjectFile).not.toHaveBeenCalled();
    expect(memory.dependencies.recordHistory).not.toHaveBeenCalled();
  });

  it("creates a missing project only when expectedRevision is null and starts at revision zero", async () => {
    const memory = memoryDependencies(null);
    const repository = createNativeProjectRepository(memory.dependencies);

    const committed = await repository.save(project(91), { expectedRevision: null });

    expect(committed.document.revision).toBe(0);
    expect(memory.dependencies.writeProjectFile).toHaveBeenCalledWith(
      NATIVE_PROJECT_DOCUMENT_PATH,
      committed.content,
      undefined,
    );
  });

  it("rejects a stale expected revision before writing or recording history", async () => {
    const memory = memoryDependencies(serializeNativeProjectDocument(project(3)));
    const repository = createNativeProjectRepository(memory.dependencies);

    await expect(repository.save(project(3), { expectedRevision: 2 })).rejects.toBeInstanceOf(
      NativeProjectRevisionConflictError,
    );
    expect(memory.dependencies.writeProjectFile).not.toHaveBeenCalled();
    expect(memory.dependencies.recordHistory).not.toHaveBeenCalled();
  });

  it("validates the candidate before write and does not record history on failure", async () => {
    const memory = memoryDependencies(serializeNativeProjectDocument(project()));
    const repository = createNativeProjectRepository(memory.dependencies);
    const invalid = { ...project(), canvas: { ...project().canvas, width: 0 } };

    await expect(repository.save(invalid, { expectedRevision: 0 })).rejects.toThrow(/canvas.width/i);
    expect(memory.dependencies.writeProjectFile).not.toHaveBeenCalled();
    expect(memory.dependencies.recordHistory).not.toHaveBeenCalled();
  });

  it("does not record history or resolve a committed model when the optimistic write fails", async () => {
    const before = serializeNativeProjectDocument(project());
    const recordHistory = vi.fn();
    const repository = createNativeProjectRepository({
      readOptionalProjectFile: async () => before,
      writeProjectFile: async () => {
        throw new Error("disk changed");
      },
      recordHistory,
    });

    await expect(repository.save(project(), { expectedRevision: 0 })).rejects.toThrow("disk changed");
    expect(recordHistory).not.toHaveBeenCalled();
  });

  it("restores the exact prior bytes when history registration fails after the write", async () => {
    const before = serializeNativeProjectDocument(project());
    let content = before;
    const writeProjectFile = vi.fn(async (_path: string, next: string, expected?: string) => {
      if (content !== expected) throw new Error("optimistic write conflict");
      content = next;
    });
    const repository = createNativeProjectRepository({
      readOptionalProjectFile: async () => content,
      writeProjectFile,
      recordHistory: async () => {
        throw new Error("history unavailable");
      },
    });

    await expect(
      repository.transaction({ expectedRevision: 0 }, (draft) => ({
        ...draft,
        canvas: { ...draft.canvas, background: "#abcdef" },
      })),
    ).rejects.toThrow("history unavailable");

    expect(content).toBe(before);
    expect(writeProjectFile).toHaveBeenCalledTimes(2);
    expect(writeProjectFile.mock.calls[1]).toEqual([
      NATIVE_PROJECT_DOCUMENT_PATH,
      before,
      writeProjectFile.mock.calls[0]![1],
    ]);
  });

  it("shares the Studio file lock with non-repository mutations of the same writer and path", async () => {
    let content = serializeNativeProjectDocument(project());
    let releaseExternal!: () => void;
    const externalHeld = new Promise<void>((resolve) => {
      releaseExternal = resolve;
    });
    const writeProjectFile = vi.fn(async (_path: string, next: string, expected?: string) => {
      if (content !== expected) throw new Error("optimistic write conflict");
      content = next;
    });
    const readOptionalProjectFile = vi.fn(async () => content);
    const repository = createNativeProjectRepository({
      readOptionalProjectFile,
      writeProjectFile,
    });

    const external = serializeStudioFileMutation(
      writeProjectFile,
      NATIVE_PROJECT_DOCUMENT_PATH,
      async () => {
        await externalHeld;
      },
    );
    const nativeCommit = repository.transaction({ expectedRevision: 0 }, (draft) => ({
      ...draft,
      canvas: { ...draft.canvas, background: "#123456" },
    }));

    await Promise.resolve();
    expect(readOptionalProjectFile).not.toHaveBeenCalled();
    releaseExternal();
    await external;
    await expect(nativeCommit).resolves.toMatchObject({ document: { revision: 1 } });
    expect(readOptionalProjectFile).toHaveBeenCalledTimes(1);
  });

  it("rolls back a failed transaction without write, history, or partial document exposure", async () => {
    const memory = memoryDependencies(serializeNativeProjectDocument(project()));
    const repository = createNativeProjectRepository(memory.dependencies);

    await expect(
      repository.transaction(
        { expectedRevision: 0, label: "Broken edit" },
        (draft) => {
          draft.canvas.background = "#ff0000";
          throw new Error("edit failed");
        },
      ),
    ).rejects.toThrow("edit failed");
    expect(memory.dependencies.writeProjectFile).not.toHaveBeenCalled();
    expect(memory.dependencies.recordHistory).not.toHaveBeenCalled();
    expect(memory.getContent()).toBe(serializeNativeProjectDocument(project()));
  });

  it("commits a transaction with one revision increment and one transaction history entry", async () => {
    const before = serializeNativeProjectDocument(project(8));
    const memory = memoryDependencies(before);
    const repository = createNativeProjectRepository(memory.dependencies);

    const committed = await repository.transaction(
      { expectedRevision: 8, label: "Rename sequence" },
      (draft) => ({
        ...draft,
        sequence: { ...draft.sequence, name: "Edited sequence" },
        revision: 999,
      }),
    );

    expect(committed.document.revision).toBe(9);
    expect(committed.document.sequence.name).toBe("Edited sequence");
    expect(memory.dependencies.recordHistory).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "transaction", before, after: committed.content }),
    );
  });

  it("honors AbortSignal before read, after read, and before write", async () => {
    const beforeRead = new AbortController();
    beforeRead.abort();
    const readBefore = vi.fn(async () => serializeNativeProjectDocument(project()));
    const writeBefore = vi.fn(async () => undefined);
    const beforeRepository = createNativeProjectRepository({
      readOptionalProjectFile: readBefore,
      writeProjectFile: writeBefore,
    });
    await expect(beforeRepository.load({ signal: beforeRead.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(readBefore).not.toHaveBeenCalled();

    const afterRead = new AbortController();
    const writeAfter = vi.fn(async () => undefined);
    const afterRepository = createNativeProjectRepository({
      readOptionalProjectFile: async () => {
        afterRead.abort();
        return serializeNativeProjectDocument(project());
      },
      writeProjectFile: writeAfter,
    });
    await expect(
      afterRepository.save(project(), { expectedRevision: 0, signal: afterRead.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(writeAfter).not.toHaveBeenCalled();

    const beforeWrite = new AbortController();
    const history = vi.fn();
    const writeLast = vi.fn(async () => undefined);
    const lastRepository = createNativeProjectRepository({
      readOptionalProjectFile: async () => serializeNativeProjectDocument(project()),
      writeProjectFile: writeLast,
      recordHistory: history,
    });
    await expect(
      lastRepository.transaction(
        { expectedRevision: 0, signal: beforeWrite.signal },
        (draft) => {
          beforeWrite.abort();
          return draft;
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(writeLast).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
  });

  it("serializes overlapping operations by repository path so stale edits cannot overwrite", async () => {
    let content = serializeNativeProjectDocument(project());
    let releaseFirstWrite!: () => void;
    const firstWriteHeld = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let writes = 0;
    const dependencies: NativeProjectPersistenceDependencies = {
      readOptionalProjectFile: vi.fn(async () => content),
      writeProjectFile: vi.fn(async (_path, next, expected) => {
        writes += 1;
        if (writes === 1) await firstWriteHeld;
        if (content !== expected) throw new Error("optimistic write conflict");
        content = next;
      }),
    };
    const repository = createNativeProjectRepository(dependencies);
    const first = repository.transaction({ expectedRevision: 0 }, (draft) => ({
      ...draft,
      canvas: { ...draft.canvas, background: "#111111" },
    }));
    const second = repository.transaction({ expectedRevision: 0 }, (draft) => ({
      ...draft,
      canvas: { ...draft.canvas, background: "#222222" },
    }));

    await Promise.resolve();
    expect(dependencies.readOptionalProjectFile).toHaveBeenCalledTimes(1);
    releaseFirstWrite();
    await expect(first).resolves.toMatchObject({ document: { revision: 1 } });
    await expect(second).rejects.toBeInstanceOf(NativeProjectRevisionConflictError);
    expect(dependencies.writeProjectFile).toHaveBeenCalledTimes(1);
    expect(JSON.parse(content).canvas.background).toBe("#111111");
  });
});
