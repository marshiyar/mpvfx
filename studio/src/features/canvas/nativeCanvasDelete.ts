import { removeElementFromHtml } from "@hyperframes/studio-server/source-mutation";
import { NATIVE_PROJECT_DOCUMENT_PATH, parseNativeProjectDocument } from "../../../shared/project/nativeProjectDocument";
import { resolveNativeClipSelection } from "../../../shared/project/nativePropertyEditPlan";
import { commitNativeTimelineDelete } from "../project/nativeTimelineDeleteTransaction";
import type { UseProjectAnimatedPropertyCommitOptions } from "../animation/useProjectAnimatedPropertyCommit";
import type { RecordEditInput } from "../history/studioFileHistory";
import type { DomEditSelection } from "./domEditing";

/** Canvas and timeline deletion must persist the same native/HTML transaction. */
export async function deleteNativeCanvasSelection(
  selections: DomEditSelection[],
  editing: Omit<UseProjectAnimatedPropertyCommitOptions, "legacyCommitProperties"> | undefined,
  recordEdit: (entry: RecordEditInput) => Promise<void>,
): Promise<boolean> {
  if (!editing) return false;
  const source = await editing.readOptionalProjectFile(NATIVE_PROJECT_DOCUMENT_PATH);
  if (!source) return false;
  const document = parseNativeProjectDocument(JSON.parse(source));
  const targets = selections.map(selection => ({
    id: selection.id, hfId: selection.hfId, sourceFile: selection.sourceFile,
    selector: selection.selector, selectorIndex: selection.selectorIndex,
    attributes: { "data-studio-clip-id": selection.element.getAttribute("data-studio-clip-id") },
  }));
  const matches = targets.map(target => resolveNativeClipSelection(document, target));
  if (matches.every(match => !match.ok && match.failure.code === "clip-not-found")) return false;
  if (matches.some(match => !match.ok)) throw new Error("Cannot delete an unresolved native selection; refresh the preview and try again");
  const result = await commitNativeTimelineDelete({
    expectedRevision: document.revision, targets,
    readOptionalProjectFile: editing.readOptionalProjectFile,
    writeProjectFile: editing.writeProjectFile,
    recordEdit, commitFileTransaction: editing.commitFileTransaction,
    onCommitted: editing.onNativeDocumentCommitted,
    removeCompatibilityTarget: (content, { binding }) => removeElementFromHtml(content, {
      id: binding.domId, hfId: binding.hfId, selector: binding.selector, selectorIndex: binding.selectorIndex,
    }),
  });
  if (!result.committed) throw new Error(`Native canvas delete was rejected: ${result.reason}`);
  return true;
}
