import { describe, expect, it, vi } from "vitest";

import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
  parseNativeProjectDocument,
  serializeNativeProjectDocument,
  type NativeProjectDocument,
} from "./nativeProjectDocument";
import { NativeProjectRevisionConflictError } from "./nativeProjectPersistence";
import { commitNativeTimelineRangeEdit } from "./nativeTimelineRangeEditTransaction";

const rate = { numerator: 30_000, denominator: 1_001 } as const;
const secondsAtFrame = (frame: number) => (frame * rate.denominator) / rate.numerator;

function project(revision = 6, bound = true): NativeProjectDocument {
  return parseNativeProjectDocument({
    schemaVersion: NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
    id: "project:range-tx",
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
        clips: [{
          id: "clip:a",
          assetId: "asset:a",
          ...(bound ? { binding: { sourceFile: "index.html", domId: "clip", hfId: "hf-clip" } } : {}),
          startFrame: 30,
          durationFrames: 120,
          sourceInFrame: 10,
          playbackRate: { numerator: 2, denominator: 1 },
          muted: false,
          staticParameters: { opacity: 0.8 },
          effects: [{ id: "fx:one", effectId: "blur", enabled: true }],
          parameterTracks: [],
        }],
      }],
    },
  });
}

const element = {
  id: "clip",
  domId: "clip",
  hfId: "hf-clip",
  sourceFile: "index.html",
};

function memory(options?: {
  failHtmlWrite?: boolean;
  failHistory?: boolean;
  revision?: number;
  nativeMissing?: boolean;
  htmlMissing?: boolean;
  bound?: boolean;
}) {
  const originalProject = serializeNativeProjectDocument(
    project(options?.revision ?? 6, options?.bound ?? true),
  );
  const originalHtml =
    '<video id="clip" data-hf-id="hf-clip" data-start="1.001" data-duration="4.004" data-media-start="0.33366666666666667"></video>';
  const files = new Map<string, string>();
  if (!options?.nativeMissing) files.set(NATIVE_PROJECT_DOCUMENT_PATH, originalProject);
  if (!options?.htmlMissing) files.set("index.html", originalHtml);
  const events: string[] = [];
  const readOptionalProjectFile = vi.fn(async (path: string) => files.get(path));
  const writeProjectFile = vi.fn(async (path: string, content: string, expected?: string) => {
    events.push(`write:${path}`);
    if (files.get(path) !== expected) throw new Error(`CAS conflict: ${path}`);
    if (options?.failHtmlWrite && path === "index.html" && content !== originalHtml) {
      throw new Error("html write failed");
    }
    files.set(path, content);
  });
  const recordEdit = vi.fn(async () => {
    events.push("history");
    if (options?.failHistory) throw new Error("history failed");
  });
  const onCommitted = vi.fn(() => events.push("publish"));
  const patchCompatibilityContent = vi.fn((content: string, timing: {
    start: string;
    duration: string;
    sourceOffset: string;
  }) => content
    .replace(/data-start="[^"]*"/, `data-start="${timing.start}"`)
    .replace(/data-duration="[^"]*"/, `data-duration="${timing.duration}"`)
    .replace(/data-media-start="[^"]*"/, `data-media-start="${timing.sourceOffset}"`));
  return {
    originalProject,
    originalHtml,
    files,
    events,
    readOptionalProjectFile,
    writeProjectFile,
    recordEdit,
    onCommitted,
    patchCompatibilityContent,
  };
}

describe("native timeline dual-file range transaction", () => {
  it("uses one durable file transaction and publishes only after it resolves", async () => {
    const state = memory();
    let resolveCommit!: () => void;
    const commitFileTransaction = vi.fn(() => new Promise<void>((resolve) => { resolveCommit = resolve; }));
    const pending = commitNativeTimelineRangeEdit({
      expectedRevision: 6,
      element,
      requestedStartSeconds: secondsAtFrame(45),
      requestedDurationSeconds: secondsAtFrame(105),
      readOptionalProjectFile: state.readOptionalProjectFile,
      writeProjectFile: state.writeProjectFile,
      recordEdit: state.recordEdit,
      commitFileTransaction,
      patchCompatibilityContent: state.patchCompatibilityContent,
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
        label: "Trim timeline clip",
        kind: "timeline",
        coalesceKey: "timeline-resize:clip:a",
      },
    });
    resolveCommit();
    await pending;
    expect(state.onCommitted).toHaveBeenCalledOnce();

    const rejectedState = memory();
    await expect(commitNativeTimelineRangeEdit({
      expectedRevision: 6,
      element,
      requestedStartSeconds: secondsAtFrame(45),
      requestedDurationSeconds: secondsAtFrame(105),
      readOptionalProjectFile: rejectedState.readOptionalProjectFile,
      writeProjectFile: rejectedState.writeProjectFile,
      recordEdit: rejectedState.recordEdit,
      commitFileTransaction: vi.fn(async () => { throw new Error("durable trim failed"); }),
      patchCompatibilityContent: rejectedState.patchCompatibilityContent,
      onCommitted: rejectedState.onCommitted,
    })).rejects.toThrow("durable trim failed");
    expect(rejectedState.onCommitted).not.toHaveBeenCalled();
  });

  it("durably commits one trim and compatibility mirror before publishing once", async () => {
    const state = memory();
    const result = await commitNativeTimelineRangeEdit({
      expectedRevision: 6,
      element,
      requestedStartSeconds: secondsAtFrame(45),
      requestedDurationSeconds: secondsAtFrame(105),
      readOptionalProjectFile: state.readOptionalProjectFile,
      writeProjectFile: state.writeProjectFile,
      recordEdit: state.recordEdit,
      patchCompatibilityContent: state.patchCompatibilityContent,
      onCommitted: state.onCommitted,
    });

    expect(result.committed).toBe(true);
    if (!result.committed) return;
    expect(result.document.revision).toBe(7);
    expect(result.document.sequence.tracks[0]!.clips[0]).toMatchObject({
      startFrame: 45,
      durationFrames: 105,
      sourceInFrame: 40,
    });
    const timing = {
      start: String(secondsAtFrame(45)),
      duration: String(secondsAtFrame(105)),
      sourceOffset: String(secondsAtFrame(40)),
    };
    expect(state.patchCompatibilityContent).toHaveBeenCalledWith(state.originalHtml, timing);
    expect(state.recordEdit).toHaveBeenCalledOnce();
    expect(state.recordEdit).toHaveBeenCalledWith({
      label: "Trim timeline clip",
      kind: "timeline",
      coalesceKey: "timeline-resize:clip:a",
      files: {
        [NATIVE_PROJECT_DOCUMENT_PATH]: {
          before: state.originalProject,
          after: state.files.get(NATIVE_PROJECT_DOCUMENT_PATH),
        },
        "index.html": {
          before: state.originalHtml,
          after: state.files.get("index.html"),
        },
      },
    });
    expect(state.events).toEqual([
      `write:${NATIVE_PROJECT_DOCUMENT_PATH}`,
      "write:index.html",
      "history",
      "publish",
    ]);
    expect(state.onCommitted).toHaveBeenCalledWith(result.document);
  });

  it("rolls the native sidecar back if the compatibility write fails", async () => {
    const state = memory({ failHtmlWrite: true });

    await expect(commitNativeTimelineRangeEdit({
      expectedRevision: 6,
      element,
      requestedStartSeconds: secondsAtFrame(45),
      requestedDurationSeconds: secondsAtFrame(105),
      readOptionalProjectFile: state.readOptionalProjectFile,
      writeProjectFile: state.writeProjectFile,
      recordEdit: state.recordEdit,
      patchCompatibilityContent: state.patchCompatibilityContent,
      onCommitted: state.onCommitted,
    })).rejects.toThrow("html write failed");

    expect(state.files.get(NATIVE_PROJECT_DOCUMENT_PATH)).toBe(state.originalProject);
    expect(state.files.get("index.html")).toBe(state.originalHtml);
    expect(state.recordEdit).not.toHaveBeenCalled();
    expect(state.onCommitted).not.toHaveBeenCalled();
  });

  it("rolls both files back in reverse order if the one history entry fails", async () => {
    const state = memory({ failHistory: true });

    await expect(commitNativeTimelineRangeEdit({
      expectedRevision: 6,
      element,
      requestedStartSeconds: secondsAtFrame(30),
      requestedDurationSeconds: secondsAtFrame(60),
      readOptionalProjectFile: state.readOptionalProjectFile,
      writeProjectFile: state.writeProjectFile,
      recordEdit: state.recordEdit,
      patchCompatibilityContent: state.patchCompatibilityContent,
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
    const state = memory({ revision: 7 });

    await expect(commitNativeTimelineRangeEdit({
      expectedRevision: 6,
      element,
      requestedStartSeconds: secondsAtFrame(30),
      requestedDurationSeconds: secondsAtFrame(60),
      readOptionalProjectFile: state.readOptionalProjectFile,
      writeProjectFile: state.writeProjectFile,
      recordEdit: state.recordEdit,
      patchCompatibilityContent: state.patchCompatibilityContent,
      onCommitted: state.onCommitted,
    })).rejects.toBeInstanceOf(NativeProjectRevisionConflictError);

    expect(state.writeProjectFile).not.toHaveBeenCalled();
    expect(state.recordEdit).not.toHaveBeenCalled();
    expect(state.onCommitted).not.toHaveBeenCalled();
  });

  it.each([
    ["missing-native-project", { nativeMissing: true }],
    ["missing-compatibility-file", { htmlMissing: true }],
  ] as const)("declines %s without creating history or publishing", async (reason, options) => {
    const state = memory(options);
    const result = await commitNativeTimelineRangeEdit({
      expectedRevision: 6,
      element,
      requestedStartSeconds: secondsAtFrame(30),
      requestedDurationSeconds: secondsAtFrame(60),
      readOptionalProjectFile: state.readOptionalProjectFile,
      writeProjectFile: state.writeProjectFile,
      recordEdit: state.recordEdit,
      patchCompatibilityContent: state.patchCompatibilityContent,
      onCommitted: state.onCommitted,
    });

    expect(result).toEqual({ committed: false, reason });
    expect(state.writeProjectFile).not.toHaveBeenCalled();
    expect(state.recordEdit).not.toHaveBeenCalled();
    expect(state.onCommitted).not.toHaveBeenCalled();
  });

  it("explicitly declines an unbound element before locking or reading files", async () => {
    const state = memory({ bound: false });
    const result = await commitNativeTimelineRangeEdit({
      expectedRevision: 6,
      element: { ...element, sourceFile: undefined, dataset: { studioClipId: "clip:a" } },
      requestedStartSeconds: secondsAtFrame(30),
      requestedDurationSeconds: secondsAtFrame(60),
      readOptionalProjectFile: state.readOptionalProjectFile,
      writeProjectFile: state.writeProjectFile,
      recordEdit: state.recordEdit,
      patchCompatibilityContent: state.patchCompatibilityContent,
      onCommitted: state.onCommitted,
    });

    expect(result).toEqual({ committed: false, reason: "unbound-clip" });
    expect(state.readOptionalProjectFile).not.toHaveBeenCalled();
    expect(state.writeProjectFile).not.toHaveBeenCalled();
  });
});
