import { NATIVE_PROJECT_DOCUMENT_PATH, parseNativeProjectDocument } from "../../../shared/project/nativeProjectDocument";
import { resolveNativeClipSelection, type NativeSelectedElementReference } from "../../../shared/project/nativePropertyEditPlan";
import { NativeProjectRevisionConflictError } from "./nativeProjectPersistence";

/** Discover locks from saved clip bindings, not optional timeline-row metadata.
 * Transactions re-read, re-plan and compare these paths under the locks.
 */
export async function discoverNativeTimelineSources(input: {
  expectedRevision: number;
  readOptionalProjectFile(path: string): Promise<string | null | undefined>;
  signal?: AbortSignal;
}, elements: readonly NativeSelectedElementReference[]) {
  input.signal?.throwIfAborted();
  const source = await input.readOptionalProjectFile(NATIVE_PROJECT_DOCUMENT_PATH);
  input.signal?.throwIfAborted();
  if (!source?.trim()) return { ok: false as const, reason: "missing-native-project" as const };
  const document = parseNativeProjectDocument(JSON.parse(source));
  if (document.revision !== input.expectedRevision)
    throw new NativeProjectRevisionConflictError(input.expectedRevision, document.revision);
  const paths = new Set<string>();
  for (const element of elements) {
    const match = resolveNativeClipSelection(document, element);
    if (!match.ok) {
      const code = match.failure.code;
      const reason: "missing-selection-id" | "ambiguous-clip" | "clip-not-found" = code === "missing-selection-id" || code === "ambiguous-clip" ? code : "clip-not-found";
      return { ok: false as const, reason };
    }
    const binding = match.located.clip.binding;
    if (binding) paths.add(binding.sourceFile);
  }
  return { ok: true as const, sourceFiles: [...paths].sort() };
}
