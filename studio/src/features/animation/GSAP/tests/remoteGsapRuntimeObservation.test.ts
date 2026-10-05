// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { gsap } from "gsap";
import type { PreviewElementState } from "../../../../../shared/preview/agentProtocol";
import { readPreviewGsapObservation } from "../../../preview/gsapObservation";
import { loadRemoteGsapTargets } from "../remoteGsapSourceTransaction";

afterEach(() => {
  gsap.globalTimeline.clear();
  document.body.innerHTML = "";
});

describe("bounded GSAP observation on real keyframed runtime", () => {
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
