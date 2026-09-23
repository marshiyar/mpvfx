import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { coordinateNativePreviewRuntime } from "../nativePicture";

const boundary = 'catch(D){L("runtime.init.transport.adapter",D)}}let Nm=';
describe("native picture after retained runtime rendering", () => {
  it("uses changed authored opacity when redrawing a hidden graded source", () => {
    const restore = 'a&&!s&&(e.sourceInlineOpacity!==null?e.element.style.setProperty("opacity",e.sourceInlineOpacity,e.sourceInlineOpacityPriority||""):e.element.style.removeProperty("opacity"))';
    const source = `function opacity(e){let a=true,s=false;${restore};let u=window.getComputedStyle(e.element);e.sourceOpacityForCanvas=u.opacity||"1";return e.sourceOpacityForCanvas}function render(){for(let w of [])try{w.seek()}${boundary}null;return opacity;`;
    let opacity = "0";
    let authored = "0.35";
    const element = {
      hasAttribute: (name: string) => name === "data-hf-authored-opacity",
      getAttribute: (name: string) => name === "data-hf-authored-opacity" ? authored : null,
      style: { setProperty: (_name: string, value: string) => { opacity = value; }, removeProperty: () => { opacity = "1"; } },
    };
    const redraw = new Function("window", "L", coordinateNativePreviewRuntime(source))(
      { getComputedStyle: () => ({ opacity }) }, () => {},
    );
    const entry = { element, sourceInlineOpacity: "0.8", sourceInlineOpacityPriority: "" };
    expect(redraw(entry)).toBe("0.35");
    authored = "0.6";
    expect(redraw(entry)).toBe("0.6");
    authored = "";
    expect(redraw(entry)).toBe("1");
  });
  it("reapplies the authoritative frame after each legacy render, without seeking again", () => {
    const source = `function render(){legacy();for(let w of [])try{w.seek()}${boundary}null;return render;`;
    const events: string[] = [];
    const native = { reapplyFrame: vi.fn(() => events.push("native")) };
    const render = new Function("window", "legacy", "L", coordinateNativePreviewRuntime(source))(
      { __studioNativePlayer: native }, () => events.push("legacy"), () => {},
    );
    render(); render();
    expect(events).toEqual(["legacy", "native", "legacy", "native"]);
  });
  it("recognizes exactly one boundary in the installed runtime", () => {
    const require = createRequire(import.meta.url);
    const source = readFileSync(require.resolve("@hyperframes/core/runtime"), "utf8");
    expect(coordinateNativePreviewRuntime(source)).toContain("__studioNativePlayer?.reapplyFrame?.()");
    expect(source.split('e.sourceOpacityForCanvas=u.opacity||"1"')).toHaveLength(2);
    expect(coordinateNativePreviewRuntime(source)).toContain('getAttribute("data-studio-native-opacity")');
    expect(() => coordinateNativePreviewRuntime("changed runtime")).toThrow();
    expect(() => coordinateNativePreviewRuntime(boundary + boundary)).toThrow();
  });
});
