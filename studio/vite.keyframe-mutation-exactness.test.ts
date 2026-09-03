import { describe, expect, it } from "vitest";
import {
  addKeyframeToScript,
  moveKeyframeInScript,
  removeKeyframeFromScript,
  resizeKeyframedTweenInScript,
  updateKeyframeInScript,
} from "@hyperframes/parsers/gsap-writer-acorn";
import {
  addKeyframeToScript as addKeyframeToScriptRecast,
  moveKeyframeInScript as moveKeyframeInScriptRecast,
  removeKeyframeFromScript as removeKeyframeFromScriptRecast,
  resizeKeyframedTweenInScript as resizeKeyframedTweenInScriptRecast,
  updateKeyframeInScript as updateKeyframeInScriptRecast,
} from "@hyperframes/parsers/gsap-parser-recast";
import { assertInstalledExactKeyframeWriter } from "./vite.keyframe-mutation-exactness";

const ANIMATION_ID = "#box-to-0-position";
const FIRST = 50;
// One 30fps output frame in a 120-second tween is 0.027777… percentage points.
const SECOND = 50.0277777778;
const THIRD = 50.0555555556;

function longTweenScript(): string {
  return `const tl = gsap.timeline();
tl.to("#box", { duration: 120, keyframes: {
  "${FIRST}%": { x: 50 },
  "${SECOND}%": { x: 51 },
  "100%": { x: 100 }
} });`;
}

describe("installed GSAP writer — output-frame exactness", () => {
  it("rejects a dev server startup when postinstall left the tolerant writer installed", () => {
    expect(() =>
      assertInstalledExactKeyframeWriter(
        () => "/node_modules/@hyperframes/parsers/package.json",
        () => "var PCT_TOLERANCE = 2;",
      ),
    ).toThrow("Exact keyframe writer patch is missing");
  });

  it("accepts every exact-writer marker installed by the durable patch", () => {
    const patchedSource = [
      "var OBJECT_ARRAY_PERCENTAGE_TOLERANCE = 0;",
      "var PCT_TOLERANCE = 0;",
      "var MOVE_NOOP_EPSILON_PCT = 0;",
      "var roundPercentage = (percentage) => percentage;",
      "bestDistance <= tolerance ? match : null;",
    ].join("\n");

    expect(() =>
      assertInstalledExactKeyframeWriter(
        () => "/node_modules/@hyperframes/parsers/package.json",
        () => patchedSource,
      ),
    ).not.toThrow();
  });

  it("adds an adjacent 30fps-frame keyframe instead of overwriting its neighbor", () => {
    const result = addKeyframeToScript(longTweenScript(), ANIMATION_ID, THIRD, { x: 52 });

    expect(result).toContain(`"${FIRST}%": { x: 50 }`);
    expect(result).toContain(`"${SECOND}%": { x: 51 }`);
    expect(result).toContain(`"${THIRD}%": { x: 52 }`);
  });

  it("keeps every adjacent source keyframe exact across a server batch", () => {
    let result = longTweenScript();
    result = updateKeyframeInScript(result, ANIMATION_ID, SECOND, { x: 151 });
    result = moveKeyframeInScript(result, ANIMATION_ID, SECOND, THIRD);
    result = resizeKeyframedTweenInScript(result, ANIMATION_ID, 0, 120, [
      { from: THIRD, to: 50.0833333333 },
    ]);
    result = removeKeyframeFromScript(result, ANIMATION_ID, 50.0833333333);

    expect(result).toContain(`"${FIRST}%": { x: 50 }`);
    expect(result).not.toContain("151");
    expect(result).not.toContain("50.0833333333%");
    expect(result).toContain('"100%": { x: 100 }');
  });

  it("keeps the default recast server writer exact for adjacent output frames", () => {
    let result = addKeyframeToScriptRecast(longTweenScript(), ANIMATION_ID, THIRD, { x: 52 });
    expect(result).toContain(`"${FIRST}%": { x: 50 }`);
    expect(result).toContain(`"${SECOND}%": { x: 51 }`);
    expect(result).toContain(`"${THIRD}%": { x: 52 }`);

    result = updateKeyframeInScriptRecast(result, ANIMATION_ID, SECOND, { x: 151 });
    result = moveKeyframeInScriptRecast(result, ANIMATION_ID, SECOND, THIRD + 0.0277777778);
    result = resizeKeyframedTweenInScriptRecast(result, ANIMATION_ID, 0, 120, [
      { from: THIRD + 0.0277777778, to: 50.1111111112 },
    ]);
    result = removeKeyframeFromScriptRecast(result, ANIMATION_ID, 50.1111111112);

    expect(result).toContain(`"${FIRST}%": { x: 50 }`);
    expect(result).toContain(`"${THIRD}%": { x: 52 }`);
    expect(result).not.toContain("151");
    expect(result).not.toContain("50.1111111112%");
  });
});
