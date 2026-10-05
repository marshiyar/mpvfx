import { lstat, readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolveNativeDomBinding, stabilizeNativeDomBindings } from "../../shared/project/nativeDomBinding";
import { resolveMovePath } from "./fileMoves";
import { join, posix } from "node:path";
import { tokenizer } from "acorn";
import { parseHTMLContent } from "@hyperframes/core/compiler";
import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  parseNativeProjectDocument,
} from "../../shared/project/nativeProjectDocument";
import type { DurableFileTransactionChange } from "./fileTransaction";
import { previewOriginForProject } from "../../shared/desktopPreviewOrigin";

export interface MediaReferencePlan {
  files: DurableFileTransactionChange[];
  dependents: string[];
}

export class MediaReferencePlanningError extends Error {
  constructor(readonly path: string, reason: string) {
    super(`Cannot safely update media references in ${path}: ${reason}`);
    this.name = "MediaReferencePlanningError";
  }
}

interface Edit { start: number; end: number; value: string }
interface ReferenceContext {
  projectId: string;
  oldPath: string;
  newPath?: string;
  owner: string;
  /** HTML <base> can change local URL resolution, but never error ownership. */
  resolutionOwner?: string | null;
  referenced: boolean;
}

// These are generated or recovery data, not the current project graph. Rewriting
// them would alter undo identities, transaction checksums, or third-party code.
const EXCLUDED_DIRECTORIES = new Set([
  ".hyperframes", ".studio", ".build", ".git", ".thumbnails", ".transcode-cache",
  "node_modules", "renders", "dist", "desktop-dist", "out",
]);
const SCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"]);

function encodedPath(path: string): string {
  return path.split("/").map(part => encodeURIComponent(part).replace(/'/g, "%27")).join("/");
}

/** Resolves an authored URL in its owner's directory, never by substring. */
function reference(value: string, context: ReferenceContext): string | null {
  const text = value.trim();
  if (!text || text.startsWith("#") || text.startsWith("//")) return null;
  const transport = /^(mpvfx:\/\/[^/?#]+)?\/api\/projects\/([^/]+)\/preview\/([^?#]+)([?#].*)?$/.exec(text);
  let path: string;
  let suffix: string;
  try {
    if (transport) {
      if (transport[1] && transport[1] !== "mpvfx://editor" &&
          transport[1] !== previewOriginForProject(context.projectId)) return null;
      if (decodeURIComponent(transport[2]) !== context.projectId) return null;
      path = decodeURIComponent(transport[3]);
      suffix = transport[4] ?? "";
    } else {
      if (/^[a-z][a-z\d+.-]*:/i.test(text) || text.startsWith("/")) return null;
      if (context.resolutionOwner === null) return null;
      const parts = /^([^?#]*)([?#].*)?$/.exec(text)!;
      path = posix.join(posix.dirname(context.resolutionOwner ?? context.owner), decodeURIComponent(parts[1]));
      suffix = parts[2] ?? "";
    }
  } catch { return null; }
  path = posix.normalize(path);
  if (path !== context.oldPath) return null;
  context.referenced = true;
  if (!context.newPath) return text;
  if (transport) {
    return `${transport[1] ?? ""}/api/projects/${transport[2]}/preview/${encodedPath(context.newPath)}${suffix}`;
  }
  let replacement = posix.relative(posix.dirname(context.resolutionOwner ?? context.owner), context.newPath);
  if (text.startsWith("./") && !replacement.startsWith(".")) replacement = `./${replacement}`;
  return encodedPath(replacement) + suffix;
}

function applyEdits(source: string, edits: Edit[]): string {
  let result = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
  }
  return result;
}

function decodeCss(value: string): string {
  return value.replace(/\\(?:([\da-f]{1,6})(?:\r\n|[\t\n\r\f ])?|([^\n\r\f]))/gi, (_, hex, character) => {
    if (!hex) return character;
    const point = Number.parseInt(hex, 16);
    return point === 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)
      ? "\ufffd" : String.fromCodePoint(point);
  });
}

function quotedEnd(source: string, start: number): number {
  const quote = source[start];
  for (let i = start + 1; i < source.length; i += 1) {
    if (source[i] === "\\") { i += 1; continue; }
    if (source[i] === quote) return i;
  }
  return source.length;
}

function cssReferences(source: string, context: ReferenceContext): string {
  const edits: Edit[] = [];
  for (let i = 0; i < source.length; i += 1) {
    if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    if (source[i] === "'" || source[i] === '"') { i = quotedEnd(source, i); continue; }
    if ((i > 0 && /[\w-]/.test(source[i - 1])) || !/^url\s*\(/i.test(source.slice(i))) continue;
    const open = i + /^url\s*\(/i.exec(source.slice(i))![0].length;
    let start = open;
    while (/\s/.test(source[start] ?? "") && start < source.length) start += 1;
    const quote = source[start] === "'" || source[start] === '"' ? source[start] : "";
    let end: number;
    if (quote) {
      end = quotedEnd(source, start);
      start += 1;
    } else {
      end = start;
      while (end < source.length && source[end] !== ")") {
        if (source[end] === "\\") end += 1;
        end += 1;
      }
    }
    const replacement = reference(decodeCss(source.slice(start, end).trim()), context);
    if (replacement !== null && context.newPath) {
      // URL path segments are percent encoded; preserve the suffix as CSS text.
      const escaped = replacement.replace(/\\/g, "\\\\").replace(/\n/g, "\\a ");
      edits.push({ start, end, value: quote ? escaped.replaceAll(quote, `\\${quote}`) : `"${escaped.replace(/"/g, '\\"')}"` });
    }
    i = end;
  }
  return applyEdits(source, edits);
}

function scriptReferences(source: string, context: ReferenceContext): void {
  // Executable code does not belong to the media-reference adapter. Detect a
  // known dependency, but never guess how to change a script's behavior.
  const hasDependency = (value: string): boolean => {
    if (reference(value, context) !== null) return true;
    // A classic script's relative URLs use its hosting document, while a module
    // may use import.meta.url. Recognize explicit project-relative literals too;
    // neither form is safe to rewrite without owning the executable operation.
    const projectContext = { ...context, resolutionOwner: "index.html" };
    if (reference(value, projectContext) === null) return false;
    context.referenced = true;
    return true;
  };
  try {
    for (const token of tokenizer(source, { ecmaVersion: "latest", allowHashBang: true })) {
      const value: unknown = Reflect.get(token, "value");
      if (typeof value === "string" && hasDependency(value) && context.newPath) {
        throw new MediaReferencePlanningError(context.owner, "an executable script refers to this media file");
      }
    }
  } catch (error) {
    if (error instanceof MediaReferencePlanningError) throw error;
    // Non-JavaScript script data and TS/JSX can have syntax Acorn does not
    // recognize. Exact quoted paths remain dependencies, never replacements.
    for (const match of source.matchAll(/(["'`])([^\n]*?)\1/g)) {
      if (hasDependency(match[2]) && context.newPath) {
        throw new MediaReferencePlanningError(context.owner, "an unsupported script refers to this media file");
      }
    }
  }
}

function decodeAttribute(value: string): string {
  return parseHTMLContent(`<span data-value="${value.replace(/"/g, "&quot;")}"></span>`)
    .querySelector("span")?.getAttribute("data-value") ?? value;
}

function escapeAttribute(value: string, quote: string): string {
  const escaped = value.replace(/&/g, "&amp;");
  if (quote === '"') return escaped.replace(/"/g, "&quot;");
  if (quote === "'") return escaped.replace(/'/g, "&#39;");
  return escaped.replace(/[\s"'`=<>]/g, character => `&#${character.charCodeAt(0)};`);
}

function srcsetReferences(value: string, context: ReferenceContext): string {
  // Commas are legal within URL tokens. A candidate URL ends at whitespace;
  // trailing commas separate candidates without a descriptor (the HTML rule).
  const edits: Edit[] = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && /[\s,]/.test(value[i])) i += 1;
    const start = i;
    while (i < value.length && !/\s/.test(value[i])) i += 1;
    let end = i;
    while (end > start && value[end - 1] === ",") end -= 1;
    if (end > start) {
      const replacement = reference(value.slice(start, end), context);
      if (replacement !== null && context.newPath) edits.push({ start, end, value: replacement });
    }
    if (end < i) continue;
    let parentheses = 0;
    while (i < value.length) {
      if (value[i] === "(") parentheses += 1;
      if (value[i] === ")") parentheses -= 1;
      if (value[i++] === "," && parentheses <= 0) break;
    }
  }
  return applyEdits(value, edits);
}

function colorGradingReference(value: string, context: ReferenceContext): string {
  if (!value.trimStart().startsWith("{")) return value; // A named grading preset.
  let grading: Record<string, unknown>;
  try { grading = JSON.parse(value); }
  catch { throw new MediaReferencePlanningError(context.owner, "color grading data is invalid"); }
  const lut = grading.lut;
  if (!lut || typeof lut !== "object" || Array.isArray(lut)) return value;
  const source: unknown = Reflect.get(lut, "src");
  if (typeof source !== "string") return value;
  const replacement = reference(source, context);
  if (replacement === null || !context.newPath) return value;
  Reflect.set(lut, "src", replacement);
  return JSON.stringify(grading);
}

function htmlReferences(source: string, context: ReferenceContext): string {
  const base = parseHTMLContent(source).querySelector("base[href]")?.getAttribute("href");
  if (base !== undefined && base !== null) {
    try {
      const prefix = `/api/projects/${encodeURIComponent(context.projectId)}/preview/`;
      const resolved = new URL(base, `${previewOriginForProject(context.projectId)}${prefix}${encodedPath(context.owner)}`);
      context.resolutionOwner = resolved.protocol === "mpvfx:" && !resolved.username && !resolved.password && !resolved.port &&
        (resolved.host === "editor" || `mpvfx://${resolved.host}` === previewOriginForProject(context.projectId)) &&
        resolved.pathname.startsWith(prefix)
        ? decodeURIComponent(resolved.pathname.slice(prefix.length)) + (resolved.pathname.endsWith("/") ? "__base__" : "")
        : null;
    } catch {
      throw new MediaReferencePlanningError(context.owner, "the document base URL is invalid");
    }
  }
  const edits: Edit[] = [];
  const tags = /<!--[^]*?-->|<![^>]*>|<\/?([a-z][\w:-]*)\b/gi;
  for (let tag = tags.exec(source); tag; tag = tags.exec(source)) {
    if (!tag[1] || source[tag.index + 1] === "/") continue;
    const name = tag[1].toLowerCase();
    let end = tags.lastIndex;
    for (; end < source.length && source[end] !== ">"; end += 1) {
      if (source[end] === '"' || source[end] === "'") {
        const quote = source[end++];
        while (end < source.length && source[end] !== quote) end += 1;
      }
    }
    if (end === source.length) break;
    const body = source.slice(tags.lastIndex, end);
    const attributes = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    for (const attribute of body.matchAll(attributes)) {
      const raw = attribute[2] ?? attribute[3] ?? attribute[4];
      if (raw === undefined) continue;
      const attributeName = attribute[1].toLowerCase();
      const quote = attribute[2] !== undefined ? '"' : attribute[3] !== undefined ? "'" : "";
      const value = decodeAttribute(raw);
      let replacement: string | null = null;
      if (["src", "poster", "href", "xlink:href"].includes(attributeName) || (name === "object" && attributeName === "data")) {
        replacement = reference(value, context);
      } else if (attributeName === "srcset" && (name === "img" || name === "source")) {
        replacement = srcsetReferences(value, context);
      } else if (attributeName === "style") {
        replacement = cssReferences(value, context);
      } else if (attributeName === "data-color-grading" && ["video", "img"].includes(name)) {
        replacement = colorGradingReference(value, context);
      } else if (attributeName.startsWith("on")) {
        scriptReferences(value, context);
      } else if (["data-src", "data-poster", "data-background"].includes(attributeName)) {
        if (reference(value, context) !== null && context.newPath) {
          throw new MediaReferencePlanningError(context.owner, `unsupported ${attributeName} reference`);
        }
      }
      if (context.newPath && replacement !== null && replacement !== value) {
        const offset = attribute[0].indexOf("=") + 1;
        const rawOffset = attribute[0].slice(offset).search(/\S/) + offset + (quote ? 1 : 0);
        const start = tags.lastIndex + attribute.index! + rawOffset;
        edits.push({ start, end: start + raw.length, value: escapeAttribute(replacement, quote) });
      }
    }
    tags.lastIndex = end + 1;
    if (["script", "style", "textarea", "title"].includes(name)) {
      const close = new RegExp(`</${name}\\s*>`, "gi");
      close.lastIndex = end + 1;
      const closing = close.exec(source);
      const contentEnd = closing?.index ?? source.length;
      const content = source.slice(end + 1, contentEnd);
      if (name === "script") scriptReferences(content, context);
      if (name === "style") {
        const value = cssReferences(content, context);
        if (value !== content) edits.push({ start: end + 1, end: contentEnd, value });
      }
      tags.lastIndex = closing ? close.lastIndex : source.length;
    }
  }
  return applyEdits(source, edits);
}

async function authoredFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(path: string) {
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const child = posix.join(path, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) await walk(child);
      } else if (entry.isFile()) {
        const extension = posix.extname(child).toLowerCase();
        if (extension === ".html" || extension === ".css" || SCRIPT_EXTENSIONS.has(extension)) files.push(child);
      }
    }
  }
  await walk("");
  return files.sort();
}

/** Legacy canvas deletion could remove HTML while leaving bound native clips.
 * Only repair a proven missing binding in an existing, readable source file.
 * Native-only clips, missing source files and uncertain selectors remain in use.
 */
async function missingCompatibilityClip(root: string, clip: ReturnType<typeof parseNativeProjectDocument>["sequence"]["tracks"][number]["clips"][number], context: ReferenceContext): Promise<boolean> {
  const binding = clip.binding;
  if (!binding) return false;
  try {
    const path = await resolveMovePath(root, binding.sourceFile);
    const source = await readFile(path, "utf8");
    const usage = { ...context, owner: binding.sourceFile, referenced: false };
    htmlReferences(source, usage);
    if (usage.referenced) return false;
    const document = parseHTMLContent(source);
    if ([...document.querySelectorAll("[id], [data-hf-id]")].some(node =>
      (binding.domId && node.getAttribute("id") === binding.domId) ||
      (binding.hfId && node.getAttribute("data-hf-id") === binding.hfId))) return false;
    if (binding.selector && document.querySelector(binding.selector)) return false;
    return Boolean(binding.domId || binding.hfId || binding.selector);
  } catch { return false; }
}

/** Plan owned reference changes without touching media, history, or any file. */
export async function planMediaReferences(input: {
  projectRoot: string;
  projectId: string;
  oldPath: string;
  newPath?: string;
  removeUsages?: boolean;
}): Promise<MediaReferencePlan> {
  const files: DurableFileTransactionChange[] = [];
  const dependents = new Set<string>();
  const removedBindings: Array<{ sourceFile: string; domId?: string; hfId?: string; selector?: string; selectorIndex?: number }> = [];
  let retainedDocument: ReturnType<typeof parseNativeProjectDocument> | undefined;
  let nativeSource: string | undefined;
  try {
    for (const path of [".studio", NATIVE_PROJECT_DOCUMENT_PATH]) {
      if ((await lstat(join(input.projectRoot, path))).isSymbolicLink()) {
        throw new MediaReferencePlanningError(NATIVE_PROJECT_DOCUMENT_PATH, "the project document cannot be a symbolic link");
      }
    }
    nativeSource = await readFile(join(input.projectRoot, NATIVE_PROJECT_DOCUMENT_PATH), "utf8");
  }
  catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (nativeSource !== undefined) {
    let document: ReturnType<typeof parseNativeProjectDocument>;
    let original: Record<string, unknown>;
    try {
      original = JSON.parse(nativeSource);
      document = parseNativeProjectDocument(original);
    } catch {
      throw new MediaReferencePlanningError(NATIVE_PROJECT_DOCUMENT_PATH, "the project document is invalid");
    }
    const context: ReferenceContext = { ...input, owner: "index.html", referenced: false };
    const rawAssets = original.assets as Array<Record<string, unknown>>;
    const matchedAssetIds = new Set<string>();
    for (let i = 0; i < document.assets.length; i += 1) {
      const source = document.assets[i].source;
      if (!source) continue;
      // Native asset sources are paths, not URLs: '?' and '#' are valid file
      // name characters here and must never be treated as transport suffixes.
      if (source === input.oldPath) {
        context.referenced = true;
        matchedAssetIds.add(document.assets[i].id);
        if (input.newPath) rawAssets[i].source = input.newPath;
      } else if (/^(?:mpvfx:\/\/editor)?\/api\/projects\//.test(source) && reference(source, context) !== null) {
        matchedAssetIds.add(document.assets[i].id);
        if (input.newPath) rawAssets[i].source = input.newPath;
      }
    }
    if (context.referenced) {
      if (!input.newPath) {
        for (const track of document.sequence.tracks) {
          const retained = [];
          for (const clip of track.clips) {
            if (!matchedAssetIds.has(clip.assetId)) { retained.push(clip); continue; }
            if (input.removeUsages) {
              if (clip.binding) removedBindings.push(clip.binding);
            } else if (!await missingCompatibilityClip(input.projectRoot, clip, context)) retained.push(clip);
          }
          track.clips = retained;
        }
      }
      const usedByClip = document.sequence.tracks.some(track =>
        track.clips.some(clip => matchedAssetIds.has(clip.assetId)),
      );
      if (input.newPath || usedByClip) dependents.add(NATIVE_PROJECT_DOCUMENT_PATH);
      if (!input.newPath && !usedByClip) {
        // The asset registry is ownership, not usage. Deleting unused media
        // removes its entry in the same undoable transaction as the archive.
        original.sequence = document.sequence;
        original.assets = rawAssets.filter(asset => !matchedAssetIds.has(asset.id as string));
        retainedDocument = document;
      }
      if ((input.newPath && input.newPath !== input.oldPath) || (!input.newPath && !usedByClip)) {
        original.revision = document.revision + 1;
        parseNativeProjectDocument(original);
        files.push({ path: NATIVE_PROJECT_DOCUMENT_PATH, expectedBefore: nativeSource, after: JSON.stringify(original, null, 2) + "\n" });
      }
    }
  }
  for (const owner of await authoredFiles(input.projectRoot)) {
    const before = await readFile(join(input.projectRoot, owner), "utf8");
    const context: ReferenceContext = { ...input, owner, referenced: false };
    const extension = posix.extname(owner).toLowerCase();
    let after = before;
    if (extension === ".html") {
      if (input.removeUsages && !input.newPath) {
        const document = parseHTMLContent(before);
        const nodes = [...document.querySelectorAll("*")];
        const bindings = removedBindings.filter(binding => binding.sourceFile === owner);
        // Resolve against the original tree once, before removing any sibling.
        const boundNodes = new Set(bindings.map(binding => resolveNativeDomBinding(
          selector => [...document.querySelectorAll(selector)], binding,
        )).filter(node => node !== null));
        let changed = retainedDocument ? stabilizeNativeDomBindings(
          retainedDocument, owner, selector => [...document.querySelectorAll(selector)], () => `hf-${randomUUID()}`,
        ) : false;
        // Resolve <base> once for the probes as well as the final reference scan.
        const resolution = { ...context };
        htmlReferences(before, resolution);
        for (const node of nodes) {
          if (node.hasAttribute("data-composition-id")) continue;
          const bound = boundNodes.has(node);
          const probe = { ...resolution, referenced: false };
          const tag = node.tagName?.toLowerCase();
          if (["video", "audio", "img", "source", "track"].includes(tag ?? "")) {
            const src = node.getAttribute("src");
            if (src) reference(src, probe);
          }
          if (bound || probe.referenced) {
            node.remove(); changed = true;
          } else if (node.hasAttribute("poster")) {
            const poster = { ...resolution, referenced: false };
            reference(node.getAttribute("poster")!, poster);
            if (poster.referenced) { node.removeAttribute("poster"); changed = true; }
          }
        }
        if (changed) after = document.toString();
      }
      after = htmlReferences(after, context);
    }
    else if (extension === ".css") after = cssReferences(before, context);
    else scriptReferences(before, context);
    if (context.referenced) dependents.add(owner);
    if (after !== before) files.push({ path: owner, expectedBefore: before, after });
  }
  if (retainedDocument) {
    const nativeChange = files.find(file => file.path === NATIVE_PROJECT_DOCUMENT_PATH);
    if (nativeChange?.after) {
      const next = JSON.parse(nativeChange.after);
      next.sequence = retainedDocument.sequence;
      parseNativeProjectDocument(next);
      nativeChange.after = JSON.stringify(next, null, 2) + "\n";
    }
  }
  return { files, dependents: [...dependents].sort() };
}
