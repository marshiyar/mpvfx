import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { coordinateNativePreviewRuntime } from "./vite.runtime-native-picture";

const boundary = 'catch(D){L("runtime.init.transport.adapter",D)}}let Nm=';
describe("native picture after retained runtime rendering", () => {
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
