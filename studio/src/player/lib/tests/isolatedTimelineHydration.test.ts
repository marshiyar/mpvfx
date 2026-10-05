import { describe, expect, it } from "vitest";
import type { PreviewElementState } from "../../../../shared/preview/agentProtocol";
import type { TimelineElement } from "../../store/playerStore";
import { hydrateIsolatedCompositionChildren, hydrateIsolatedTimelineElements, isolatedRootDuration } from "../isolatedTimelineHydration";
import type { ClipManifestClip } from "../playbackTypes";
import { buildExpandedElements } from "../../hooks/useExpandedTimelineElements";

const clip: TimelineElement = {
  id: "camera", key: "index.html:camera:0", tag: "video", start: 0, duration: 2, track: 5,
};
function state(id: string, tag: string, sourceFile = "index.html"): PreviewElementState {
  return {
    handle: "e1", id, tag, sourceFile, compositionPath: sourceFile,
    className: "", text: "", rect: { x: 0, y: 0, width: 100, height: 50 },
    visible: true, parent: null, selector: `#${id}`,
    dataAttributes: {}, inlineStyles: {}, computedStyles: {},
  };
}

describe("hydrateIsolatedTimelineElements", () => {
  it("keeps an authored root duration longer than its last runtime clip", () => {
    const root = { ...state("root", "main"), dataAttributes: { "composition-id": "main", duration: "44.5" } };
    const child = { ...state("last", "video"), dataAttributes: { start: "34", duration: "6" } };
    expect(isolatedRootDuration([root, child])).toBe(44.5);
    expect(isolatedRootDuration([{ ...root, dataAttributes: { "composition-id": "main" } }, child])).toBe(40);
  });
  it("restores source-scoped media, group, FX and visibility metadata", () => {
    const media = state("camera", "video");
    media.dataAttributes = {
      "hf-id": "hf-camera", "audio-group": "dialogue", hidden: "",
      "fx-chain": "fx", volume: "0.5", "timeline-role": "music",
    };
    media.computedStyles = { "z-index": "17" };
    const bus = state("dialogue", "hf-audio-group");
    bus.dataAttributes = { label: "Dialogue", volume: "0.4", hidden: "", "fx-chain": "bus-fx" };
    expect(hydrateIsolatedTimelineElements([clip], [media, bus])).toEqual([expect.objectContaining({
      id: "camera", key: "index.html#camera", domId: "camera", hfId: "hf-camera",
      sourceFile: "index.html", hidden: true, zIndex: 17, volume: 0.5,
      audioGroup: "dialogue", audioGroupLabel: "Dialogue", audioGroupVolume: 0.4,
      audioGroupHidden: true, audioGroupFxChain: "bus-fx", fxChain: "fx", timelineRole: "music",
    })]);
  });

  it("does not guess between duplicate ids or accept a path outside the project", () => {
    expect(hydrateIsolatedTimelineElements([clip], [state("camera", "video"), state("camera", "video", "other.html")])).toEqual([clip]);
    expect(hydrateIsolatedTimelineElements([clip], [state("camera", "video", "../other.html")])).toEqual([clip]);
  });
});

describe("hydrateIsolatedCompositionChildren", () => {
  it("matches a qualified manifest host to its unique DOM id, including literal filename punctuation", () => {
    const source = "compositions/scene?#1.html";
    const host = { ...state("scene", "div"), handle: "e1" };
    const inner = { ...state("", "section", source), handle: "e2", parent: "e1",
      dataAttributes: { "hf-inner-root": "" } };
    const title = { ...state("title-card", "div", source), handle: "e3", parent: "e2" };
    const clips = [{ kind: "composition", id: `${source}#scene`, compositionSrc: source }] as ClipManifestClip[];
    const nested = hydrateIsolatedCompositionChildren(clips, [host, inner, title]);
    expect(nested.parentMap.get("title-card")).toBe("scene");
    expect(nested.domChildren).toEqual([expect.objectContaining({ id: "title-card", hostId: "scene" })]);
    const hostElement: TimelineElement = { id: `${source}#scene`, key: "index.html:scene:0", tag: "div",
      start: 0, duration: 4, track: 0, compositionSrc: source };
    expect(hydrateIsolatedTimelineElements([hostElement], [host])[0]).toMatchObject({
      domId: "scene", key: "index.html#scene",
    });
  });

  it("restores nested display rows, parent links, hidden state and group bus metadata", () => {
    const host = { ...state("scene", "div"), handle: "e1" };
    const inner = { ...state("", "section", "scene.html"), handle: "e2", parent: "e1",
      dataAttributes: { "hf-inner-root": "" } };
    const region = { ...state("voices", "div", "scene.html"), handle: "e3", parent: "e2",
      dataAttributes: { "hf-group": "Voices" } };
    const voice = { ...state("voice", "audio", "scene.html"), handle: "e4", parent: "e3",
      dataAttributes: { "audio-group": "bus", hidden: "", "timeline-locked": "", "fx-chain": "clip-fx" } };
    const bus = { ...state("bus", "hf-audio-group", "scene.html"), handle: "e5", parent: "e2",
      dataAttributes: { label: "Dialogue", volume: "0.4", hidden: "", "fx-chain": "bus-fx" } };
    const clips = [{ kind: "composition", id: "scene" }] as ClipManifestClip[];
    const nested = hydrateIsolatedCompositionChildren(clips, [host, inner, region, voice, bus]);
    expect(nested.parentMap.get("voices")).toBe("scene");
    expect(nested.parentMap.get("voice")).toBe("voices");
    expect(nested.domChildren.find(child => child.id === "voice")).toMatchObject({
      parentId: "voices", hostId: "scene", audioGroup: "bus", audioGroupLabel: "Dialogue",
      audioGroupVolume: 0.4, audioGroupHidden: true, audioGroupFxChain: "bus-fx",
    });
    expect(nested.hostState.get("voice")).toEqual({ hidden: true, timelineLocked: true, fxChain: "clip-fx" });
    const hostElement: TimelineElement = { id: "scene", key: "index.html#scene", domId: "scene",
      tag: "div", start: 0, duration: 5, track: 0, compositionSrc: "scene.html" };
    const expanded = buildExpandedElements([hostElement], clips, nested.parentMap,
      "scene", "voices", nested.domChildren, nested.hostState);
    expect(expanded.find(element => element.domId === "voice")).toMatchObject({
      key: "scene.html#voice", hidden: true, timelineLocked: true, audioGroup: "bus",
    });
  });

  it("leaves duplicate child IDs unresolved", () => {
    const host = { ...state("scene", "div"), handle: "e1" };
    const first = { ...state("voice", "audio", "scene.html"), handle: "e2", parent: "e1" };
    const second = { ...state("voice", "audio", "scene.html"), handle: "e3", parent: "e1" };
    const nested = hydrateIsolatedCompositionChildren(
      [{ kind: "composition", id: "scene" }] as ClipManifestClip[], [host, first, second]);
    expect(nested.parentMap.has("voice")).toBe(false);
    expect(nested.domChildren).toEqual([]);
  });

  it("bounds cyclic or duplicate-handle frame observations", () => {
    const host = { ...state("scene", "div"), handle: "e1", parent: "e2" };
    const child = { ...state("voice", "audio", "scene.html"), handle: "e2", parent: "e1" };
    const clips = [{ kind: "composition", id: "scene" }] as ClipManifestClip[];
    expect(hydrateIsolatedCompositionChildren(clips, [host, child]).parentMap.get("voice")).toBe("scene");
    expect(hydrateIsolatedCompositionChildren(clips, [host, child, { ...child, id: "other" }]))
      .toMatchObject({ domChildren: [] });
  });
});
