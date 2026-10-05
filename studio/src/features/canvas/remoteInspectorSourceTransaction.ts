import { parseHTML } from "linkedom";
import type { PreviewElementState } from "../../../shared/preview/agentProtocol";
import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  parseNativeProjectDocument,
} from "../../../shared/project/nativeProjectDocument";
import { resolveNativeDomBinding } from "../../../shared/project/nativeDomBinding";
import { applyPatchByTarget, type PatchOperation } from "../legacy/sourcePatcher";
import { serializeStudioFileMutations } from "../history/studioFileMutationCoordinator";
import { commitNativeTimelineFileSnapshots, type CommitNativeTimelineFileTransaction } from "../project/nativeTimelineTransactionCommit";
import type { RecordEditInput } from "../history/studioFileHistory";
import { stabilizeNativeBindingSource } from "../project/nativeBindingSource";
import { remoteNativeClipId } from "./remoteNativePreviewEdit";
import { buildDomDesignResetOperations } from "./domDesignReset";
import { parseInsetClipPathSides } from "../inspector/clipPathHelpers";

export interface RemoteInspectorWriteDeps {
  readOptionalProjectFile: (path: string) => Promise<string | null | undefined>;
  writeProjectFile: (path: string, content: string, expectedContent?: string) => Promise<void>;
  recordEdit: (entry: RecordEditInput) => Promise<void>;
  commitFileTransaction?: CommitNativeTimelineFileTransaction;
}

function supportedRemoteOperation(operation: PatchOperation): boolean {
  if (operation.childSelector || operation.childIndex !== undefined) return false;
  const value = operation.value;
  if (operation.type === "text-content") {
    return operation.property === "textContent" && value !== null && value.length <= 4096;
  }
  if (operation.type === "html-attribute") {
    return ["title", "alt", "aria-label"].includes(operation.property) &&
      (value === null || (value.length <= 512 && !/[\u0000-\u001f]/.test(value)));
  }
  if (operation.type !== "inline-style") return false;
  if (!["color", "background-color", "font-size", "font-weight", "text-align",
    "border-radius", "opacity", "clip-path", "z-index"].includes(operation.property)) return false;
  if (value === null) return true;
  switch (operation.property) {
    case "color": return /^#[0-9a-f]{3,8}$/i.test(value);
    case "background-color": return /^#[0-9a-f]{3,8}$/i.test(value);
    case "font-size": return /^(?:[1-9]\d?|[1-4]\d\d|500)px$/.test(value);
    case "font-weight": return /^(?:normal|bold|[1-9]00)$/.test(value);
    case "text-align": return /^(?:left|right|center|justify|start|end)$/.test(value);
    case "border-radius": return /^(?:0|(?:\d{1,3}|1000)px)$/.test(value);
    case "opacity": {
      const opacity = Number(value);
      return value.trim() !== "" && Number.isFinite(opacity) && opacity >= 0 && opacity <= 1;
    }
    case "z-index": {
      const level = Number(value);
      return /^-?\d{1,6}$/.test(value) && Number.isSafeInteger(level) &&
        level >= -100000 && level <= 100000;
    }
    case "clip-path": {
      const sides = parseInsetClipPathSides(value);
      return sides !== null && [sides.top, sides.right, sides.bottom, sides.left]
        .every(amount => Number.isFinite(amount) && amount >= 0 && amount <= 100000);
    }
    default: return false;
  }
}

/** Authored preview data is only a locator hint. The saved clip binding owns edits. */
export async function commitRemoteInspectorSourcePatch(
  state: PreviewElementState,
  operations: readonly PatchOperation[] | "reset-design",
  label: string,
  deps: RemoteInspectorWriteDeps,
): Promise<boolean> {
  if (operations !== "reset-design" && operations.length === 0) return false;
  if (operations !== "reset-design" && !operations.every(supportedRemoteOperation)) {
    throw new Error("The requested inspector edit is not supported for an isolated preview");
  }
  const clipId = remoteNativeClipId(state);
  if (!clipId) throw new Error("The preview element has no native clip identity");
  return serializeStudioFileMutations(deps.writeProjectFile, [NATIVE_PROJECT_DOCUMENT_PATH, state.sourceFile], async () => {
    const nativeContent = await deps.readOptionalProjectFile(NATIVE_PROJECT_DOCUMENT_PATH);
    if (!nativeContent?.trim()) throw new Error("The native project is unavailable");
    const project = parseNativeProjectDocument(JSON.parse(nativeContent));
    const matches = project.sequence.tracks.flatMap(track => track.clips).filter(clip => clip.id === clipId);
    if (matches.length !== 1) throw new Error("The selected native clip is no longer unique");
    const binding = matches[0]!.binding;
    if (!binding?.domId && !binding?.hfId) {
      throw new Error("The selected native clip needs a stable source identity before inspector editing");
    }
    if (!binding || binding.sourceFile !== state.sourceFile ||
        (binding.domId && state.id !== binding.domId) ||
        (binding.hfId && state.dataAttributes["hf-id"] !== binding.hfId)) {
      throw new Error("The selected preview element no longer matches its saved source binding");
    }
    const sourceFile = binding.sourceFile;
    const before = await deps.readOptionalProjectFile(sourceFile);
    if (before == null) throw new Error(`Missing composition ${sourceFile}`);
    let after = stabilizeNativeBindingSource(project, sourceFile, before);
    const query = (html: string) => {
      const { document } = parseHTML(html);
      return resolveNativeDomBinding(selector => [...document.querySelectorAll(selector)], binding);
    };
    const sourceNode = query(after);
    if (!sourceNode) throw new Error("The saved clip cannot be resolved uniquely");
    const edits = operations === "reset-design"
      ? buildDomDesignResetOperations(sourceNode as HTMLElement)
      : operations;
    if (edits.length === 0) return false;
    if (edits.some(operation => operation.type === "text-content") &&
        (!state.textEditable || sourceNode.children.length !== 0 ||
          (sourceNode.textContent?.length ?? 0) > 256)) {
      throw new Error("The saved source is not a plain-text leaf");
    }
    const target = { id: binding.domId, hfId: binding.hfId, selector: binding.selector,
      selectorIndex: binding.selectorIndex };
    for (const operation of edits) {
      const patched = applyPatchByTarget(after, target, operation);
      if (patched === after) throw new Error("The saved source did not accept the inspector edit");
      after = patched;
    }
    if (!query(after)) throw new Error("The inspector edit changed the clip identity");
    await commitNativeTimelineFileSnapshots({
      orderedPaths: [sourceFile],
      snapshots: { [sourceFile]: { before, after } },
      history: { kind: "manual", label },
      commitFileTransaction: deps.commitFileTransaction,
      writeProjectFile: deps.writeProjectFile,
      recordEdit: deps.recordEdit,
      rollbackFailureMessage: "The inspector edit failed and rollback did not complete",
    });
    return true;
  });
}
