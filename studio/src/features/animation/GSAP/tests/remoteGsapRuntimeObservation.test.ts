// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { gsap } from "gsap";
import { MotionPathPlugin } from "gsap/MotionPathPlugin.js";
import type { PreviewElementState } from "../../../../../shared/preview/agentProtocol";
import { readPreviewGsapObservation } from "../../../preview/gsapObservation";
import { loadRemoteGsapTargets } from "../remoteGsapSourceTransaction";

afterEach(() => {
  gsap.globalTimeline.clear();
  document.body.innerHTML = "";
});

describe("bounded GSAP observation on real keyframed runtime", () => {
  it("matches a real MotionPathPlugin tween to its literal source points", async () => {
    gsap.registerPlugin(MotionPathPlugin);
    const source = '<!doctype html><html><body><main data-composition-id="main"><div id="one" data-hf-id="hf-one"></div></main><script>const tl=gsap.timeline({paused:true});window.__timelines=window.__timelines||{};window.__timelines.main=tl;tl.to("#one",{duration:2,motionPath:{path:[{x:0,y:0},{x:20,y:30},{x:40,y:0}],curviness:1,autoRotate:false}},0);</script></body></html>';
    document.body.innerHTML = '<main data-composition-id="main"><div id="one" data-hf-id="hf-one"></div></main>';
    const element = document.getElementById("one")!;
    const timeline = gsap.timeline({ paused: true });
    timeline.to(element, { duration: 2, motionPath: {
      path: [{ x: 0, y: 0 }, { x: 20, y: 30 }, { x: 40, y: 0 }],
      curviness: 1, autoRotate: false,
    } }, 0);
    const view = window as Window & { gsap?: typeof gsap; __timelines?: Record<string, typeof timeline> };
    view.gsap = gsap;
    view.__timelines = { main: timeline };
    const observed = readPreviewGsapObservation({ view, element, handle: "e1",
      sourceFile: "index.html", compositionPath: "index.html", requestedChannels: ["x", "y"] });
    expect(observed.tweens).toMatchObject([{ complete: true,
      motionPath: { points: [{ x: 0, y: 0 }, { x: 20, y: 30 }, { x: 40, y: 0 }] } }]);
    const state = { handle: "e1", id: "one", sourceFile: "index.html", compositionPath: "index.html",
      dataAttributes: { "hf-id": "hf-one" } } as PreviewElementState;
    expect((await loadRemoteGsapTargets(state, observed, {
      expectedSourceFile: "index.html", readOptionalProjectFile: async () => source,
    }))[0]?.motionPath?.points).toHaveLength(3);
    delete view.gsap;
    delete view.__timelines;
  });

  it("marks a path with unmodeled plugin settings incomplete", () => {
    document.body.innerHTML = '<div id="one"></div>';
    const element = document.getElementById("one")!;
    const view = window as Window & { __timelines?: Record<string, unknown> };
    view.__timelines = { main: { time: () => 0, getChildren: () => [{
      targets: () => [element], startTime: () => 0, duration: () => 2,
      vars: { motionPath: { path: [{ x: 0, y: 0 }, { x: 40, y: 0 }],
        align: "self" } },
    }] } };
    expect(readPreviewGsapObservation({ view, element, handle: "e1",
      sourceFile: "index.html", compositionPath: "index.html", requestedChannels: ["x"] })
      .tweens[0]?.complete).toBe(false);
    delete view.__timelines;
  });

  it.each(["from", "fromTo"] as const)("matches a real %s tween without trusting editor DOM", async method => {
    const call = method === "from"
      ? 'tl.from("#one",{x:40,duration:2,ease:"power2.in"},0);'
      : 'tl.fromTo("#one",{x:10},{x:40,duration:2,ease:"power2.in"},0);';
    const source = `<!doctype html><html><body><main data-composition-id="main"><div id="one" data-hf-id="hf-one"></div></main><script>const tl=gsap.timeline({paused:true});window.__timelines=window.__timelines||{};window.__timelines.main=tl;${call}</script></body></html>`;
    document.body.innerHTML = '<main data-composition-id="main"><div id="one" data-hf-id="hf-one"></div></main>';
    const element = document.getElementById("one")!;
    const timeline = gsap.timeline({ paused: true });
    if (method === "from") timeline.from(element, { x: 40, duration: 2, ease: "power2.in" }, 0);
    else timeline.fromTo(element, { x: 10 }, { x: 40, duration: 2, ease: "power2.in" }, 0);
    const view = window as Window & { gsap?: typeof gsap; __timelines?: Record<string, typeof timeline> };
    view.gsap = gsap;
    view.__timelines = { main: timeline };
    const observed = readPreviewGsapObservation({ view, element, handle: "e1",
      sourceFile: "index.html", compositionPath: "index.html", requestedChannels: ["x"] });
    expect(observed.tweens).toMatchObject([{ complete: true, method,
      ...(method === "fromTo" ? { fromProperties: { x: 10 } } : {}) }]);
    const state = { handle: "e1", id: "one", sourceFile: "index.html", compositionPath: "index.html",
      dataAttributes: { "hf-id": "hf-one" } } as PreviewElementState;
    const targets = await loadRemoteGsapTargets(state, observed, {
      expectedSourceFile: "index.html", readOptionalProjectFile: async () => source,
    });
    expect(targets).toMatchObject([{ method, properties: { x: 40 }, ease: "power2.in",
      ...(method === "fromTo" ? { fromProperties: { x: 10 } } : {}) }]);
    timeline.seek(1);
    expect(Number(gsap.getProperty(element, "x"))).toBeCloseTo(method === "from" ? 35 : 13.75, 5);
    delete view.gsap;
    delete view.__timelines;
  });

  it("matches literal percentage keyframes from the authored source", async () => {
    const source = '<!doctype html><html><body><main data-composition-id="main"><div id="one" data-hf-id="hf-one"></div></main><script>const tl=gsap.timeline({paused:true});window.__timelines=window.__timelines||{};window.__timelines.main=tl;tl.to("#one",{duration:2,keyframes:{"0%":{x:0},"100%":{x:40}}},0);</script></body></html>';
    document.body.innerHTML = '<main data-composition-id="main"><div id="one" data-hf-id="hf-one"></div></main>';
    const element = document.getElementById("one")!;
    const timeline = gsap.timeline({ paused: true });
    timeline.to(element, { duration: 2, keyframes: { "0%": { x: 0 }, "100%": { x: 40 } } }, 0);
    const view = window as Window & { gsap?: typeof gsap; __timelines?: Record<string, typeof timeline> };
    view.gsap = gsap;
    view.__timelines = { main: timeline };
    const observed = readPreviewGsapObservation({ view, element, handle: "e1",
      sourceFile: "index.html", compositionPath: "index.html", requestedChannels: ["x"] });
    expect(observed.tweens).toMatchObject([{ complete: true, start: 0, duration: 2,
      keyframes: [{ percentage: 0, properties: { x: 0 } },
        { percentage: 100, properties: { x: 40 } }] }]);
    const state = { handle: "e1", id: "one", sourceFile: "index.html", compositionPath: "index.html",
      dataAttributes: { "hf-id": "hf-one" } } as PreviewElementState;
    const targets = await loadRemoteGsapTargets(state, observed, {
      expectedSourceFile: "index.html", readOptionalProjectFile: async () => source,
    });
    expect(targets).toHaveLength(1);
    expect(targets[0]?.keyframes?.map(frame => frame.percentage)).toEqual([0, 100]);
  });
});
