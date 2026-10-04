import { describe, expect, it, vi } from "vitest";
import { NATIVE_PROJECT_DOCUMENT_PATH as PATH, parseNativeProjectDocument } from "../../../shared/project/nativeProjectDocument";
import { commitNativeTimelineRangeEdit } from "./nativeTimelineRangeEditTransaction";
import { commitNativeTimelineMove } from "./nativeTimelineMoveTransaction";
import { commitNativeTimelineMultiRangeEdit } from "./nativeTimelineMultiRangeEditTransaction";
import { commitNativeTimelineMultiMove } from "./nativeTimelineMultiMoveTransaction";
import { commitNativeTimelineSplits } from "./nativeTimelineSplitTransaction";
import { commitNativeTimelineDelete } from "./nativeTimelineDeleteTransaction";

for (const kind of ["video", "audio", "image"] as const) {
  for (const bound of [true, false]) {
    describe(`${kind}, mirrored=${bound}, omitted row source`, () => {
      it.each(["trim", "move", "multi-trim", "multi-move", "split", "delete"])("persists %s atomically", async operation => {
        const document = parseNativeProjectDocument({ schemaVersion: 1, id: "p", revision: 0,
          frameRate: { numerator: 30, denominator: 1 }, canvas: { width: 100, height: 100, background: "#000000" },
          assets: [{ id: "asset", name: "media", kind, durationFrames: 300 }],
          sequence: { id: "seq", name: "Main", tracks: [{ id: "track", kind: kind === "audio" ? "audio" : "video",
            lane: { authoredTrack: 0, displayTrack: 0 }, clips: [{ id: "clip", assetId: "asset",
              ...(bound ? { binding: { sourceFile: "scene.html", domId: "media" } } : {}),
              startFrame: 0, durationFrames: 60, sourceInFrame: 0, muted: false, effects: [], parameterTracks: [],
            }] }] },
        });
        const before = JSON.stringify(document);
        const files = new Map([[PATH, before], ["scene.html", "before"]]);
        const recordEdit = vi.fn(async () => {});
        const read = vi.fn(async (path: string) => files.get(path));
        const write = vi.fn(async (path: string, content: string, expected?: string) => {
          expect(files.get(path)).toBe(expected); files.set(path, content);
        });
        const patch = vi.fn(() => "after");
        const element = { attributes: { "data-studio-clip-id": "clip" }, currentTrack: 0 };
        const base = { expectedRevision: 0, readOptionalProjectFile: read, writeProjectFile: write, recordEdit };
        const range = { element, requestedStartSeconds: 0, requestedDurationSeconds: 1 };
        let result;
        if (operation === "trim") result = await commitNativeTimelineRangeEdit({ ...base, ...range, patchCompatibilityContent: patch });
        else if (operation === "move") result = await commitNativeTimelineMove({ ...base, element, requestedStartSeconds: 1, requestedTrack: 0, patchCompatibilityContent: patch });
        else if (operation === "multi-trim") result = await commitNativeTimelineMultiRangeEdit({ ...base, changes: [range], patchCompatibilityContent: patch });
        else if (operation === "multi-move") result = await commitNativeTimelineMultiMove({ ...base, changes: [{ element, requestedStartSeconds: 1 }], patchCompatibilityContent: patch });
        else if (operation === "split") result = await commitNativeTimelineSplits({ ...base, splits: [{ element, requestedSplitSeconds: 1 }], patchCompatibilityContent: () => ({ content: patch(), rightBinding: { sourceFile: "scene.html", domId: "right" } }) });
        else result = await commitNativeTimelineDelete({ ...base, targets: [element], removeCompatibilityTarget: patch });
        expect(result.committed).toBe(true);
        if (!result.committed) return;
        expect(result.document.revision).toBe(1);
        expect(recordEdit).toHaveBeenCalledOnce();
        expect(write).toHaveBeenCalledTimes(bound ? 2 : 1);
        expect(patch).toHaveBeenCalledTimes(bound ? 1 : 0);
        expect(JSON.stringify(document)).toBe(before);
        const clips = result.document.sequence.tracks[0]!.clips;
        expect(clips).toHaveLength(operation === "delete" ? 0 : operation === "split" ? 2 : 1);
        if (operation.includes("trim")) expect(clips[0]!.durationFrames).toBe(30);
        if (operation.includes("move")) expect(clips[0]!.startFrame).toBe(30);
      });
    });
  }
}
