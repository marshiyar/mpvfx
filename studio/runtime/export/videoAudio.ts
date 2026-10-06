import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseHTMLContent } from "@hyperframes/core/compiler";
import type { MediaMetadata } from "../../shared/media/mediaMetadata";
import { readProjectMediaMetadata } from "../media/metadata";
import { encodeMediaPath } from "../../shared/media/mediaUrl";

function within(root: string, path: string): boolean {
  const offset = relative(root, path);
  return offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset);
}

/** Local HTML URLs may be escaped, contain query strings, or be root-relative. */
async function localSource(root: string, sourceFile: string, src: string, authoredBase?: string | null): Promise<string | null> {
  const prefix = "mpvfx://editor/project/";
  const owner = new URL(encodeMediaPath(relative(root, sourceFile).split(sep).join("/")), prefix);
  const base = authoredBase ? new URL(authoredBase, owner) : owner;
  const url = new URL(src, base);
  if (url.protocol !== "mpvfx:" || url.host !== "editor" || src.trim().startsWith("#")) return null;
  let pathname = url.pathname.replace(/^\/(?:project\/|api\/projects\/[^/]+\/preview\/)?/, "");
  try { pathname = decodeURIComponent(pathname); }
  catch { throw new Error(`Export source has an invalid URL escape: ${src}`); }
  const candidate = resolve(root, pathname);
  if (!within(root, candidate)) throw new Error(`Export media is outside the project: ${src}`);
  try {
    const actual = await realpath(candidate);
    if (!within(root, actual)) throw new Error(`Export media is outside the project: ${src}`);
    if ((await stat(actual)).isFile()) return actual;
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
  throw new Error(`Export source is missing: ${src}`);
}

/**
 * Older editors marked every video as audible. Reconcile that derived hint
 * against actual streams, only in the disposable export view. Explicit audio
 * elements still undergo the producer's strict validation; no audio is invented
 * and an author's explicit mute is never undone.
 */
export async function prepareExportVideoAudio(input: {
  projectDir: string;
  entryFile: string;
  signal?: AbortSignal;
  probe?: typeof readProjectMediaMetadata;
  onComposition?: (sourceFile: string) => void;
}): Promise<ReadonlyMap<string, string>> {
  const root = await realpath(input.projectDir);
  const overrides = new Map<string, string>();
  const visited = new Set<string>();
  const metadata = new Map<string, MediaMetadata>();
  const probe = input.probe ?? readProjectMediaMetadata;
  const visit = async (file: string): Promise<void> => {
    input.signal?.throwIfAborted();
    if (visited.has(file)) return;
    visited.add(file);
    input.onComposition?.(relative(root, file).split(sep).join("/"));
    const html = await readFile(file, "utf8");
    const document = parseHTMLContent(html);
    let changed = false;
    const base = document.querySelector("base[href]")?.getAttribute("href");
    for (const video of document.querySelectorAll("video")) {
      const src = video.getAttribute("src") ||
        [...video.querySelectorAll("source")].map(source => source.getAttribute("src")).find(Boolean);
      if (!src || video.getAttribute("data-has-audio") === "false") continue;
      const path = await localSource(root, file, src, base);
      if (!path) continue;
      let facts = metadata.get(path);
      if (!facts) {
        facts = await probe(root, relative(root, path), input.signal);
        metadata.set(path, facts);
      }
      if (facts.hasVideo && (!facts.hasAudio || video.hasAttribute("muted"))) {
        video.setAttribute("data-has-audio", "false");
        changed = true;
      }
    }
    if (changed) overrides.set(relative(root, file).split(sep).join("/"), document.toString());
    for (const element of document.querySelectorAll("[data-composition-src]")) {
      const src = element.getAttribute("data-composition-src");
      if (!src) continue;
      const path = await localSource(root, file, src, base);
      if (path) await visit(path);
    }
  };
  const entry = await realpath(resolve(root, input.entryFile));
  if (!within(root, entry)) throw new Error("Export composition must be inside the project");
  await visit(entry);
  return overrides;
}
