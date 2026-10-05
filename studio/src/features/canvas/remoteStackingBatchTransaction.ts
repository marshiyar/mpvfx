import { parseHTML } from "linkedom";
import type { PreviewElementState } from "../../../shared/preview/agentProtocol";
import { NATIVE_PROJECT_DOCUMENT_PATH, parseNativeProjectDocument } from "../../../shared/project/nativeProjectDocument";
import { resolveNativeDomBinding } from "../../../shared/project/nativeDomBinding";
import { applyPatchByTarget } from "../legacy/sourcePatcher";
import { serializeStudioFileMutations } from "../history/studioFileMutationCoordinator";
import { stabilizeNativeBindingSource } from "../project/nativeBindingSource";
import { commitNativeTimelineFileSnapshots } from "../project/nativeTimelineTransactionCommit";
import { remoteNativeClipId } from "./remoteNativePreviewEdit";
import type { RemoteInspectorWriteDeps } from "./remoteInspectorSourceTransaction";

export interface RemoteStackingEntry {
  state: PreviewElementState;
  zIndex: number;
}

/** One lane gesture, including cascaded neighbours, is one durable source edit. */
export async function commitRemoteStackingBatch(
  entries: readonly RemoteStackingEntry[],
  coalesceKey: string | undefined,
  deps: RemoteInspectorWriteDeps,
): Promise<boolean> {
  if (entries.length === 0) return false;
  if (entries.length > 100 || entries.some(({ zIndex }) =>
    !Number.isSafeInteger(zIndex) || zIndex < -100000 || zIndex > 100000)) {
    throw new Error("The stacking edit exceeds its bounded range");
  }
  const paths = [...new Set(entries.map(entry => entry.state.sourceFile))].sort();
  if (paths.some(path => !path || path.length > 512 || path.startsWith("/") ||
      path.includes("\\") || path.includes("\0") || path.includes("?") || path.includes("#") ||
      !path.endsWith(".html") || path.split("/").some(part => !part || part === "." || part === ".."))) {
    throw new Error("The stacking edit has an unsafe source path");
  }
  return serializeStudioFileMutations(deps.writeProjectFile,
    [NATIVE_PROJECT_DOCUMENT_PATH, ...paths], async () => {
      const nativeContent = await deps.readOptionalProjectFile(NATIVE_PROJECT_DOCUMENT_PATH);
      if (!nativeContent?.trim()) throw new Error("The native project is unavailable");
      const project = parseNativeProjectDocument(JSON.parse(nativeContent));
      const clips = project.sequence.tracks.flatMap(track => track.clips);
      const targets = entries.map(({ state, zIndex }) => {
        const clipId = remoteNativeClipId(state);
        const matches = clips.filter(clip => clip.id === clipId);
        if (matches.length !== 1) throw new Error("The reordered clip is no longer unique");
        const binding = matches[0]!.binding;
        if (!binding || (!binding.domId && !binding.hfId) || binding.sourceFile !== state.sourceFile ||
            (binding.domId && binding.domId !== state.id) ||
            (binding.hfId && binding.hfId !== state.dataAttributes["hf-id"])) {
          throw new Error("The reordered preview element no longer matches its saved source binding");
        }
        return { state, zIndex, binding, clipId: matches[0]!.id };
      });
      if (new Set(targets.map(target => target.clipId)).size !== targets.length) {
        throw new Error("The stacking edit contains duplicate clips");
      }
      const snapshots: Record<string, { before: string; after: string }> = {};
      for (const path of paths) {
        const before = await deps.readOptionalProjectFile(path);
        if (before == null) throw new Error(`Missing composition ${path}`);
        let after = stabilizeNativeBindingSource(project, path, before);
        const fileTargets = targets.filter(target => target.binding.sourceFile === path);
        for (const target of fileTargets) {
          const query = (html: string) => {
            const { document } = parseHTML(html);
            return resolveNativeDomBinding(selector => [...document.querySelectorAll(selector)], target.binding);
          };
          if (!query(after)) throw new Error(`Cannot uniquely resolve reordered clip ${target.clipId}`);
          const patchTarget = {
            id: target.binding.domId, hfId: target.binding.hfId,
            selector: target.binding.selector, selectorIndex: target.binding.selectorIndex,
          };
          const zPatched = applyPatchByTarget(after, patchTarget, {
            type: "inline-style", property: "z-index", value: String(target.zIndex),
          });
          after = zPatched;
          if (target.state.computedStyles.position === "static") {
            after = applyPatchByTarget(after, patchTarget, {
              type: "inline-style", property: "position", value: "relative",
            });
          }
          if (!query(after)) throw new Error(`The stacking edit changed clip identity ${target.clipId}`);
        }
        if (before !== after) snapshots[path] = { before, after };
      }
      const changedPaths = Object.keys(snapshots);
      if (changedPaths.length === 0) return false;
      await commitNativeTimelineFileSnapshots({
        orderedPaths: changedPaths,
        snapshots,
        history: { kind: "manual", label: "Reorder layers", coalesceKey,
          coalesceMs: 60_000 },
        commitFileTransaction: deps.commitFileTransaction,
        writeProjectFile: deps.writeProjectFile,
        recordEdit: deps.recordEdit,
        rollbackFailureMessage: "The stacking edit failed and rollback did not complete",
      });
      return true;
    });
}
