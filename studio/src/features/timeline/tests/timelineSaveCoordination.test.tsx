// @vitest-environment happy-dom
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createStudioApi, type StudioApiAdapter } from "@hyperframes/studio-server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFileManager } from "../../history/useFileManager";
import { buildAtomicCutIntents, runAtomicCutTransaction } from "../razorSplitTransaction";
import { buildTimelineMoveTimingPatch, persistTimelineEdit, persistTimelineBatchEdit } from "../timelineEditingHelpers";
import type { TimelineElement } from "../../../player/index";
import type { RecordEditInput } from "../../history/studioFileHistory";

vi.mock("../../history/useFileTree", () => ({
  useFileTree: () => ({ fileTree: [], compositions: [], assets: [], fontAssets: [], refreshFileTree: vi.fn() }),
}));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: string[] = [];
const reactRoots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  for (const root of reactRoots.splice(0)) await act(async () => root.unmount());
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

const source = '<!DOCTYPE html><html><head></head><body><div data-composition-id="main" data-duration="20"><video id="clip" data-hf-id="clip-hf" src="clip.mp4" data-start="0" data-duration="4" data-track-index="0"></video></div></body></html>';
const clip: TimelineElement = {
  id: "clip", domId: "clip", hfId: "clip-hf", tag: "video", start: 0, duration: 4,
  track: 0, sourceFile: "index.html", timingSource: "authored",
};

async function setup(beforePut?: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "timeline-save-"));
  roots.push(dir);
  await writeFile(join(dir, "index.html"), source);
  const api = createStudioApi({ resolveProject: async () => ({ id: "demo", dir }), bundle: async () => null } as unknown as StudioApiAdapter);
  const cutStarted = gate();
  const allowCut = gate();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "PUT") await beforePut?.(dir);
    if (url.includes("/split-batch")) {
      cutStarted.release();
      await allowCut.promise;
    }
    return api.fetch(new Request(`mpvfx://editor${url.replace(/^\/api/, "")}`, init));
  }));
  let manager!: ReturnType<typeof useFileManager>;
  function Probe() {
    manager = useFileManager({ projectId: "demo", showToast: vi.fn(), setRefreshKey: vi.fn() });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  reactRoots.push(root);
  await act(async () => root.render(<Probe />));
  return { dir, manager, cutStarted, allowCut };
}

describe("split followed immediately by a timeline move", () => {
  it.each(["single", "group"] as const)("preserves the split and saves a queued %s move without a false conflict", async (mode) => {
    const { dir, manager, cutStarted, allowCut } = await setup();
    const recordEdit = vi.fn(async (_entry: RecordEditInput) => {});
    const cut = runAtomicCutTransaction({
      projectId: "demo", intents: buildAtomicCutIntents([clip], 2, "index.html"),
      label: "Split timeline clip", writeProjectFile: manager.writeProjectFile,
      recordEdit, observeProjectFileVersion: manager.observeProjectFileVersion, synchronize: vi.fn(),
    });
    await cutStarted.promise;
    const buildPatches = (before: string, target: Parameters<typeof buildTimelineMoveTimingPatch>[1]) =>
      buildTimelineMoveTimingPatch(before, target, 10, 2, 1);
    const common = {
      projectId: "demo", activeCompPath: "index.html", label: "Move timeline clip",
      writeProjectFile: manager.writeProjectFile, recordEdit,
      domEditSaveTimestampRef: { current: 0 }, pendingTimelineEditPathRef: { current: new Set<string>() },
    };
    const move = mode === "single"
      ? persistTimelineEdit({ ...common, element: clip, buildPatches })
      : persistTimelineBatchEdit({ ...common, changes: [{ element: clip, buildPatches }] });
    // Let the move reach its first read while the split is still in flight.
    await new Promise((resolve) => setTimeout(resolve, 0));
    allowCut.release();
    await cut;
    await expect(move).resolves.toBeUndefined();
    const saved = await readFile(join(dir, "index.html"), "utf8");
    const doc = new DOMParser().parseFromString(saved, "text/html");
    expect(doc.querySelectorAll("video")).toHaveLength(2);
    expect(doc.querySelector("#clip")?.getAttribute("data-start")).toBe("10");
    expect(doc.querySelector("#clip")?.getAttribute("data-duration")).toBe("2");
    expect(doc.querySelector("#clip")?.getAttribute("data-track-index")).toBe("1");
    expect(recordEdit).toHaveBeenCalledTimes(2);
    const splitEntry = recordEdit.mock.calls[0]![0];
    const moveEntry = recordEdit.mock.calls[1]![0];
    expect(moveEntry.files["index.html"].before).toBe(splitEntry.files["index.html"].after);
    expect(moveEntry.files["index.html"].after).toBe(saved);
    await manager.writeProjectFile("index.html", moveEntry.files["index.html"].before, saved);
    expect(await readFile(join(dir, "index.html"), "utf8")).toBe(splitEntry.files["index.html"].after);
    await manager.writeProjectFile("index.html", saved, moveEntry.files["index.html"].before);
    expect(await readFile(join(dir, "index.html"), "utf8")).toBe(saved);
  });

  it("still rejects an actual external change between reading and saving", async () => {
    const external = source.replace('data-start="0"', 'data-start="7"');
    const { dir, manager } = await setup((dir) => writeFile(join(dir, "index.html"), external));
    const recordEdit = vi.fn();
    await expect(persistTimelineEdit({
      projectId: "demo", activeCompPath: "index.html", label: "Move timeline clip", element: clip,
      buildPatches: (before, target) => buildTimelineMoveTimingPatch(before, target, 10, 4),
      writeProjectFile: manager.writeProjectFile, recordEdit,
      domEditSaveTimestampRef: { current: 0 }, pendingTimelineEditPathRef: { current: new Set<string>() },
    })).rejects.toMatchObject({ name: "StudioFileConflictError", currentContent: external });
    expect(await readFile(join(dir, "index.html"), "utf8")).toBe(external);
    expect(recordEdit).not.toHaveBeenCalled();
  });

  it("restores the completed split if recording the following move fails", async () => {
    const { dir, manager, allowCut } = await setup();
    allowCut.release();
    await runAtomicCutTransaction({
      projectId: "demo", intents: buildAtomicCutIntents([clip], 2, "index.html"),
      label: "Split timeline clip", writeProjectFile: manager.writeProjectFile,
      recordEdit: vi.fn(), synchronize: vi.fn(),
    });
    const split = await readFile(join(dir, "index.html"), "utf8");
    await expect(persistTimelineEdit({
      projectId: "demo", activeCompPath: "index.html", label: "Move timeline clip", element: clip,
      buildPatches: (before, target) => buildTimelineMoveTimingPatch(before, target, 10, 2),
      writeProjectFile: manager.writeProjectFile,
      recordEdit: vi.fn().mockRejectedValue(new Error("history unavailable")),
      domEditSaveTimestampRef: { current: 0 }, pendingTimelineEditPathRef: { current: new Set<string>() },
    })).rejects.toThrow("history unavailable");
    expect(await readFile(join(dir, "index.html"), "utf8")).toBe(split);
  });
});
