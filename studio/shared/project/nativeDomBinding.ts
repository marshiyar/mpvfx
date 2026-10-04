import type { NativeClipDomBinding, NativeProjectDocument } from "./nativeProjectDocument";

export interface NativeBindingElement {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
}

/** Stable identities take precedence over a selector's transient DOM position. */
export function resolveNativeDomBinding<T extends NativeBindingElement>(
  query: (selector: string) => readonly T[],
  binding: Readonly<NativeClipDomBinding>,
): T | null {
  const identities: T[] = [];
  for (const [attribute, value] of [["id", binding.domId], ["data-hf-id", binding.hfId]]) {
    if (!value) continue;
    const matches = query(`[${attribute}]`).filter(node => node.getAttribute(attribute!) === value);
    if (matches.length !== 1) return null;
    identities.push(matches[0]!);
  }
  if (identities.length) return identities.every(node => node === identities[0]) ? identities[0]! : null;
  if (!binding.selector) return null;
  try {
    const matches = query(binding.selector);
    return binding.selectorIndex === undefined
      ? matches.length === 1 ? matches[0]! : null
      : matches[binding.selectorIndex] ?? null;
  } catch { return null; }
}

/**
 * Resolve every binding before annotating any node. Structural edits can then
 * add/remove siblings without changing the identities of surviving clips.
 * The caller commits this document and its source markup in one transaction.
 */
export function stabilizeNativeDomBindings<T extends NativeBindingElement>(
  project: NativeProjectDocument,
  sourceFile: string,
  query: (selector: string) => readonly T[],
  newIdentity: () => string,
): boolean {
  const targets = project.sequence.tracks.flatMap(track => track.clips)
    .filter(clip => clip.binding?.sourceFile === sourceFile)
    .map(clip => ({ clip, node: resolveNativeDomBinding(query, clip.binding!) }));
  const resolved = new Set<T>();
  for (const { clip, node } of targets) {
    if (!node || resolved.has(node)) {
      throw new Error(`Cannot resolve clip ${clip.id} uniquely in ${sourceFile}`);
    }
    resolved.add(node);
  }
  let markupChanged = false;
  for (const { clip, node } of targets) {
    const binding = clip.binding!;
    let hfId = binding.hfId;
    if (!hfId && !binding.domId) {
      do { hfId = newIdentity(); }
      while (query("[data-hf-id]").some(candidate => candidate.getAttribute("data-hf-id") === hfId));
      node!.setAttribute("data-hf-id", hfId);
      markupChanged = true;
    }
    clip.binding = {
      sourceFile,
      ...(binding.domId ? { domId: binding.domId } : {}),
      ...(hfId ? { hfId } : {}),
    };
  }
  return markupChanged;
}
