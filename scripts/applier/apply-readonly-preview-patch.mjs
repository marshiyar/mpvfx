import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(new URL("../../studio/package.json", import.meta.url));
const path = join(dirname(require.resolve("@hyperframes/studio-server/package.json")), "dist/index.js");
const marker = "// MpVFX: previews normalize in memory; only edit commands may persist source.";
let source = readFileSync(path, "utf8");
if (!source.includes(marker)) {
  const start = source.indexOf("function persistHfIdsIfNeeded(filePath, html) {");
  const end = source.indexOf("// src/helpers/variablesPayload.ts", start);
  const original = source.slice(start, end);
  if (start < 0 || end < 0 || !original.includes("function stampFileHfIds(filePath) {") ||
      !original.includes("writeFileSync5(filePath, normalized")) {
    throw new Error("Unsupported studio-server preview implementation; read-only patch was not applied");
  }
  source = source.slice(0, start) + `${marker}
function persistHfIdsIfNeeded(_filePath, html) {
  return ensureHfIds(html);
}
function stampFileHfIds(filePath) {
  let fd;
  try {
    fd = openSync2(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!fstatSync(fd).isFile()) return null;
    return ensureHfIds(readFileSync7(fd, "utf-8"));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync2(fd);
  }
}

` + source.slice(end);
  writeFileSync(path, source);
}

// Legacy edits must resolve the same deterministic IDs the preview displays.
// Materialize them in the mutation document, never as a preview side effect.
const parserBefore = "function parseSourceDocument(source) {";
const parserAfter = `${parserBefore}\n  source = ensureHfIds(source);`;
const targetMarker = "// MpVFX: duplicate stable IDs require independent, unique target identity.";
const safeTargetResolver = `${targetMarker}
function findByHfId(document, hfId, target) {
  const queryMatches = (selector) => {
    try {
      return querySelectorAllWithTemplates(document, selector);
    } catch {
      return [];
    }
  };
  const candidates = queryMatches(\`[data-hf-id="\${escapeCssAttrValue(hfId)}"]\`);
  if (candidates.length < 2) return candidates[0] ?? null;
  const selectors = [];
  if (target.id) selectors.push(\`[id="\${escapeCssAttrValue(target.id)}"]\`);
  if (target.selector) selectors.push(target.selector);
  for (const selector of selectors) {
    const matches = queryMatches(selector);
    if (matches.length === 1 && candidates.includes(matches[0])) return matches[0];
  }
  // Throw instead of returning null: grouping skips missing targets and would
  // otherwise commit a partial group. Batches must stop before any file write.
  const message = \`Ambiguous element "\${hfId}": \${candidates.length} elements share its identifier; a unique matching element ID or selector is required.\`;
  throw new HTTPException(422, {
    message,
    res: Response.json({ error: message }, { status: 422 })
  });
}
function findTargetElement(document, target) {
  if (target.hfId) {
    const el = findByHfId(document, target.hfId, target);
    if (el) return el;
  }
  if (target.id) {
    const byId = document.getElementById(target.id);
    if (byId) return byId;
  }
  if (!target.selector) return null;
  try {
    const matches = querySelectorAllWithTemplates(document, target.selector);
    return matches[target.selectorIndex ?? 0] ?? null;
  } catch {
    return null;
  }
}
`;
const chunks = readdirSync(dirname(path)).filter((file) => /^chunk-.*\.js$/.test(file));
let patchedParsers = 0;
for (const file of chunks) {
  const chunkPath = join(dirname(path), file);
  const chunk = readFileSync(chunkPath, "utf8");
  if (!chunk.includes(parserBefore)) continue;
  patchedParsers += 1;
  let patched = chunk.includes(parserAfter) ? chunk : chunk.replace(parserBefore, parserAfter);
  if (!patched.includes(targetMarker)) {
    const start = patched.indexOf("function findByHfId(document, hfId) {");
    const end = patched.indexOf("function removeElementFromHtml(source, target) {", start);
    const resolver = patched.slice(start, end);
    if (start < 0 || end < 0 || !resolver.includes("function findTargetElement(document, target) {") ||
        !resolver.includes("return matches[0] ?? null;") ||
        !resolver.includes("const el = findByHfId(document, target.hfId);")) {
      throw new Error("Unsupported studio-server mutation target resolver; identity safety patch was not applied");
    }
    patched = 'import { HTTPException } from "hono/http-exception";\n' +
      patched.slice(0, start) + safeTargetResolver + patched.slice(end);
  }
  if (patched !== chunk) writeFileSync(chunkPath, patched);
}
if (patchedParsers !== 1) throw new Error("Unsupported studio-server source mutation parser");
