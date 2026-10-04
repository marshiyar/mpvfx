import { parseHTML } from "linkedom";
import { NATIVE_PROJECT_DOCUMENT_PATH, parseNativeProjectDocument, serializeNativeProjectDocument, type NativeProjectAsset, type NativeProjectClip, type NativeProjectDocument, type NativeProjectTrack } from "../../../shared/project/nativeProjectDocument";
import { projectFrameFromSeconds } from "../../../shared/project/nativePropertyEditPlan";
import { sourceFrameValue } from "../../../shared/project/nativeSourceTime";
import { encodeMediaPath } from "../../../shared/media/mediaUrl";
import { generateId } from "../../lib/generateId";
import { collectHtmlIds } from "../../lib/studioHelpers";
import { deduplicateIds, insertAsSibling, type ClipboardPayload } from "./clipboardPayload";
import { extendCompositionDurationIfNeeded, insertTimelineAssetIntoSource, resolveTimelineAssetSrc } from "../timeline/timelineAssetDrop";
import { serializeStudioFileMutations } from "../history/studioFileMutationCoordinator";
import { commitNativeTimelineFileSnapshots } from "../project/nativeTimelineTransactionCommit";
import { stabilizeNativeBindingSource } from "../project/nativeBindingSource";
import type { RecordEditInput } from "../history/studioFileHistory";
import type { UseProjectAnimatedPropertyCommitOptions } from "../animation/useProjectAnimatedPropertyCommit";

type Editing = Omit<UseProjectAnimatedPropertyCommitOptions, "legacyCommitProperties">;

function rebaseCopiedUrls(nodes: readonly Element[], sourceFile: string, targetFile: string): void {
  if (sourceFile === targetFile) return;
  const base = new URL(encodeMediaPath(sourceFile), "mpvfx://editor/project/");
  const rebase = (value: string): string => {
    if (!value || /^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(value)) return value;
    const url = new URL(value, base);
    if (!url.pathname.startsWith("/project/")) throw new Error("A copied media URL escapes its project");
    return resolveTimelineAssetSrc(targetFile, decodeURIComponent(url.pathname.slice("/project/".length))) + url.search + url.hash;
  };
  for (const node of nodes) {
    for (const attribute of ["src", "href", "poster", "data-composition-src"]) {
      const value = node.getAttribute(attribute);
      if (value !== null) node.setAttribute(attribute, rebase(value));
    }
    const style = node.getAttribute("style");
    if (style) node.setAttribute("style", style.replace(/url\(\s*(['"]?)([^'"()]+)\1\s*\)/g,
      (_match, quote: string, value: string) => `url(${quote}${rebase(value.trim())}${quote})`));
  }
}
export interface NativeClipboardSnapshot {
  workspaceProjectId: string;
  projectId: string;
  frameRate: NativeProjectDocument["frameRate"];
  entries: Array<{ nodeIndex: number; clip: NativeProjectClip; asset: NativeProjectAsset; track: Omit<NativeProjectTrack, "clips"> }>;
}

/** Copy captures native data now so cut/paste also preserves deleted keyframes. */
export function captureNativeClipboard(html: string, project: NativeProjectDocument | null, workspaceProjectId: string | null): NativeClipboardSnapshot | undefined {
  if (!project || !workspaceProjectId) return undefined;
  const { document } = parseHTML(html);
  const entries: NativeClipboardSnapshot["entries"] = [];
  const seen = new Set<string>();
  [...document.querySelectorAll("*")].forEach((node, nodeIndex) => {
    const id = node.getAttribute("data-studio-clip-id");
    if (!id) return;
    const track = project.sequence.tracks.find(candidate => candidate.clips.some(clip => clip.id === id));
    const clip = track?.clips.find(candidate => candidate.id === id);
    const asset = project.assets.find(candidate => candidate.id === clip?.assetId);
    if (!track || !clip || !asset || seen.has(id)) throw new Error("The copied selection has an unresolved native identity; reload the composition before copying it");
    seen.add(id);
    const { clips: _clips, ...trackMetadata } = track;
    entries.push({ nodeIndex, clip: structuredClone(clip), asset: structuredClone(asset), track: structuredClone(trackMetadata) });
  });
  return entries.length ? { workspaceProjectId, projectId: project.id, frameRate: { ...project.frameRate }, entries } : undefined;
}

export async function pasteNativeClipboard(input: {
  payload: ClipboardPayload;
  snapshot: NativeClipboardSnapshot;
  workspaceProjectId: string;
  targetPath: string;
  playhead: number;
  editing: Editing;
  recordEdit: (entry: RecordEditInput) => Promise<void>;
}): Promise<void> {
  const { payload, snapshot, targetPath, editing } = input;
  if (snapshot.workspaceProjectId !== input.workspaceProjectId) throw new Error("This copied clip belongs to a different project. Import its media into this project first.");
  const committed = await serializeStudioFileMutations(editing.writeProjectFile, [NATIVE_PROJECT_DOCUMENT_PATH, targetPath], async () => {
    const nativeBefore = await editing.readOptionalProjectFile(NATIVE_PROJECT_DOCUMENT_PATH);
    if (!nativeBefore?.trim()) throw new Error("The destination native project is not available");
    let project = parseNativeProjectDocument(JSON.parse(nativeBefore));
    if (project.id !== snapshot.projectId) throw new Error("This copied clip belongs to a different project. Import its media into this project first.");
    if (project.frameRate.numerator !== snapshot.frameRate.numerator || project.frameRate.denominator !== snapshot.frameRate.denominator) throw new Error("The project frame rate changed after copying; copy the selection again");
    const before = await editing.readOptionalProjectFile(targetPath);
    if (before == null) throw new Error(`Missing composition ${targetPath}`);
    const stableSource = stabilizeNativeBindingSource(project, targetPath, before);
    const { document } = parseHTML(deduplicateIds(payload.html, collectHtmlIds(stableSource)));
    const nodes = [...document.querySelectorAll("*")];
    rebaseCopiedUrls(nodes, payload.sourceFile, targetPath);
    // Strip live evaluator state even from descendants without a native clip.
    for (const node of nodes) {
      node.removeAttribute("data-studio-clip-id");
      node.removeAttribute("data-studio-native-owned");
    }
    const origin = Math.min(...snapshot.entries.map(entry => entry.clip.startFrame));
    const offset = payload.kind === "timeline-clip" ? projectFrameFromSeconds(input.playhead, project.frameRate) - origin : 0;
    const secondsPerFrame = project.frameRate.denominator / project.frameRate.numerator;
    const destinations = new Map<string, NativeProjectTrack>();
    let endFrame = 0;
    for (const entry of snapshot.entries) {
      const node = nodes[entry.nodeIndex];
      if (!node) throw new Error("Copied markup no longer matches its native clips");
      const clip = structuredClone(entry.clip);
      clip.id = `native-clip:${generateId()}`;
      clip.startFrame += offset;
      const hfId = `hf-${generateId()}`;
      node.setAttribute("data-hf-id", hfId);
      node.setAttribute("data-studio-clip-id", clip.id);
      clip.binding = { sourceFile: targetPath, hfId, ...(node.id ? { domId: node.id } : {}) };
      clip.parameterTracks = clip.parameterTracks.map(track => ({ ...track, id: `native-parameter:${generateId()}`, keyframes: track.keyframes.map(key => ({ ...key, id: `native-key:${generateId()}` })) }));
      clip.effects = clip.effects.map(effect => ({ ...effect, id: `native-effect:${generateId()}` }));
      let asset = project.assets.find(candidate => candidate.id === clip.assetId);
      if (!asset) { asset = structuredClone(entry.asset); project.assets.push(asset); }
      if (asset.kind !== entry.asset.kind) throw new Error("The copied media changed type after copying");
      if (asset.source && ["video", "audio", "image"].includes(asset.kind)) {
        const tag = asset.kind === "image" ? "img" : asset.kind;
        const media = node.tagName.toLowerCase() === tag ? node : node.querySelector(tag);
        if (!media) throw new Error("The copied media element is missing");
        media.setAttribute("src", resolveTimelineAssetSrc(targetPath, asset.source));
        media.setAttribute("data-media-start", String(sourceFrameValue(clip) * secondsPerFrame));
        media.removeAttribute("data-playback-start");
        media.setAttribute("data-playback-rate", String((clip.playbackRate?.numerator ?? 1) / (clip.playbackRate?.denominator ?? 1)));
        if (clip.muted) media.setAttribute("muted", ""); else media.removeAttribute("muted");
      }
      let track = destinations.get(entry.track.id);
      if (!track) {
        const candidate = project.sequence.tracks.find(track => track.id === entry.track.id && track.kind === entry.track.kind);
        const group = snapshot.entries.filter(other => other.track.id === entry.track.id);
        const overlaps = candidate?.clips.some(existing => group.some(other => {
          const start = other.clip.startFrame + offset;
          return start < existing.startFrame + existing.durationFrames && existing.startFrame < start + other.clip.durationFrames;
        }));
        if (candidate && !overlaps) track = candidate;
        else {
          const lane = Math.max(-1, ...project.sequence.tracks.map(track => track.lane?.displayTrack ?? -1), ...project.sequence.tracks.map(track => track.lane?.authoredTrack ?? -1)) + 1;
          track = { id: `native-track:${generateId()}`, kind: entry.track.kind, lane: { authoredTrack: lane, displayTrack: lane }, clips: [] };
          project.sequence.tracks.push(track);
        }
        destinations.set(entry.track.id, track);
      }
      track.clips.push(clip);
      node.setAttribute("data-start", String(clip.startFrame * secondsPerFrame));
      node.setAttribute("data-duration", String(clip.durationFrames * secondsPerFrame));
      node.setAttribute("data-track-index", String(track.lane!.authoredTrack));
      endFrame = Math.max(endFrame, clip.startFrame + clip.durationFrames);
    }
    const pasted = document.toString();
    let after = payload.kind === "timeline-clip"
      ? insertTimelineAssetIntoSource(stableSource, pasted)
      : insertAsSibling(stableSource, pasted, payload.sourceFile === targetPath ? payload.originSelector : undefined, payload.originSelectorIndex);
    after = extendCompositionDurationIfNeeded(after, endFrame * secondsPerFrame);
    project = parseNativeProjectDocument({ ...project, revision: project.revision + 1, sequence: { ...project.sequence, ...(project.sequence.durationFrames !== undefined ? { durationFrames: Math.max(project.sequence.durationFrames, endFrame) } : {}) } });
    await commitNativeTimelineFileSnapshots({
      orderedPaths: [NATIVE_PROJECT_DOCUMENT_PATH, targetPath],
      snapshots: { [NATIVE_PROJECT_DOCUMENT_PATH]: { before: nativeBefore, after: serializeNativeProjectDocument(project) }, [targetPath]: { before, after } },
      history: { label: payload.kind === "timeline-clip" ? "Paste clip" : "Paste element", kind: "timeline" },
      commitFileTransaction: editing.commitFileTransaction, writeProjectFile: editing.writeProjectFile, recordEdit: input.recordEdit,
      rollbackFailureMessage: "Paste failed and rollback did not complete",
    });
    return project;
  });
  editing.onNativeDocumentCommitted?.(committed);
}
