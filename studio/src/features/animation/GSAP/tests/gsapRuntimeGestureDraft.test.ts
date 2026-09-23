// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { beginStudioManualEditGesture, endStudioManualEditGesture } from "../../../canvas/manualEdits";
import { applyPreviewSync } from "../useGsapScriptCommits";

afterEach(() => { document.body.innerHTML = ""; });

function fixture() {
  const iframe = document.body.appendChild(document.createElement("iframe"));
  const doc = iframe.contentDocument!;
  doc.body.innerHTML = '<div id="a"></div><div id="b"></div><canvas id="__hf_color_grading_b" data-hf-color-grading-canvas></canvas>';
  const a = doc.getElementById("a")!;
  const b = doc.getElementById("b")!;
  const picture = doc.getElementById("__hf_color_grading_b")!;
  b.style.transform = picture.style.transform = "translate(679px, 239px) rotate(15deg)";
  b.style.width = picture.style.width = "1300px";
  b.style.setProperty("clip-path", "inset(0px 843px 0px 0px)", "important");
  const token = beginStudioManualEditGesture(b);
  return { iframe, a, b, picture, token };
}

describe("persisted preview sync during a newer canvas gesture", () => {
  it("updates a committed global set without repainting over the active draft or its grading picture", () => {
    const { iframe, b, picture, token } = fixture();
    const set = vi.fn((target: HTMLElement, vars: Record<string, number>) => {
      target.style.transform = `translate(${vars.x}px, ${vars.y}px)`;
      picture.style.transform = target.style.transform;
      target.style.opacity = String(vars.opacity);
    });
    Object.assign(iframe.contentWindow!, { gsap: { set } });
    const reload = vi.fn();
    applyPreviewSync(iframe, { ok: true }, {
      label: "Saved earlier drag",
      instantPatch: { selector: "#b", change: { kind: "global-set", props: { x: 644, y: 217, opacity: 0.7 } } },
    }, reload);
    expect(set).toHaveBeenCalledOnce();
    expect(b.style.transform).toBe("translate(679px, 239px) rotate(15deg)");
    expect(picture.style.transform).toBe(b.style.transform);
    expect(b.style.opacity).toBe("0.7");
    expect(b.style.getPropertyPriority("clip-path")).toBe("important");
    expect(reload).not.toHaveBeenCalled();
    endStudioManualEditGesture(b, token);
    applyPreviewSync(iframe, { ok: true }, {
      label: "Finished drag",
      instantPatch: { selector: "#b", change: { kind: "global-set", props: { x: 700, y: 250 } } },
    }, reload);
    expect(b.style.transform).toBe("translate(700px, 250px)");
  });

  it("keeps another active gesture visible while committing and seeking the actual timeline", () => {
    const { iframe, a, b, picture } = fixture();
    const tween = {
      vars: { x: 0, y: 0 }, targets: () => [a], duration: () => 0,
      startTime: () => 0, invalidate: vi.fn(),
    };
    const seek = vi.fn(() => {
      a.style.transform = `translate(${tween.vars.x}px, ${tween.vars.y}px)`;
      b.style.transform = picture.style.transform = "translate(644px, 217px)";
    });
    Object.assign(iframe.contentWindow!, {
      __timelines: { "index.html": { getChildren: () => [tween], duration: () => 10, time: () => 2 } },
      __player: { getTime: () => 2, seek },
    });
    const reload = vi.fn();
    applyPreviewSync(iframe, { ok: true }, {
      label: "Saved earlier drag",
      instantPatch: { selector: "#a", change: { kind: "set", props: { x: 100, y: 50 } } },
    }, reload);
    expect(tween.vars).toEqual({ x: 100, y: 50 });
    expect(tween.invalidate).toHaveBeenCalledOnce();
    expect(seek).toHaveBeenCalledExactlyOnceWith(2);
    expect(a.style.transform).toBe("translate(100px, 50px)");
    expect(b.style.transform).toBe("translate(679px, 239px) rotate(15deg)");
    expect(picture.style.transform).toBe(b.style.transform);
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not restore a draft whose gesture token changed during the runtime update", () => {
    const { iframe, b } = fixture();
    Object.assign(iframe.contentWindow!, {
      gsap: { set: () => { beginStudioManualEditGesture(b); b.style.transform = "translate(800px, 300px)"; } },
    });
    applyPreviewSync(iframe, { ok: true }, {
      label: "Saved earlier drag",
      instantPatch: { selector: "#b", change: { kind: "global-set", props: { x: 644, y: 217 } } },
    }, vi.fn());
    expect(b.style.transform).toBe("translate(800px, 300px)");
  });
});
