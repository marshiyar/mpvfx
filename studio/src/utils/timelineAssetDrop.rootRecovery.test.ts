// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { insertTimelineAssetIntoSource } from "./timelineAssetDrop";

const PAUSED_TIMELINE = `
  <script>
    window.__timelines = window.__timelines || {};
    window.__timelines["main"] = gsap.timeline({ paused: true });
  </script>`;

describe("timeline media-drop root recovery", () => {
  it("restores a missing structural root when the composition still owns its paused timeline", () => {
    const source = `<!doctype html><html><head>
      <meta name="viewport" content="width=1920, height=1080">
    </head><body>${PAUSED_TIMELINE}</body></html>`;

    const result = insertTimelineAssetIntoSource(
      source,
      '<video id="camera" src="camera.mov"></video>',
    );
    const document = new DOMParser().parseFromString(result, "text/html");
    const root = document.querySelector('[data-composition-id="main"]');

    expect(root).not.toBeNull();
    expect(root).toMatchObject({ id: "root" });
    expect(root?.getAttribute("data-width")).toBe("1920");
    expect(root?.getAttribute("data-height")).toBe("1080");
    expect(root?.querySelector("video#camera")?.getAttribute("src")).toBe("camera.mov");
    expect(result).toContain(PAUSED_TIMELINE);
  });

  it("ignores root-looking text in comments and scripts", () => {
    const source = `<!doctype html><html><body>
      <!-- <div data-composition-id="fake-comment"></div> -->
      <script>
        const example = '<div data-composition-id="fake-script"></div>';
        window.__timelines["main"] = gsap.timeline({ paused: true });
      </script>
    </body></html>`;

    const result = insertTimelineAssetIntoSource(source, '<img id="poster" src="poster.png" />');
    const document = new DOMParser().parseFromString(result, "text/html");

    expect(document.querySelector('[data-composition-id="main"] #poster')).not.toBeNull();
    expect(document.querySelector('[data-composition-id="fake-comment"]')).toBeNull();
    expect(document.querySelector('[data-composition-id="fake-script"]')).toBeNull();
  });

  it("accepts an unquoted root id and inserts under the real root after inert examples", () => {
    const source = `<!doctype html><html><body>
      <template><div data-composition-id="template-example"></div></template>
      <main id="real" data-composition-id=main data-duration="5"></main>
    </body></html>`;

    const result = insertTimelineAssetIntoSource(source, '<audio id="voice"></audio>');
    const document = new DOMParser().parseFromString(result, "text/html");

    expect(document.querySelector("main#real > audio#voice")).not.toBeNull();
    expect(document.querySelector("template")?.content.querySelector("#voice")).toBeNull();
  });

  it("continues to reject a document with neither a root nor a paused composition timeline", () => {
    expect(() =>
      insertTimelineAssetIntoSource(
        "<!doctype html><html><body><p>Not a composition</p></body></html>",
        '<video id="clip"></video>',
      ),
    ).toThrow("missing its root");
  });

  it.each([
    `const example = 'window.__timelines["main"] = gsap.timeline({ paused: true })';`,
    `// window.__timelines["main"] = gsap.timeline({ paused: true })`,
    `/* window.__timelines["main"] = gsap.timeline({ paused: true }) */`,
    "const example = `window.__timelines[\"main\"] = gsap.timeline({ paused: true })`;",
    `const example = /window.__timelines["main"] = gsap.timeline({ paused: true })/;`,
    `function example() { return /window.__timelines["main"] = gsap.timeline({ paused: true })/; }`,
  ])("does not trust timeline-looking JavaScript text: %s", (script) => {
    const source = `<!doctype html><html><body><script>${script}</script></body></html>`;
    expect(() => insertTimelineAssetIntoSource(source, '<video id="clip"></video>')).toThrow(
      "missing its root",
    );
  });

  it.each([
    '<script type="application/json">window.__timelines["main"] = gsap.timeline({ paused: true })</script>',
    '<script src="timeline.js">window.__timelines["main"] = gsap.timeline({ paused: true })</script>',
  ])("does not recover from non-executable script content: %s", (script) => {
    const source = `<!doctype html><html><body>${script}</body></html>`;
    expect(() => insertTimelineAssetIntoSource(source, '<video id="clip"></video>')).toThrow(
      "missing its root",
    );
  });

  it("does not borrow paused:true from a later, unrelated call", () => {
    const source = `<!doctype html><html><body><script>
      window.__timelines["main"] = gsap.timeline({});
      describeTimeline({ paused: true });
    </script></body></html>`;
    expect(() => insertTimelineAssetIntoSource(source, '<video id="clip"></video>')).toThrow(
      "missing its root",
    );
  });

  it.each([
    `window.__timelines["main"] = gsap.timeline({ paused: true && false });`,
    `window.__timelines["main"] = gsap.timeline({ paused: true, paused: false });`,
    `window.__timelines["main"] = gsap.timeline({ paused: true, ...runtimeOptions });`,
    `window.__timelines["main"] = gsap.timeline({ delay: false ? paused : true });`,
    `window.__timelines["main"] = gsap.timeline({ paused: true, ["pau" + "sed"]: false });`,
    `window.__timelines["main"] = gsap.timeline({ paused: true, get paused() { return false; } });`,
    `window.__timelines["main"] = gsap.timeline({ paused: true, set paused(value) {} });`,
    `window.__timelines["main"] = gsap.timeline({ paused: true, async paused() { return false; } });`,
  ])("requires one unoverridden literal paused:true option: %s", (script) => {
    const source = `<!doctype html><html><body><script>${script}</script></body></html>`;
    expect(() => insertTimelineAssetIntoSource(source, '<video id="clip"></video>')).toThrow(
      "missing its root",
    );
  });

  it("rejects ambiguous recovery when more than one paused timeline is registered", () => {
    const source = `<!doctype html><html><body><script>
      window.__timelines["main"] = gsap.timeline({ paused: true });
      window.__timelines["other"] = gsap.timeline({ paused: true });
    </script></body></html>`;
    expect(() => insertTimelineAssetIntoSource(source, '<video id="clip"></video>')).toThrow(
      "missing its root",
    );
  });
});
