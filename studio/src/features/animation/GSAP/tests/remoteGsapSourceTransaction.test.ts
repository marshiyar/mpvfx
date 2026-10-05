import { describe, expect, it, vi } from "vitest";
import { parseGsapScriptAcorn } from "@hyperframes/core/gsap-parser-acorn";
import type { PreviewElementState, PreviewGsapObservation } from "../../../../../shared/preview/agentProtocol";
import { commitRemoteGsapAnimationAction, commitRemoteGsapKeyframeEdit, commitRemoteGsapPropertyEdit,
  loadRemoteGsapTargets } from "../remoteGsapSourceTransaction";

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
      { id: animationId, label: "to #one", method: "to", properties: { x: 40 }, start: 0, duration: 2 },
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

  it("updates, adds, and removes exact percentage keyframes with one history entry each", async () => {
    const keyed = before.replace('tl.to("#one",{duration:2,x:40},0);',
      'tl.to("#one",{duration:2,keyframes:{"0%":{x:0},"100%":{x:40}}},0);');
    const keyedObservation = { ...observation, tweens: [{ ...observation.tweens[0]!,
      properties: {}, keyframes: [
        { percentage: 0, properties: { x: 0 } },
        { percentage: 100, properties: { x: 40 } },
      ] }] } satisfies PreviewGsapObservation;
    const store = fixture(keyed);
    expect((await loadRemoteGsapTargets(state, keyedObservation, store.deps))[0]?.keyframes)
      .toEqual(keyedObservation.tweens[0]!.keyframes);
    expect(await commitRemoteGsapKeyframeEdit(state, keyedObservation,
      { action: "add", animationId, percentage: 50, property: "x", value: 20 }, store.deps)).toBe(true);
    expect(parseGsapScriptAcorn(store.content.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "")
      .animations[0]?.keyframes?.keyframes.map(frame => frame.percentage)).toEqual([0, 50, 100]);
    expect(store.history).toHaveLength(1);
    const observedWithMiddle = { ...keyedObservation, tweens: keyedObservation.tweens.map(tween => ({
      ...tween, keyframes: [tween.keyframes![0]!, { percentage: 50, properties: { x: 20 } }, tween.keyframes![1]!],
    })) };
    expect(await commitRemoteGsapKeyframeEdit(state, observedWithMiddle,
      { action: "update", animationId, percentage: 50, property: "x", value: 25 }, store.deps)).toBe(true);
    const observedWithChange = { ...observedWithMiddle, tweens: observedWithMiddle.tweens.map(tween => ({
      ...tween, keyframes: tween.keyframes.map(frame => frame.percentage === 50
        ? { ...frame, properties: { x: 25 } } : frame),
    })) };
    expect(await commitRemoteGsapKeyframeEdit(state, observedWithChange,
      { action: "remove", animationId, percentage: 50 }, store.deps)).toBe(true);
    expect((await loadRemoteGsapTargets(state, keyedObservation, store.deps))[0]?.keyframes)
      .toEqual(keyedObservation.tweens[0]!.keyframes);
    expect(store.history).toHaveLength(3);
  });

  it("saves one keyframe ease while retaining its values and an Undo snapshot", async () => {
    const keyed = before.replace('tl.to("#one",{duration:2,x:40},0);',
      'tl.to("#one",{duration:2,keyframes:{"0%":{x:0},"100%":{x:40}}},0);');
    const keyedObservation = { ...observation, tweens: [{ ...observation.tweens[0]!,
      properties: {}, keyframes: [
        { percentage: 0, properties: { x: 0 } },
        { percentage: 100, properties: { x: 40 } },
      ] }] } satisfies PreviewGsapObservation;
    const store = fixture(keyed);
    expect(await commitRemoteGsapKeyframeEdit(state, keyedObservation,
      { action: "ease", animationId, percentage: 100, ease: "power2.in" }, store.deps)).toBe(true);
    const frames = parseGsapScriptAcorn(store.content.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "")
      .animations[0]?.keyframes?.keyframes;
    expect(frames).toMatchObject([
      { percentage: 0, properties: { x: 0 } },
      { percentage: 100, properties: { x: 40 }, ease: "power2.in" },
    ]);
    expect(store.history[0]?.files[sourceFile]).toEqual({ before: keyed, after: store.content });
    await expect(commitRemoteGsapKeyframeEdit(state, keyedObservation,
      { action: "ease", animationId, percentage: 100, ease: "custom(bad)" }, store.deps))
      .rejects.toThrow("unsupported");
    expect(store.writes).toHaveLength(1);
  });

  it("authors a first simple tween and removes only its matched source call", async () => {
    const empty = fixture(before.replace('tl.to("#one",{duration:2,x:40},0);', ""));
    const idle = { ...observation, tweens: [] };
    const selected = { ...state, selector: "#one" };
    expect(await commitRemoteGsapAnimationAction(selected, idle,
      { action: "add", method: "to", property: "x", value: 55, position: 0, duration: 2 },
      empty.deps)).toBe(true);
    const authored = parseGsapScriptAcorn(empty.content.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "")
      .animations[0];
    expect(authored).toMatchObject({ targetSelector: "#one", method: "to", properties: { x: 55 },
      position: 0, duration: 2 });
    const observed = { ...observation, tweens: observation.tweens.map(tween => ({
      ...tween, properties: { x: 55 },
    })) };
    expect(await commitRemoteGsapAnimationAction(selected, observed,
      { action: "remove", animationId: authored!.id }, empty.deps)).toBe(true);
    expect(parseGsapScriptAcorn(empty.content.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "")
      .animations).toEqual([]);
    expect(empty.history).toHaveLength(2);
    const occupied = fixture();
    await expect(commitRemoteGsapAnimationAction(selected, observation,
      { action: "add", method: "to", property: "x", value: 55, duration: 2 }, occupied.deps))
      .rejects.toThrow("idle source-bound");
    expect(occupied.writes).toHaveLength(0);
    const unobservedSet = fixture(before.replace('tl.to("#one",{duration:2,x:40},0);',
      'gsap.set("#one",{x:40});'));
    await expect(commitRemoteGsapAnimationAction(selected, idle,
      { action: "add", method: "to", property: "x", value: 55, duration: 2 }, unobservedSet.deps))
      .rejects.toThrow("already targets");
    expect(unobservedSet.writes).toHaveLength(0);
  });

  it("authors explicit from/to endpoints and saves a verified ease", async () => {
    const empty = fixture(before.replace('tl.to("#one",{duration:2,x:40},0);', ""));
    const selected = { ...state, selector: "#one" };
    expect(await commitRemoteGsapAnimationAction(selected, { ...observation, tweens: [] },
      { action: "add", method: "fromTo", property: "x", fromValue: 10, value: 40,
        duration: 2, position: 0, ease: "power2.in" }, empty.deps)).toBe(true);
    const authored = parseGsapScriptAcorn(empty.content.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "").animations[0]!;
    expect(authored).toMatchObject({ method: "fromTo", fromProperties: { x: 10 },
      properties: { x: 40 }, ease: "power2.in" });
    const observed = { ...observation, tweens: [{ ...observation.tweens[0]!, method: "fromTo" as const,
      fromProperties: { x: 10 }, properties: { x: 40 } }] };
    expect((await loadRemoteGsapTargets(selected, observed, empty.deps))[0]?.method).toBe("fromTo");
    expect(await commitRemoteGsapPropertyEdit(selected, observed,
      { animationId: authored.id, property: "x", value: 12, endpoint: "from" }, empty.deps)).toBe(true);
    const edited = { ...observed, tweens: [{ ...observed.tweens[0]!, fromProperties: { x: 12 } }] };
    expect(await commitRemoteGsapAnimationAction(selected, edited,
      { action: "ease", animationId: authored.id, ease: "sine.out" }, empty.deps)).toBe(true);
    const result = parseGsapScriptAcorn(empty.content.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "").animations[0]!;
    expect(result).toMatchObject({ fromProperties: { x: 12 }, ease: "sine.out" });
    expect(empty.history).toHaveLength(3);
  });

  it("rejects a forged fromTo start endpoint before editing the source", async () => {
    const source = before.replace('tl.to("#one",{duration:2,x:40},0);',
      'tl.fromTo("#one",{x:10},{duration:2,x:40},0);');
    const store = fixture(source);
    const forged = { ...observation, tweens: [{ ...observation.tweens[0]!, method: "fromTo" as const,
      fromProperties: { x: 999 } }] };
    expect(await loadRemoteGsapTargets(state, forged, store.deps)).toEqual([]);
    expect(store.writes).toHaveLength(0);
  });

  it("edits one verified literal motion path point and keeps unrelated source", async () => {
    const pathSource = before.replace('tl.to("#one",{duration:2,x:40},0);',
      'tl.to("#one",{duration:2,motionPath:{path:[{x:0,y:0},{x:20,y:30},{x:40,y:0}],curviness:1,autoRotate:false}},0);');
    const store = fixture(pathSource);
    const authored = parseGsapScriptAcorn(pathSource.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "").animations[0]!;
    const observed = { ...observation, tweens: [{ ...observation.tweens[0]!, properties: {},
      motionPath: { points: [{ x: 0, y: 0 }, { x: 20, y: 30 }, { x: 40, y: 0 }],
        curviness: 1, autoRotate: false, isCubic: false } }] } satisfies PreviewGsapObservation;
    expect((await loadRemoteGsapTargets(state, observed, store.deps))[0]?.motionPath?.points).toHaveLength(3);
    expect(await commitRemoteGsapAnimationAction(state, observed,
      { action: "motion-point", animationId: authored.id, index: 1, x: 25, y: 35 }, store.deps)).toBe(true);
    const updated = parseGsapScriptAcorn(store.content.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "").animations[0]!;
    expect(updated.keyframes?.keyframes[1]?.properties).toMatchObject({ x: 25, y: 35 });
    expect(store.history).toHaveLength(1);
    expect(await loadRemoteGsapTargets(state, observed, store.deps)).toEqual([]);
  });
});
