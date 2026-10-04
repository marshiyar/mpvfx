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
 * Preview may add an hf-id without writing it to the authored HTML. A native
 * bootstrap can capture that preview identity alongside an authored DOM id.
 * On the first structural edit, restore only the missing attribute on the
 * uniquely identified element. An existing, different value or any duplicate
 * remains an identity conflict rather than an invitation to guess.
 */
function missingIdentityOnExactPeer<T extends NativeBindingElement>(
  query: (selector: string) => readonly T[],
  clipId: string,
  binding: Readonly<NativeClipDomBinding>,
): { node: T; attribute: "id" | "data-hf-id"; value: string } | null {
  if (!binding.domId || !binding.hfId) return null;
  const byDomId = query("[id]").filter(node => node.getAttribute("id") === binding.domId);
  const byHfId = query("[data-hf-id]").filter(node => node.getAttribute("data-hf-id") === binding.hfId);
  let repair: { node: T; attribute: "id" | "data-hf-id"; value: string } | null = null;
  if (byDomId.length === 1 && byHfId.length === 0 && byDomId[0]!.getAttribute("data-hf-id") === null) {
    repair = { node: byDomId[0]!, attribute: "data-hf-id", value: binding.hfId };
  } else if (byHfId.length === 1 && byDomId.length === 0 && byHfId[0]!.getAttribute("id") === null) {
    repair = { node: byHfId[0]!, attribute: "id", value: binding.domId };
  }
  if (!repair) return null;
  const canonicalClaims = query("[data-studio-clip-id]")
    .filter(node => node.getAttribute("data-studio-clip-id") === clipId);
  if (canonicalClaims.length > 1 || (canonicalClaims.length === 1 && canonicalClaims[0] !== repair.node)) return null;
  const claimedClip = repair.node.getAttribute("data-studio-clip-id");
  return claimedClip === null || claimedClip === clipId ? repair : null;
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
    .map(clip => {
      const node = resolveNativeDomBinding(query, clip.binding!);
      const repair = node ? null : missingIdentityOnExactPeer(query, clip.id, clip.binding!);
      return { clip, node: node ?? repair?.node ?? null, repair };
    });
  const resolved = new Set<T>();
  for (const { clip, node } of targets) {
    if (!node || resolved.has(node)) {
      throw new Error(`Cannot resolve clip ${clip.id} uniquely in ${sourceFile}`);
    }
    resolved.add(node);
  }
  let markupChanged = false;
  for (const { clip, node, repair } of targets) {
    const binding = clip.binding!;
    if (repair) {
      node!.setAttribute(repair.attribute, repair.value);
      markupChanged = true;
    }
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
