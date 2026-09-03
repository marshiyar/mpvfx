import { describe, expect, it, vi } from "vitest";

import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
  parseNativeProjectDocument,
  serializeNativeProjectDocument,
  type NativeProjectDocument,
} from "./nativeProjectDocument";
import { NativeProjectRevisionConflictError } from "./nativeProjectPersistence";
import { commitNativeTimelineMove } from "./nativeTimelineMoveTransaction";

const rate = { numerator: 30_000, denominator: 1_001 } as const;

function project(revision = 2): NativeProjectDocument {
  return parseNativeProjectDocument({
    schemaVersion: NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
    id: "project:tx",
    revision,
    frameRate: rate,
    canvas: { width: 1920, height: 1080, background: "#000000" },
    assets: [{ id: "asset:a", kind: "video", name: "a.mov", durationFrames: 900 }],
    sequence: {
      id: "sequence:main",
      name: "Main",
      tracks: [{
        id: "track:v1",
        kind: "video",
        lane: { authoredTrack: 7, displayTrack: 0 },
        clips: [{
          id: "clip:a",
          assetId: "asset:a",
          binding: { sourceFile: "index.html", domId: "clip", hfId: "hf-clip" },
          startFrame: 30,
          durationFrames: 120,
          sourceInFrame: 10,
          muted: false,
          staticParameters: { opacity: 0.8 },
          effects: [{ id: "fx:one", effectId: "blur", enabled: true }],
          parameterTracks: [],
        }],
      }, {
        id: "opaque-destination",
        kind: "video",
        lane: { authoredTrack: 19, displayTrack: 1 },
        clips: [],
      }],
    },
  });
}

const timelineElement = {
  id: "clip",
  domId: "clip",
  hfId: "hf-clip",
  sourceFile: "index.html",
  currentTrack: 0,
};

function memory(options?: { failHtmlWrite?: boolean; failHistory?: boolean; revision?: number }) {
  const originalProject = serializeNativeProjectDocument(project(options?.revision ?? 2));
  const originalHtml = '<div id="clip" data-hf-id="hf-clip" data-track-index="7" data-start="1.001"></div>';
  const files = new Map<string, string>([
    [NATIVE_PROJECT_DOCUMENT_PATH, originalProject],
    ["index.html", originalHtml],
  ]);
  const events: string[] = [];
  const readOptionalProjectFile = vi.fn(async (path: string) => files.get(path));
  const writeProjectFile = vi.fn(async (path: string, content: string, expected?: string) => {
    events.push(`write:${path}`);
    if (files.get(path) !== expected) throw new Error(`CAS conflict: ${path}`);
    if (options?.failHtmlWrite && path === "index.html" && !content.includes("1.001")) {
      throw new Error("html write failed");
    }
    files.set(path, content);
  });
  const recordEdit = vi.fn(async () => {
    events.push("history");
    if (options?.failHistory) throw new Error("history failed");
  });
  const onCommitted = vi.fn();
  return {
    originalProject,
    originalHtml,
    files,
    events,
    readOptionalProjectFile,
    writeProjectFile,
    recordEdit,
    onCommitted,
  };
}

const patchHtml = (
  content: string,
  start: number,
  lane: { readonly authoredTrack: number; readonly displayTrack: number },
): string =>
  content
    .replace(/data-track-index="[^"]*"/, `data-track-index="${lane.authoredTrack}"`)
    .replace(/data-start="[^"]*"/, `data-start="${start}"`);

describe("native timeline dual-file move transaction", () => {
  it("uses one durable file transaction and publishes only after it resolves", async () => {
    const state = memory();
    let resolveCommit!: () => void;
    const commitFileTransaction = vi.fn(() => new Promise<void>((resolve) => {
      resolveCommit = resolve;
    }));
    const pending = commitNativeTimelineMove({
      expectedRevision: 2,
      element: timelineElement,
      requestedStartSeconds: 3,
      requestedTrack: 0,
      readOptionalProjectFile: state.readOptionalProjectFile,
      writeProjectFile: state.writeProjectFile,
      recordEdit: state.recordEdit,
      commitFileTransaction,
      patchCompatibilityContent: patchHtml,
      onCommitted: state.onCommitted,
    });

    await vi.waitFor(() => expect(commitFileTransaction).toHaveBeenCalledOnce());
    expect(state.writeProjectFile).not.toHaveBeenCalled();
    expect(state.recordEdit).not.toHaveBeenCalled();
    expect(state.onCommitted).not.toHaveBeenCalled();
    expect(commitFileTransaction).toHaveBeenCalledWith({
      files: [
        expect.objectContaining({ path: NATIVE_PROJECT_DOCUMENT_PATH, expectedBefore: state.originalProject }),
        expect.objectContaining({ path: "index.html", expectedBefore: state.originalHtml }),
      ],
      history: {
        label: "Move timeline clip",
        kind: "timeline",
        coalesceKey: "timeline-move:clip:a",
      },
    });

    resolveCommit();
    await pending;
    expect(state.onCommitted).toHaveBeenCalledOnce();

    const rejectedState = memory();
    await expect(commitNativeTimelineMove({
      expectedRevision: 2,
      element: timelineElement,
      requestedStartSeconds: 3,
      requestedTrack: 0,
      readOptionalProjectFile: rejectedState.readOptionalProjectFile,
      writeProjectFile: rejectedState.writeProjectFile,
      recordEdit: rejectedState.recordEdit,
      commitFileTransaction: vi.fn(async () => { throw new Error("durable move failed"); }),
      patchCompatibilityContent: patchHtml,
      onCommitted: rejectedState.onCommitted,
    })).rejects.toThrow("durable move failed");
    expect(rejectedState.onCommitted).not.toHaveBeenCalled();
  });

  it("commits native frames and compatibility HTML in one history entry before publication", async () => {
    const state = memory();
    const result = await commitNativeTimelineMove({
      expectedRevision: 2,
      element: timelineElement,
      requestedStartSeconds: (75.8 * rate.denominator) / rate.numerator,
      requestedTrack: 0,
      readOptionalProjectFile: state.readOptionalProjectFile,
      writeProjectFile: state.writeProjectFile,
      recordEdit: state.recordEdit,
      patchCompatibilityContent: patchHtml,
      onCommitted: state.onCommitted,
    });

    expect(result.document.revision).toBe(3);
    expect(result.document.sequence.tracks[0]!.clips[0]!.startFrame).toBe(75);
    const exactSeconds = (75 * rate.denominator) / rate.numerator;
    expect(state.files.get("index.html")).toContain(`data-start="${exactSeconds}"`);
    expect(state.recordEdit).toHaveBeenCalledOnce();
    expect(state.recordEdit).toHaveBeenCalledWith({
      label: "Move timeline clip",
      kind: "timeline",
      coalesceKey: "timeline-move:clip:a",
      files: {
        [NATIVE_PROJECT_DOCUMENT_PATH]: {
          before: state.originalProject,
          after: state.files.get(NATIVE_PROJECT_DOCUMENT_PATH),
        },
        "index.html": { before: state.originalHtml, after: state.files.get("index.html") },
      },
    });
    expect(state.events).toEqual([
      `write:${NATIVE_PROJECT_DOCUMENT_PATH}`,
      "write:index.html",
      "history",
    ]);
    expect(state.onCommitted).toHaveBeenCalledOnce();
    expect(state.onCommitted).toHaveBeenCalledWith(result.document);
  });

  it("atomically commits a mapped vertical move using authored lane metadata in the HTML mirror", async () => {
    const state = memory();
    const result = await commitNativeTimelineMove({
      expectedRevision: 2,
      element: timelineElement,
      requestedStartSeconds: 3,
      requestedTrack: 19,
      readOptionalProjectFile: state.readOptionalProjectFile,
      writeProjectFile: state.writeProjectFile,
      recordEdit: state.recordEdit,
      patchCompatibilityContent: patchHtml,
      onCommitted: state.onCommitted,
    });

    expect(result.committed).toBe(true);
    if (!result.committed) return;
    expect(result.document.sequence.tracks[0]!.clips).toEqual([]);
    expect(result.document.sequence.tracks[1]!.clips[0]).toMatchObject({
      id: "clip:a",
      startFrame: 89,
      binding: { sourceFile: "index.html", domId: "clip", hfId: "hf-clip" },
      staticParameters: { opacity: 0.8 },
      effects: [{ id: "fx:one", effectId: "blur", enabled: true }],
    });
    expect(state.files.get("index.html")).toContain('data-track-index="19"');
    expect(state.events).toEqual([
      `write:${NATIVE_PROJECT_DOCUMENT_PATH}`,
      "write:index.html",
      "history",
    ]);
  });

  it("rolls the native sidecar back when the HTML mirror write fails", async () => {
    const state = memory({ failHtmlWrite: true });

    await expect(commitNativeTimelineMove({
      expectedRevision: 2,
      element: timelineElement,
      requestedStartSeconds: 3,
      requestedTrack: 19,
      readOptionalProjectFile: state.readOptionalProjectFile,
      writeProjectFile: state.writeProjectFile,
      recordEdit: state.recordEdit,
      patchCompatibilityContent: patchHtml,
      onCommitted: state.onCommitted,
    })).rejects.toThrow("html write failed");

    expect(state.files.get(NATIVE_PROJECT_DOCUMENT_PATH)).toBe(state.originalProject);
    expect(state.files.get("index.html")).toBe(state.originalHtml);
    expect(state.recordEdit).not.toHaveBeenCalled();
    expect(state.onCommitted).not.toHaveBeenCalled();
  });

  it("rolls both files back in reverse order when history registration fails", async () => {
    const state = memory({ failHistory: true });

    await expect(commitNativeTimelineMove({
      expectedRevision: 2,
      element: timelineElement,
      requestedStartSeconds: 3,
      requestedTrack: 0,
      readOptionalProjectFile: state.readOptionalProjectFile,
      writeProjectFile: state.writeProjectFile,
      recordEdit: state.recordEdit,
      patchCompatibilityContent: patchHtml,
      onCommitted: state.onCommitted,
    })).rejects.toThrow("history failed");

    expect(state.files.get(NATIVE_PROJECT_DOCUMENT_PATH)).toBe(state.originalProject);
    expect(state.files.get("index.html")).toBe(state.originalHtml);
    expect(state.events.slice(-2)).toEqual([
      "write:index.html",
      `write:${NATIVE_PROJECT_DOCUMENT_PATH}`,
    ]);
    expect(state.onCommitted).not.toHaveBeenCalled();
  });

  it("performs no write, history, or publication on a revision conflict", async () => {
    const state = memory({ revision: 3 });

    await expect(commitNativeTimelineMove({
      expectedRevision: 2,
      element: timelineElement,
      requestedStartSeconds: 3,
      requestedTrack: 0,
      readOptionalProjectFile: state.readOptionalProjectFile,
      writeProjectFile: state.writeProjectFile,
      recordEdit: state.recordEdit,
      patchCompatibilityContent: patchHtml,
      onCommitted: state.onCommitted,
    })).rejects.toBeInstanceOf(NativeProjectRevisionConflictError);

    expect(state.writeProjectFile).not.toHaveBeenCalled();
    expect(state.recordEdit).not.toHaveBeenCalled();
    expect(state.onCommitted).not.toHaveBeenCalled();
  });

  it("declines unmapped lane changes without touching durable state", async () => {
    const state = memory();
    const result = await commitNativeTimelineMove({
      expectedRevision: 2,
      element: timelineElement,
      requestedStartSeconds: 3,
      requestedTrack: 9,
      readOptionalProjectFile: state.readOptionalProjectFile,
      writeProjectFile: state.writeProjectFile,
      recordEdit: state.recordEdit,
      patchCompatibilityContent: patchHtml,
      onCommitted: state.onCommitted,
    });

    expect(result).toMatchObject({ committed: false, reason: "unsupported-lane-change" });
    expect(state.writeProjectFile).not.toHaveBeenCalled();
    expect(state.recordEdit).not.toHaveBeenCalled();
  });
});
