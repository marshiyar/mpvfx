import type { MutableRefObject } from "react";
import type { NativeProjectDocument } from "./nativeProjectDocument";

/**
 * Adopt a document only when the authoritative session supplied a new object.
 *
 * The session already rejects stale async loads by request generation. A lower
 * revision can therefore be intentional (Undo/Redo) and must be accepted. At
 * the same time, an edit hook may publish revision N+1 before React replaces
 * its still-revision-N prop; the identity tracker prevents that unchanged old
 * object from overwriting the just-committed ref.
 */
export function synchronizeIncomingNativeDocument(
  incomingIdentityRef: MutableRefObject<NativeProjectDocument | null>,
  latestDocumentRef: MutableRefObject<NativeProjectDocument | null>,
  incoming: NativeProjectDocument | null,
): void {
  if (incomingIdentityRef.current === incoming) return;
  incomingIdentityRef.current = incoming;
  latestDocumentRef.current = incoming;
}
