import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const studioCss = readFileSync(new URL("../../styles/studio.css", import.meta.url), "utf8");
const timelineClipSource = readFileSync(new URL("./TimelineClip.tsx", import.meta.url), "utf8");
const playheadSource = readFileSync(new URL("./PlayheadIndicator.tsx", import.meta.url), "utf8");

const allowedTimelineTransitionProperties = [
  "background-color",
  "color",
  "opacity",
];

function expectRule(css: string, selector: string): string {
  const selectorStart = css.indexOf(`${selector} {`);
  expect(selectorStart).toBeGreaterThanOrEqual(0);

  const bodyStart = css.indexOf("{", selectorStart);
  const bodyEnd = css.indexOf("}", bodyStart);
  expect(bodyStart).toBeGreaterThanOrEqual(0);
  expect(bodyEnd).toBeGreaterThan(bodyStart);

  return css.slice(bodyStart + 1, bodyEnd).trim();
}

function expectDeclaration(ruleBody: string, property: string): string {
  const declarationMatch = new RegExp(`${property}:\\s*([^;]+);`).exec(ruleBody);
  expect(declarationMatch?.[1]).toBeDefined();
  return declarationMatch?.[1].trim() ?? "";
}

function transitionProperties(transitionDeclaration: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let item = "";

  for (const char of transitionDeclaration) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      items.push(item.trim());
      item = "";
      continue;
    }
    item += char;
  }

  if (item.trim().length > 0) items.push(item.trim());

  return items.map((transition) => transition.split(/\s+/)[0]);
}

describe("timeline motion styles", () => {
  it("keeps clip motion reduced-motion gated and layout safe", () => {
    const mediaStart = studioCss.indexOf("@media (prefers-reduced-motion: no-preference)");
    expect(mediaStart).toBeGreaterThanOrEqual(0);

    const beforeMotionMedia = studioCss.slice(0, mediaStart);
    const baseTimelineClipRule = expectRule(beforeMotionMedia, ".timeline-clip");
    expect(baseTimelineClipRule).not.toContain("transition");

    const motionMediaCss = studioCss.slice(mediaStart);
    const timelineClipMotionRule = expectRule(motionMediaCss, ".timeline-clip");
    const clipTransition = expectDeclaration(timelineClipMotionRule, "transition");

    expect(transitionProperties(clipTransition)).toEqual(allowedTimelineTransitionProperties);
    expect(clipTransition).not.toMatch(/\b(?:all|left|width|top|bottom|transform)\b/);
  });

  it("keeps track strips borderless until the white selection outline is active", () => {
    const baseTimelineClipRule = expectRule(studioCss, ".timeline-clip");
    const audioTimelineClipRule = expectRule(studioCss, ".timeline-clip.is-audio");
    const selectedTimelineClipRule = expectRule(studioCss, ".timeline-clip.is-selected");

    expect(baseTimelineClipRule).toContain("background-color: rgba(255, 255, 255, 0.055)");
    expect(baseTimelineClipRule).toContain("border: 0");
    expect(audioTimelineClipRule).not.toContain("border");
    expect(selectedTimelineClipRule).toContain(
      "outline: 1.5px solid rgba(255, 255, 255, 0.85)",
    );
    expect(studioCss).not.toContain(".timeline-clip[data-active] {");
    expect(studioCss).not.toContain(".timeline-clip[data-active].is-hovered");
    expect(studioCss).not.toContain(".timeline-clip::before");
    expect(studioCss).not.toContain(".timeline-clip[data-active]::before");
    expect(studioCss).not.toContain(".timeline-clip[data-active] .timeline-clip__label");
    expect(studioCss).not.toContain(".timeline-clip__label {\n    transition:");
  });

  it("targets trim handle bars without changing drag geometry", () => {
    const handleClassMatches = timelineClipSource.match(/className="timeline-clip__handle-bar"/g);

    expect(handleClassMatches).toHaveLength(2);
    expect(timelineClipSource).toContain('transform: isDragging ? "translateY(-1px)" : undefined');
    expect(timelineClipSource).not.toContain("scale(");
  });

  it("keeps the playhead crisp and flat, without transition-driven positioning", () => {
    expect(playheadSource).not.toContain("boxShadow");
    expect(playheadSource).not.toContain("gradient");
    expect(playheadSource).toContain("rotate(45deg)");
    expect(playheadSource).not.toContain("transition");
  });
});
