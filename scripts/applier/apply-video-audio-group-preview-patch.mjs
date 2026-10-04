import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(new URL("../../studio/package.json", import.meta.url));
const packagePath = require.resolve("@hyperframes/core/package.json");
const packageInfo = JSON.parse(readFileSync(packagePath, "utf8"));
if (packageInfo.version !== "0.8.20") {
  throw new Error(`Unsupported @hyperframes/core ${packageInfo.version}; video audio-group preview patch requires 0.8.20`);
}
const dist = join(dirname(packagePath), "dist");

function replaceExact(source, before, after, expectedCount, label) {
  const beforeCount = source.split(before).length - 1;
  const afterCount = source.split(after).length - 1;
  if (beforeCount === 0 && afterCount === expectedCount) return source;
  if (beforeCount !== expectedCount || afterCount !== 0) {
    throw new Error(`Unsupported core ${label}: expected ${expectedCount} original snippet(s), found ${beforeCount}`);
  }
  return source.replaceAll(before, after);
}

const groupsPath = join(dist, "audioGroups.js");
const originalGroups = readFileSync(groupsPath, "utf8");
let groups = replaceExact(
  originalGroups,
  'root.querySelectorAll(`audio[${HF_AUDIO_GROUP_ATTR}]`)',
  'root.querySelectorAll(`audio[${HF_AUDIO_GROUP_ATTR}], video[${HF_AUDIO_GROUP_ATTR}][data-has-audio="true"]`)',
  1,
  "group membership selector",
);
groups = replaceExact(
  groups,
  'if (typeof el.tagName !== "string" || el.tagName.toLowerCase() !== "audio")\n        return null;\n    if (typeof el.getAttribute !== "function")\n        return null;',
  'if (typeof el.tagName !== "string" || typeof el.getAttribute !== "function")\n        return null;\n    const tag = el.tagName.toLowerCase();\n    if (tag !== "audio" && !(tag === "video" && el.getAttribute("data-has-audio") === "true"))\n        return null;',
  1,
  "group member predicate",
);

const runtimePath = join(dist, "hyperframe.runtime.iife.js");
const inlinePath = join(dist, "generated/runtime-inline.js");
const originalRuntime = readFileSync(runtimePath, "utf8");
const originalInline = readFileSync(inlinePath, "utf8");
const lineStart = originalInline.indexOf("const RUNTIME_IIFE = ");
const lineEnd = originalInline.indexOf("\n", lineStart);
if (lineStart < 0 || lineEnd < 0) throw new Error("Unsupported core runtime-inline wrapper");
const inlineLiteral = originalInline.slice(lineStart + "const RUNTIME_IIFE = ".length, lineEnd);
if (!inlineLiteral.endsWith(";")) throw new Error("Unsupported core runtime-inline string literal");
const embeddedRuntime = JSON.parse(inlineLiteral.slice(0, -1));
if (embeddedRuntime.trimEnd() !== originalRuntime.trimEnd()) {
  throw new Error("Core IIFE and embedded runtime differ before video group patch");
}

function patchRuntime(source) {
  let result = replaceExact(
    source,
    'function Rl(e){return typeof e.tagName!="string"||e.tagName.toLowerCase()!=="audio"||typeof e.getAttribute!="function"?null:e.getAttribute(Pr)||null}',
    'function Rl(e){if(typeof e.tagName!="string"||typeof e.getAttribute!="function")return null;let t=e.tagName.toLowerCase();return t==="audio"||t==="video"&&e.getAttribute("data-has-audio")==="true"?e.getAttribute(Pr)||null:null}',
    1,
    "embedded group member predicate",
  );
  result = replaceExact(
    result,
    'document.querySelectorAll("audio[data-start]")',
    'document.querySelectorAll(\'audio[data-start], video[data-start][data-has-audio="true"]\')',
    2,
    "Web Audio scheduler discovery",
  );
  result = replaceExact(
    result,
    'd.matches("audio[data-start]")||d.querySelector("audio[data-start]")!==null',
    'd.matches(\'audio[data-start], video[data-start][data-has-audio="true"]\')||d.querySelector(\'audio[data-start], video[data-start][data-has-audio="true"]\')!==null',
    1,
    "hidden media reschedule discovery",
  );
  return result;
}

const runtime = patchRuntime(originalRuntime);
const inlineRuntime = patchRuntime(embeddedRuntime);
if (runtime.trimEnd() !== inlineRuntime.trimEnd()) {
  throw new Error("Core IIFE and embedded runtime differ after video group patch");
}
const inline = originalInline.slice(0, lineStart) +
  `const RUNTIME_IIFE = ${JSON.stringify(inlineRuntime)};` +
  originalInline.slice(lineEnd);

// Validate every target before writing any; repeated postinstall runs are safe.
if (groups !== originalGroups) writeFileSync(groupsPath, groups);
if (runtime !== originalRuntime) writeFileSync(runtimePath, runtime);
if (inline !== originalInline) writeFileSync(inlinePath, inline);
