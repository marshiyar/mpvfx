// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import {
  commitAuthoredTimelineSplits,
  commitAuthoredTimelineDelete,
} from "./authoredTimelineSplitTransaction";
import {
  parseNativeProjectDocument,
  serializeNativeProjectDocument,
  NATIVE_PROJECT_DOCUMENT_PATH,
} from "./nativeProjectDocument";
import type { TimelineElement } from "../player";

const native = () =>
  parseNativeProjectDocument({
    schemaVersion: 1,
    id: "p",
    revision: 2,
    frameRate: { numerator: 30, denominator: 1 },
    canvas: { width: 640, height: 360, background: "#000000" },
    assets: [{ id: "v", kind: "video", name: "v", durationFrames: 120 }],
    sequence: {
      id: "s",
      name: "Main",
      tracks: [
        {
          id: "t",
          kind: "video",
          clips: [
            {
              id: "clip",
              binding: { sourceFile: "index.html", domId: "video" },
              assetId: "v",
              startFrame: 0,
              durationFrames: 120,
              sourceInFrame: 0,
              muted: false,
              effects: [],
              parameterTracks: [],
            },
          ],
        },
      ],
    },
  });
const el = (id: string, tag: string): TimelineElement => ({
  id,
  domId: id,
  tag,
  sourceFile: "index.html",
  start: 0,
  duration: 4,
  track: 0,
  timingSource: "authored",
});
const html = `<div data-composition-id="main" data-duration="4"><video id="video" data-start="0" data-duration="4"></video><div id="title" data-start="0" data-duration="4">Title</div></div><script>const tl=gsap.timeline();tl.to("#title",{x:100,opacity:0.3,duration:4,ease:"power2.in"},0);</script>`;
function setup() {
  const files = new Map([
    ["index.html", html],
    [NATIVE_PROJECT_DOCUMENT_PATH, serializeNativeProjectDocument(native())],
  ]);
  const writeProjectFile = vi.fn(async (path: string, content: string, expected?: string) => {
    if (files.get(path) !== expected) throw new Error("conflict");
    files.set(path, content);
  });
  const recordEdit = vi.fn(async () => undefined);
  return {
    files,
    input: {
      elements: [el("video", "video"), el("title", "div")],
      splitSeconds: 1.5,
      activeCompPath: "index.html",
      readOptionalProjectFile: async (path: string) => files.get(path),
      writeProjectFile,
      recordEdit,
    },
    writeProjectFile,
    recordEdit,
  };
}
describe("mixed clip split transaction", () => {
  it("deletes a mixed media/title selection in one undo entry and rejects locked clips atomically", async () => {
    const h = setup();
    await expect(
      commitAuthoredTimelineDelete({
        ...h.input,
        elements: [h.input.elements[0]!, { ...h.input.elements[1]!, timelineLocked: true }],
      }),
    ).rejects.toThrow(/unlock/i);
    expect(h.writeProjectFile).not.toHaveBeenCalled();
    await commitAuthoredTimelineDelete(h.input);
    expect(JSON.parse(h.files.get(NATIVE_PROJECT_DOCUMENT_PATH)!).sequence.tracks[0].clips).toEqual(
      [],
    );
    const dom = new DOMParser().parseFromString(h.files.get("index.html")!, "text/html");
    expect(dom.getElementById("video")).toBeNull();
    expect(dom.getElementById("title")).toBeNull();
    expect(h.recordEdit).toHaveBeenCalledOnce();
  });
  it("splits native media and animated graphics together in a single recoverable history entry", async () => {
    const h = setup();
    const result = await commitAuthoredTimelineSplits(h.input);
    expect(result.document!.revision).toBe(3);
    expect(result.document!.sequence.tracks[0]!.clips.map((c) => c.durationFrames)).toEqual([
      45, 75,
    ]);
    const saved = h.files.get("index.html")!;
    expect(saved).toContain('id="title-split"');
    expect(saved).toContain('tl.to("#title-split"');
    expect(saved).toContain('"power2.in"');
    expect(h.recordEdit).toHaveBeenCalledOnce();
    expect(h.recordEdit.mock.calls[0]![0]).toMatchObject({
      files: {
        "index.html": { before: html },
        [NATIVE_PROJECT_DOCUMENT_PATH]: {
          before: serializeNativeProjectDocument(native()),
        },
      },
    });
  });
  it("rejects unsupported or stale targets before writing any file", async () => {
    const h = setup();
    h.input.elements.push(el("missing", "div"));
    await expect(commitAuthoredTimelineSplits(h.input)).rejects.toThrow();
    expect(h.writeProjectFile).not.toHaveBeenCalled();
    expect(h.recordEdit).not.toHaveBeenCalled();
  });
  it("rolls back every prepared file if the history commit fails", async () => {
    const h = setup();
    const before = new Map(h.files);
    h.recordEdit.mockRejectedValueOnce(new Error("history full"));
    await expect(commitAuthoredTimelineSplits(h.input)).rejects.toThrow("history full");
    expect(h.files).toEqual(before);
  });
});
