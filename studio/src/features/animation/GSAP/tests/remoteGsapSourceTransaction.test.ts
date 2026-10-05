import { describe, expect, it, vi } from "vitest";
import { parseGsapScriptAcorn } from "@hyperframes/core/gsap-parser-acorn";
import type { PreviewElementState, PreviewGsapObservation } from "../../../../../shared/preview/agentProtocol";
import { commitRemoteGsapPropertyEdit, loadRemoteGsapTargets } from "../remoteGsapSourceTransaction";

const sourceFile = "index.html";
const before = '<!doctype html><html><body><main data-composition-id="main"><div id="one" data-hf-id="hf-one"></div></main><script>const tl=gsap.timeline({paused:true});window.__timelines=window.__timelines||{};window.__timelines.main=tl;tl.to("#one",{duration:2,x:40},0);</script></body></html>';
const script = before.match(/<script>(.*?)<\/script>/)?.[1] ?? "";
const animationId = parseGsapScriptAcorn(script).animations[0]!.id;
const state = {
  handle: "e1", tag: "div", id: "one", className: "", text: "", textEditable: true,
  rect: { x: 0, y: 0, width: 20, height: 20 }, visible: true, parent: null,
  sourceFile, compositionPath: sourceFile, dataAttributes: { "hf-id": "hf-one" },
  inlineStyles: {}, computedStyles: {},
} satisfies PreviewElementState;
const observation = {
  handle: "e1", id: "one", hfId: "hf-one", sourceFile, compositionPath: sourceFile,
  values: { x: 20 }, tweens: [{ timelineId: "main", tweenIndex: 0, targetIndex: 0,
    start: 0, duration: 2, timelineTime: 1, properties: { x: 40 }, complete: true }],
} satisfies PreviewGsapObservation;

function fixture(initial = before) {
  let content = initial;
  const writes: Array<{ path: string; content: string; expected?: string }> = [];
  const history: Array<{ files: Record<string, { before: string; after: string }> }> = [];
  const deps = {
    expectedSourceFile: sourceFile,
    readOptionalProjectFile: async (path: string) => path === sourceFile ? content : null,
    writeProjectFile: async (path: string, next: string, expected?: string) => {
      if (path !== sourceFile || expected !== content) throw new Error("source changed");
      writes.push({ path, content: next, expected });
      content = next;
    },
    recordEdit: vi.fn(async (entry: { files: Record<string, { before: string; after: string }> }) => {
      history.push(entry);
    }),
  };
  return { deps, writes, history, get content() { return content; }, set content(next: string) { content = next; } };
}

describe("remote legacy GSAP source transaction", () => {
  it("lists one exact authored tween and saves one CAS/history snapshot", async () => {
    const store = fixture();
    expect(await loadRemoteGsapTargets(state, observation, store.deps)).toEqual([
      { id: animationId, label: "to #one", properties: { x: 40 } },
    ]);
    expect(await commitRemoteGsapPropertyEdit(state, observation,
      { animationId, property: "x", value: 55 }, store.deps)).toBe(true);
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0]!.expected).toBe(before);
    expect(store.history).toHaveLength(1);
    expect(store.history[0]!.files[sourceFile]).toEqual({ before, after: store.content });
    const reopened = fixture(store.content);
    const changedObservation = { ...observation, tweens: observation.tweens.map(tween => ({
      ...tween, properties: { x: 55 },
    })) };
    expect((await loadRemoteGsapTargets(state, changedObservation, reopened.deps))[0]?.properties.x).toBe(55);
    // The recorded snapshot is sufficient for one Undo and one Redo.
    store.content = store.history[0]!.files[sourceFile]!.before;
    expect((await loadRemoteGsapTargets(state, observation, store.deps))[0]?.properties.x).toBe(40);
    store.content = store.history[0]!.files[sourceFile]!.after;
    expect((await loadRemoteGsapTargets(state, changedObservation, store.deps))[0]?.properties.x).toBe(55);
  });

  it("rejects mismatched frame/source identity before writing", async () => {
    const store = fixture();
    await expect(commitRemoteGsapPropertyEdit({ ...state, sourceFile: "other.html" }, observation,
      { animationId, property: "x", value: 55 }, store.deps)).rejects.toThrow("active composition");
    await expect(commitRemoteGsapPropertyEdit(state, { ...observation, hfId: "stale" },
      { animationId, property: "x", value: 55 }, store.deps)).rejects.toThrow("active composition");
    expect(store.writes).toHaveLength(0);
  });

  it("refuses duplicate source IDs and broad group selectors", async () => {
    const duplicate = fixture(before.replace("</main>", '<div id="one"></div></main>'));
    await expect(loadRemoteGsapTargets(state, observation, duplicate.deps)).rejects.toThrow("uniquely");
    const broad = fixture(before.replace("</main>", '<div id="two"></div></main>')
      .replace('tl.to("#one"', 'tl.to("div"'));
    expect(await loadRemoteGsapTargets(state, observation, broad.deps)).toEqual([]);
    await expect(commitRemoteGsapPropertyEdit(state, observation,
      { animationId, property: "x", value: 55 }, broad.deps)).rejects.toThrow("uniquely editable");
    expect(broad.writes).toHaveLength(0);
  });

  it("refuses incomplete runtime evidence and unsupported values", async () => {
    const store = fixture();
    expect(await loadRemoteGsapTargets(state, { ...observation,
      tweens: observation.tweens.map(tween => ({ ...tween, complete: false })) }, store.deps)).toEqual([]);
    await expect(commitRemoteGsapPropertyEdit(state, observation,
      { animationId, property: "opacity", value: 0.5 }, store.deps)).rejects.toThrow("uniquely editable");
    await expect(commitRemoteGsapPropertyEdit(state, observation,
      { animationId, property: "x", value: Number.NaN }, store.deps)).rejects.toThrow("unsupported");
    expect(store.writes).toHaveLength(0);
  });

  it("distinguishes multiple simple tweens by exact authored values and timing", async () => {
    const multi = fixture(before.replace('tl.to("#one",{duration:2,x:40},0);',
      'tl.to("#one",{duration:2,x:40},0);tl.to("#one",{duration:1,opacity:0.5},2);'));
    const runtime: PreviewGsapObservation = { ...observation, tweens: [
      observation.tweens[0]!,
      { timelineId: "main", tweenIndex: 1, targetIndex: 0, start: 2, duration: 1,
        timelineTime: 2, properties: { opacity: 0.5 }, complete: true },
    ] };
    expect((await loadRemoteGsapTargets(state, runtime, multi.deps)).map(target => target.properties))
      .toEqual([{ x: 40 }, { opacity: 0.5 }]);
  });
});
