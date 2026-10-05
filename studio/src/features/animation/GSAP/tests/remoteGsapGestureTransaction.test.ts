import { describe, expect, it, vi } from "vitest";
import type { PreviewElementState, PreviewGsapObservation } from "../../../../../shared/preview/agentProtocol";
import { commitRemoteGsapGesture } from "../remoteGsapGestureTransaction";

const source = '<!doctype html><html><body><main data-composition-id="main"><div id="one" data-hf-id="hf-one" style="position:absolute;left:10px;top:20px;width:100px;height:50px"></div></main><script>const tl=gsap.timeline({paused:true});window.__timelines=window.__timelines||{};window.__timelines.main=tl;tl.to("#one",{duration:2,x:40},0);</script></body></html>';
const state = { handle: "e1", tag: "div", id: "one", className: "", text: "", textEditable: false,
  rect: { x: 10, y: 20, width: 100, height: 50 }, visible: true, parent: "e2", selector: "#one",
  sourceFile: "index.html", compositionPath: "index.html", dataAttributes: { "hf-id": "hf-one" },
  inlineStyles: { left: "10px", top: "20px", width: "100px", height: "50px" },
  computedStyles: { transform: "matrix(1, 0, 0, 1, 20, 0)" },
} satisfies PreviewElementState;
const ancestor = { ...state, handle: "e2", id: "", parent: null,
  computedStyles: { transform: "none" } } satisfies PreviewElementState;
const observation = { handle: "e1", id: "one", hfId: "hf-one",
  sourceFile: "index.html", compositionPath: "index.html", values: { x: 20 },
  tweens: [{ timelineId: "main", tweenIndex: 0, targetIndex: 0, start: 0, duration: 2,
    timelineTime: 1, properties: { x: 40 }, complete: true }],
} satisfies PreviewGsapObservation;

function fixture(initial = source) {
  let content = initial;
  const writes: string[] = [];
  const history: Array<{ files: Record<string, { before: string; after: string }> }> = [];
  const deps = { expectedSourceFile: "index.html",
    readOptionalProjectFile: async () => content,
    writeProjectFile: async (_path: string, next: string, expected?: string) => {
      if (expected !== content) throw new Error("source changed");
      writes.push(next); content = next;
    },
    recordEdit: vi.fn(async (entry: { files: Record<string, { before: string; after: string }> }) => {
      history.push(entry);
    }),
  };
  return { deps, writes, history, get content() { return content; }, set content(next: string) { content = next; } };
}

describe("isolated legacy GSAP gesture source transaction", () => {
  it("moves the authored box without changing its animated x curve; one Undo snapshot", async () => {
    const store = fixture();
    expect(await commitRemoteGsapGesture(state, observation, [ancestor],
      { mode: "move", delta: { x: 15, y: -5 } }, store.deps)).toBe(true);
    expect(store.content).toContain("left:25px");
    expect(store.content).toContain("top:15px");
    expect(store.content).toContain("x:40");
    expect(store.history).toHaveLength(1);
    store.content = store.history[0]!.files["index.html"]!.before;
    expect(store.content).toBe(source);
    store.content = store.history[0]!.files["index.html"]!.after;
    expect(store.content).toContain("left:25px");
  });

  it("resizes only explicit source dimensions, refusing animated scale", async () => {
    const store = fixture();
    expect(await commitRemoteGsapGesture(state, observation, [ancestor],
      { mode: "resize", width: 130, height: 75 }, store.deps)).toBe(true);
    expect(store.content).toContain("width:130px");
    expect(store.content).toContain("height:75px");
    const scaled = { ...observation, tweens: [{ ...observation.tweens[0]!, properties: { x: 40, scale: 2 } }] };
    await expect(commitRemoteGsapGesture(state, scaled, [ancestor],
      { mode: "resize", width: 140, height: 80 }, store.deps)).rejects.toThrow("keyframe editor");
    expect(store.history).toHaveLength(1);
  });

  it("refuses transformed ancestry, conflicting rotation, and missing source box", async () => {
    const store = fixture();
    await expect(commitRemoteGsapGesture(state, observation,
      [{ ...ancestor, computedStyles: { transform: "matrix(2, 0, 0, 2, 0, 0)" } }],
      { mode: "move", delta: { x: 10, y: 0 } }, store.deps)).rejects.toThrow("parent transform");
    await expect(commitRemoteGsapGesture(state, observation, [ancestor],
      { mode: "rotate", deltaDegrees: 30 }, store.deps)).rejects.toThrow("keyframe editor");
    const noBox = fixture(source.replace("width:100px;", ""));
    await expect(commitRemoteGsapGesture(state, observation, [ancestor],
      { mode: "resize", width: 130, height: 75 }, noBox.deps)).rejects.toThrow("source box");
    const staleSource = fixture(source.replace("x:40", "x:45"));
    await expect(commitRemoteGsapGesture(state, observation, [ancestor],
      { mode: "move", delta: { x: 10, y: 0 } }, staleSource.deps)).rejects.toThrow("no longer agree");
    expect(store.writes).toHaveLength(0);
    expect(noBox.writes).toHaveLength(0);
    expect(staleSource.writes).toHaveLength(0);
  });

  it("rotates a non-transform animation as a bounded additive base pose", async () => {
    const opacityOnly = { ...observation, tweens: [{ ...observation.tweens[0]!, properties: { opacity: 0.5 } }] };
    const untransformed = { ...state, computedStyles: { transform: "none" } };
    const store = fixture(source.replace("x:40", "opacity:0.5"));
    expect(await commitRemoteGsapGesture(untransformed, opacityOnly, [ancestor],
      { mode: "rotate", deltaDegrees: 45 }, store.deps)).toBe(true);
    expect(store.content).toContain("rotate:45deg");
    expect(store.content).toContain("opacity:0.5");
  });
});
