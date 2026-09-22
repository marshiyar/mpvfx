// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { splitAuthoredClip } from "./splitAuthoredClip";
import { parseAutomation } from "@hyperframes/core/audio-automation";
describe("non-destructive authored clip splitting", () => {
  it.each(["video", "audio", "div", "img"])(
    "keeps the full authored animation on each %s half",
    (tag) => {
      const automation = {
        version: 1,
        lanes: [
          {
            target: "volume",
            points: [
              { t: 0, v: 0.2, viaX: 0.7, viaY: 0.2 },
              { t: 4, v: 1 },
            ],
          },
        ],
      };
      const html = `<html><head><style>#clip { color: red; }</style></head><body><div data-composition-id="main" data-duration="8"><${tag} id="clip" class="clip" data-start="1" data-duration="4" data-media-start="2" data-automation='${JSON.stringify(automation)}'>${tag === "div" ? '<span id="text">Title</span></div>' : tag === "img" ? "" : `</${tag}>`}</div><script>const tl=gsap.timeline(); tl.fromTo(".clip",{x:0,opacity:1},{x:200,opacity:0.2,duration:4,ease:"power2.in"},1); window.__timelines={main:tl};</script></body></html>`;
      const split = splitAuthoredClip(html, { id: "clip" }, 2.5, "right");
      const doc = new DOMParser().parseFromString(split.content, "text/html");
      const right = doc.getElementById(split.binding.domId)!;
      expect(doc.getElementById("clip")!.getAttribute("data-duration")).toBe("1.5");
      expect(right.getAttribute("data-start")).toBe("2.5");
      expect(right.getAttribute("data-duration")).toBe("2.5");
      if (["video", "audio"].includes(tag))
        expect(right.getAttribute("data-media-start")).toBe("3.5");
      else expect(right.getAttribute("data-media-start")).toBe("2");
      const script = doc.querySelector("script")!.textContent!;
      expect(script).toContain('"power2.in"');
      expect(script).toContain(`tl.fromTo("#${right.id}"`);
      expect(script).not.toContain('tl.fromTo(".clip"');
      expect(parseAutomation(right.getAttribute("data-automation")!).lanes[0]!.points).toEqual(
        automation.lanes[0]!.points.map((p) => ({ ...p, t: p.t - 1.5 })),
      );
      expect(new Set([...doc.querySelectorAll("[id]")].map((n) => n.id)).size).toBe(
        doc.querySelectorAll("[id]").length,
      );
    },
  );
});
