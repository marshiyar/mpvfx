// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { captureAuthoredClips, pasteAuthoredClips } from "./authoredClipClipboard";

const source = `<!doctype html><html><head><style>#title { color: red } #title span { font-weight: bold }</style></head><body><div id="root" data-composition-id="main" data-duration="10">
<div id="title" data-hf-id="old-hf" class="clip" data-start="1" data-duration="3" data-track-index="1" style="opacity:1"><span id="child">Title</span></div>
<audio id="sound" data-start="2" data-duration="2" data-track-index="2" src="voice.wav" data-audio-automation='{"version":1,"lanes":[]}'></audio>
</div><script>const tl = gsap.timeline(); tl.to("#title", {duration:2, keyframes:{"0%":{x:0,opacity:1},"100%":{x:200,opacity:0.3,ease:"power2.in"}}},1); window.__timelines={main:tl};</script></body></html>`;
const references = [{ id: "title" }, { id: "sound" }];
describe("authored clip clipboard", () => {
  it("copies multiple authored elements, preserves timing, scripts, styles and audio attributes, and assigns independent identities", () => {
    const snapshot = captureAuthoredClips(source, references);
    const result = pasteAuthoredClips(source, snapshot, 5, "copy-one");
    const doc = new DOMParser().parseFromString(result.content, "text/html");
    const title = doc.getElementById(result.bindings[0]!.domId)!;
    const sound = doc.getElementById(result.bindings[1]!.domId)!;
    expect(title.getAttribute("data-start")).toBe("5");
    expect(sound.getAttribute("data-start")).toBe("6");
    expect(title.getAttribute("data-duration")).toBe("3");
    expect(title.getAttribute("data-track-index")).toBe("1");
    expect(title.getAttribute("style")).toBe("opacity:1");
    expect(title.getAttribute("data-hf-id")).not.toBe("old-hf");
    expect(title.querySelector("span")!.id).not.toBe("child");
    expect(sound.getAttribute("data-audio-automation")).toBe('{"version":1,"lanes":[]}');
    expect(result.content).toContain(`tl.to("#${title.id}"`);
    expect(result.content).toContain('ease:"power2.in"');
    expect(doc.querySelector("style")!.textContent).toContain(`#${title.id}`);
    expect(doc.getElementById("title")!.getAttribute("data-start")).toBe("1");
  });
  it("copies from the captured source even after the original is deleted (cut then paste)", () => {
    const snapshot = captureAuthoredClips(source, [{ id: "title" }]);
    const withoutOriginal = source.replace(/<div id="title"[\s\S]*?<\/div>/, "");
    const result = pasteAuthoredClips(withoutOriginal, snapshot, 7, "after-cut");
    expect(result.content).toContain("Title");
    expect(result.content).toContain(`#${result.bindings[0]!.domId}`);
  });
  it("does not mutate the clipboard when a pasted instance is edited or pasted repeatedly", () => {
    const snapshot = captureAuthoredClips(source, [{ id: "title" }]);
    const before = JSON.stringify(snapshot);
    const first = pasteAuthoredClips(source, snapshot, 5, "repeat");
    const second = pasteAuthoredClips(first.content, snapshot, 8, "repeat");
    expect(first.bindings[0]!.domId).not.toBe(second.bindings[0]!.domId);
    expect(JSON.stringify(snapshot)).toBe(before);
  });
  it("rejects a root, a missing element, or overlapping parent/child selection without partial copies", () => {
    expect(() => captureAuthoredClips(source, [{ id: "root" }])).toThrow();
    expect(() => captureAuthoredClips(source, [{ id: "missing" }])).toThrow();
    expect(() => captureAuthoredClips(source, [{ id: "title" }, { id: "child" }])).toThrow();
  });
  it("rejects animation expressions whose meaning cannot be transferred safely", () => {
    const dynamic = source.replace("duration:2,", "duration:2,x:()=>Math.random(),");
    expect(() => captureAuthoredClips(dynamic, [{ id: "title" }])).toThrow(/dynamic|expression/i);
  });
  it("retargets a class animation to copied nodes without animating the original", () => {
    const byClass = source.replace('"#title", {duration', '".clip", {duration');
    const snapshot = captureAuthoredClips(byClass, [{ id: "title" }]);
    const result = pasteAuthoredClips(byClass, snapshot, 5, "class-copy");
    expect(result.content).toContain(`tl.to("#${result.bindings[0]!.domId}"`);
    expect(result.content).not.toContain('tl.to(".clip"');
    expect(result.content).toContain('tl.to("#title"');
  });
  it("preserves conditional CSS rules when copying a styled title", () => {
    const conditional = source.replace(
      "#title { color: red }",
      "@media (min-width: 1px) { #title { color: red } }",
    );
    const result = pasteAuthoredClips(
      conditional,
      captureAuthoredClips(conditional, [{ id: "title" }]),
      5,
      "styled",
    );
    expect(result.content).toContain(`@media (min-width: 1px)`);
    expect(result.content).toContain(`#${result.bindings[0]!.domId}`);
  });
  it("retains the authored parent and stacking context when duplicating a grouped graphic", () => {
    const grouped = source
      .replace(
        '<div id="title"',
        '<section id="group" style="transform:scale(0.5)"><div id="title"',
      )
      .replace("</span></div>", "</span></div></section>");
    const result = pasteAuthoredClips(
      grouped,
      captureAuthoredClips(grouped, [{ id: "title" }]),
      5,
      "group",
    );
    const doc = new DOMParser().parseFromString(result.content, "text/html");
    expect(doc.getElementById(result.bindings[0]!.domId)!.parentElement!.id).toBe("group");
  });
});
