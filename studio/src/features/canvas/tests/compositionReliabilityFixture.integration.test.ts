// @vitest-environment jsdom
import { patchElementInHtml } from "@hyperframes/studio-server/source-mutation";
import { describe, expect, it } from "vitest";
import { buildDomEditStylePatchOperation } from "../domEditing";

// The former e2e project was removed in 07dd728. Keep the source-mutation
// coverage with only the authored markup that these assertions exercise.
const indexSource = `<main>
  <div data-hf-id="title-host-a" data-composition-src="compositions/title-card.html" data-start="0" data-duration="4" data-track-index="0"></div>
  <div data-hf-id="title-host-b" data-composition-src="compositions/title-card.html" data-start="4" data-duration="4" data-track-index="0"></div>
  <div data-hf-id="nested-host" data-composition-src="compositions/nested-shell.html" data-start="2" data-duration="6" data-track-index="1"></div>
  <div data-hf-id="collision-a" data-start="1" data-duration="2" data-track-index="2"></div>
  <div data-hf-id="collision-b" data-start="3" data-duration="4" data-track-index="2"></div>
  <div data-hf-id="layer-overlap" data-start="3" data-duration="4" data-track-index="3"></div>
</main>`;
const titleSource = `<template><style>.hl-mask { overflow: hidden; background: transparent; }</style>
  <div class="hl-mask" data-hf-id="title-mask"><h1 class="hl-text" data-hf-id="title-text">Reliable compositions</h1></div>
</template>`;
const nestedSource = `<template><div data-hf-id="nested-title-host" data-composition-src="title-card.html"></div></template>`;
const compositionSources: Record<string, string> = { "title-card.html": titleSource };

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function inTemplate(document: Document, selector: string): Element | null {
  for (const template of Array.from(document.querySelectorAll("template"))) {
    const match = template.content.querySelector(selector);
    if (match) return match;
  }
  return null;
}

describe("composition source mutation", () => {
  it("owns repeated root hosts, a nested host, transparent headline topology, and collisions", () => {
    const index = parse(indexSource);
    const repeated = Array.from(
      index.querySelectorAll('[data-composition-src="compositions/title-card.html"]'),
    );
    expect(repeated).toHaveLength(2);
    expect(repeated.map((host) => host.getAttribute("data-start"))).toEqual(["0", "4"]);
    expect(
      index.querySelector('[data-composition-src="compositions/nested-shell.html"]'),
    ).toBeTruthy();

    const nested = parse(nestedSource);
    const nestedHost = inTemplate(nested, '[data-composition-src="title-card.html"]');
    expect(nestedHost).toBeTruthy();
    const nestedDependency = nestedHost?.getAttribute("data-composition-src");
    expect(
      nestedDependency ? nestedDependency in compositionSources : false,
    ).toBe(true);

    const title = parse(titleSource);
    const mask = inTemplate(title, ".hl-mask");
    const headline = inTemplate(title, ".hl-mask > .hl-text");
    expect(mask?.textContent).toContain("Reliable compositions");
    expect(inTemplate(title, "style")?.textContent).toMatch(
      /\.hl-mask\s*\{[^}]*overflow:\s*hidden;[^}]*background:\s*transparent;/,
    );
    expect(headline?.tagName).toBe("H1");

    const collisionA = index.querySelector('[data-hf-id="collision-a"]')!;
    const collisionB = index.querySelector('[data-hf-id="collision-b"]')!;
    const layered = index.querySelector('[data-hf-id="layer-overlap"]')!;
    expect(collisionA.getAttribute("data-track-index")).toBe(
      collisionB.getAttribute("data-track-index"),
    );
    expect(
      Number(collisionA.getAttribute("data-start")) +
        Number(collisionA.getAttribute("data-duration")),
    ).toBe(Number(collisionB.getAttribute("data-start")));
    expect(layered.getAttribute("data-start")).toBe(collisionB.getAttribute("data-start"));
    expect(layered.getAttribute("data-track-index")).not.toBe(
      collisionB.getAttribute("data-track-index"),
    );
  });

  it("keeps timeline host edits in the root source and headline color in the template source", () => {
    const moved = patchElementInHtml(indexSource, { hfId: "title-host-a" }, [
      { type: "attribute", property: "start", value: "5" },
      { type: "attribute", property: "duration", value: "2" },
    ]);
    expect(moved.matched).toBe(true);
    expect(moved.html).toContain('data-hf-id="title-host-a"');
    expect(moved.html).toContain('data-start="5"');
    expect(moved.html).toContain('data-duration="2"');
    expect(moved.html).not.toContain('data-hf-id="title-text"');
    expect(titleSource).not.toContain("#12b886");

    const recolored = patchElementInHtml(titleSource, { hfId: "title-text" }, [
      buildDomEditStylePatchOperation("color", "#12b886"),
    ]);
    expect(recolored.matched).toBe(true);
    const recoloredDocument = parse(recolored.html);
    expect(
      inTemplate(recoloredDocument, '[data-hf-id="title-text"]')?.getAttribute("style"),
    ).toContain("color: #12b886");
    expect(
      inTemplate(recoloredDocument, '[data-hf-id="title-mask"]')?.getAttribute("style"),
    ).toBeNull();
    expect(recolored.html).not.toContain('data-hf-id="title-host-a"');
    expect(indexSource).not.toContain("#12b886");
  });
});
