import { readdirSync, readFileSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SOURCE_EXTENSIONS = new Set([".css", ".html", ".js", ".jsx", ".svg", ".ts", ".tsx"]);
const APP_SHELL_FILES = [resolve(SOURCE_ROOT, "../index.html")];

type EffectPattern = { id: string; regex: RegExp };

const DECORATIVE_EFFECT_PATTERNS: EffectPattern[] = [
  { id: "css-box-shadow", regex: /box-shadow\s*:/g },
  { id: "inline-box-shadow", regex: /\bboxShadow\s*:/g },
  { id: "css-text-shadow", regex: /text-shadow\s*:/g },
  { id: "inline-text-shadow", regex: /\btextShadow\s*:/g },
  { id: "css-drop-shadow", regex: /filter\s*:\s*drop-shadow\s*\(/g },
  { id: "css-backdrop-blur", regex: /backdrop-filter\s*:\s*[^;]*blur\s*\(/g },
  { id: "tailwind-shadow", regex: /\bshadow-(?:sm|md|lg|xl|2xl|inner|black|btn|\[)/g },
  {
    id: "tailwind-bare-shadow",
    regex: /className\s*=\s*\{?["'`][^\n]*\bshadow(?=[\s"'`])/g,
  },
  { id: "tailwind-drop-shadow", regex: /\bdrop-shadow(?:-|\b)/g },
  { id: "tailwind-backdrop-blur", regex: /\bbackdrop-blur(?:-|\b)/g },
  {
    id: "tailwind-ring-shadow",
    regex: /\b(?:[a-z-]+:)*ring-(?:0|1|2|4|8|inset|white|black|studio|panel|\[)/g,
  },
  { id: "tailwind-gradient", regex: /\bbg-gradient-to-[a-z]+\b/g },
  { id: "css-gradient", regex: /\b(?:repeating-)?(?:linear|radial|conic)-gradient\s*\(/g },
  { id: "svg-gradient", regex: /<(?:linear|radial)Gradient\b/g },
];

// Narrow exceptions preserve effect authoring and indispensable color controls
// without exempting the rest of those components from the flat-chrome policy.
const FUNCTIONAL_EFFECT_EXCEPTIONS: Record<string, ReadonlySet<string>> = {
  "inline-box-shadow": new Set([
    "captions/types.ts",
    "components/editor/domEditingElement.ts",
  ]),
  "css-gradient": new Set([
    "components/editor/InlineTextToolbar.tsx",
    "components/editor/gradientValue.ts",
    "components/editor/GridOverlay.tsx",
    "components/editor/propertyPanelColor.tsx",
    "components/editor/propertyPanelColorWheels.tsx",
  ]),
  "tailwind-gradient": new Set(["components/editor/propertyPanelColor.tsx"]),
  "svg-gradient": new Set(["components/editor/propertyPanelColorCurveGraph.tsx"]),
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!SOURCE_EXTENSIONS.has(extname(entry.name)) || entry.name.includes(".test.")) return [];
    return [path];
  });
}

describe("flat Studio chrome", () => {
  it("contains no decorative shadows or gradients", () => {
    const violations: string[] = [];
    for (const path of [...sourceFiles(SOURCE_ROOT), ...APP_SHELL_FILES]) {
      const relativePath = relative(SOURCE_ROOT, path);
      const source = readFileSync(path, "utf8");
      for (const { id, regex } of DECORATIVE_EFFECT_PATTERNS) {
        if (FUNCTIONAL_EFFECT_EXCEPTIONS[id]?.has(relativePath)) continue;
        regex.lastIndex = 0;
        for (const match of source.matchAll(regex)) {
          const line = source.slice(0, match.index).split("\n").length;
          violations.push(`${relativePath}:${line} ${match[0]}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
