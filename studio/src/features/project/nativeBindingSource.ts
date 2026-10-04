import { parseHTML } from "linkedom";
import type { NativeProjectDocument } from "../../../shared/project/nativeProjectDocument";
import { resolveNativeDomBinding, stabilizeNativeDomBindings } from "../../../shared/project/nativeDomBinding";
import { generateId } from "../../lib/generateId";

export function stabilizeNativeBindingSource(
  project: NativeProjectDocument, sourceFile: string, content: string,
): string {
  const { document } = parseHTML(content);
  const changed = stabilizeNativeDomBindings(project, sourceFile,
    selector => [...document.querySelectorAll(selector)], () => `hf-${generateId()}`);
  return changed ? document.toString() : content;
}

/** Structural clones must not retain the original clip's evaluator identity. */
export function synchronizeNativeBindingSource(
  project: NativeProjectDocument, sourceFile: string, content: string,
): string {
  const { document } = parseHTML(content);
  const query = (selector: string) => [...document.querySelectorAll(selector)];
  const targets = project.sequence.tracks.flatMap(track => track.clips)
    .filter(clip => clip.binding?.sourceFile === sourceFile)
    .map(clip => ({ clip, node: resolveNativeDomBinding(query, clip.binding!) }));
  const resolved = new Set<Element>();
  const ids = new Set(targets.map(({ clip }) => clip.id));
  for (const { clip, node } of targets) {
    if (!node || resolved.has(node)) throw new Error(`The edit did not preserve a unique element for clip ${clip.id} in ${sourceFile}`);
    resolved.add(node);
  }
  // A nested clone without its own native clip must not masquerade as the
  // original. Reject the draft before writing either project file.
  for (const node of query("[data-studio-clip-id]")) {
    if (ids.has(node.getAttribute("data-studio-clip-id")!) && !resolved.has(node)) {
      throw new Error("This split would duplicate a nested clip without its own native timeline entry");
    }
  }
  let changed = false;
  for (const { clip, node } of targets) {
    if (node!.getAttribute("data-studio-clip-id") !== clip.id) {
      node!.setAttribute("data-studio-clip-id", clip.id);
      changed = true;
    }
  }
  return changed ? document.toString() : content;
}
