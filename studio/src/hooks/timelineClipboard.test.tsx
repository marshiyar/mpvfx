// @vitest-environment happy-dom
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useClipboard } from "./useClipboard";
import { selectAllTimelineItems } from "./selectAllTimelineItems";
import { usePlayerStore, type TimelineElement } from "../player";
import { nativeTimelinePropertyLanesForElement } from "../player/components/nativeTimelinePropertyLaneBridge";
import { mergeTimelinePropertyLanes } from "../player/components/TimelinePropertyLanes";
import { timelineKeyframeSelectionKey } from "../player/components/timelineKeyframeIdentity";
import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  parseNativeProjectDocument,
  serializeNativeProjectDocument,
  type NativeProjectDocument,
} from "../project/nativeProjectDocument";
import type { NativeTimelineDurableCommitInput } from "../project/nativeTimelineTransactionCommit";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: (() => void)[] = [];
afterEach(() => {
  mounted.splice(0).forEach((unmount) => act(unmount));
  usePlayerStore.getState().reset();
  vi.unstubAllGlobals();
});
const element = (id: string, start = 0): TimelineElement => ({
  id,
  domId: id,
  key: `index.html#${id}`,
  sourceFile: "index.html",
  tag: "video",
  start,
  duration: 4,
  track: 0,
});
const makeDocument = () =>
  parseNativeProjectDocument({
    schemaVersion: 1,
    id: "p",
    revision: 0,
    frameRate: { numerator: 30, denominator: 1 },
    canvas: { width: 640, height: 360, background: "#000000" },
    assets: [{ id: "asset", name: "video", kind: "video", durationFrames: 600 }],
    sequence: {
      id: "s",
      name: "Main",
      tracks: [
        {
          id: "t",
          kind: "video",
          clips: ["a", "b"].map((id, i) => ({
            id,
            binding: { domId: id, sourceFile: "index.html" },
            assetId: "asset",
            startFrame: i * 30,
            durationFrames: 120,
            sourceInFrame: 0,
            muted: false,
            effects: [],
            parameterTracks: [
              {
                schemaVersion: 1,
                id: `x-${id}`,
                parameterId: "transform.position.x",
                valueType: "number",
                frameRate: { numerator: 30, denominator: 1 },
                keyframes: [
                  {
                    id: `k0-${id}`,
                    frame: 0,
                    value: 0,
                    outgoing: { type: "linear" },
                  },
                  {
                    id: `k90-${id}`,
                    frame: 90,
                    value: 100,
                    outgoing: { type: "hold" },
                  },
                ],
              },
            ],
          })),
        },
      ],
    },
  });
function keys(document: NativeProjectDocument, el = element("a")) {
  const projection = nativeTimelinePropertyLanesForElement(document, el)!;
  return mergeTimelinePropertyLanes([], projection.lanes, el.start, el.duration)
    .flatMap((l) => l.keyframes)
    .map((k) => timelineKeyframeSelectionKey(el.key!, k));
}
function harness() {
  const files = new Map<string, string>([
    [NATIVE_PROJECT_DOCUMENT_PATH, serializeNativeProjectDocument(makeDocument())],
    [
      "index.html",
      '<div data-composition-id="main" data-duration="8"><video id="a" src="v.mp4" data-start="0" data-duration="4"></video><video id="b" src="v.mp4" data-start="1" data-duration="4"></video></div>',
    ],
  ]);
  const commits: NativeTimelineDurableCommitInput[] = [];
  const showToast = vi.fn();
  const recordEdit = vi.fn(async () => undefined);
  const deleteClips = vi.fn(async (_elements: TimelineElement[]) => undefined);
  const reloadPreview = vi.fn();
  const writeProjectFile = vi.fn(async (path: string, content: string, expected?: string) => {
    if (expected !== undefined && files.get(path) !== expected)
      throw new Error("revision conflict");
    files.set(path, content);
  });
  const commitFileTransaction = vi.fn(async (input: NativeTimelineDurableCommitInput) => {
    for (const file of input.files)
      if ((files.get(file.path) ?? null) !== file.expectedBefore)
        throw new Error("revision conflict");
    for (const file of input.files) if (file.after !== null) files.set(file.path, file.after);
    commits.push(input);
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ content: files.get("index.html") }),
    })),
  );
  let api!: ReturnType<typeof useClipboard>;
  let current = makeDocument();
  function Harness() {
    const [native, setNative] = useState(makeDocument);
    current = native;
    api = useClipboard({
      projectId: "p",
      activeCompPath: "index.html",
      domEditSelectionRef: { current: null },
      previewIframeRef: { current: null },
      showToast,
      writeProjectFile,
      recordEdit,
      domEditSaveTimestampRef: { current: 0 },
      reloadPreview,
      handleTimelineElementDelete: deleteClips as never,
      handleTimelineElementsDelete: deleteClips,
      handleDomEditElementDelete: vi.fn(),
      nativeProjectEditing: {
        nativeDocument: native,
        readOptionalProjectFile: async (path) => files.get(path),
        onNativeDocumentCommitted: setNative,
        commitFileTransaction,
      },
    });
    return null;
  }
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<Harness />));
  mounted.push(() => root.unmount());
  usePlayerStore.setState({
    elements: [element("a"), element("b", 1)],
    selectedElementId: "index.html#a",
    selectedElementIds: new Set(["index.html#a"]),
    currentTime: 1,
  });
  return {
    api: () => api,
    document: () => current,
    files,
    commits,
    showToast,
    deleteClips,
    reloadPreview,
    commitFileTransaction,
  };
}

describe("timeline clipboard command routing", () => {
  it("copies the selected clips with their native curves and spacing in one transaction at the invoked playhead", async () => {
    const h = harness();
    usePlayerStore.setState({
      selectedElementIds: new Set(["index.html#a", "index.html#b"]),
      currentTime: 6,
    });
    h.api().handleCopy();
    await act(async () => {
      const pending = h.api().handlePaste();
      usePlayerStore.setState({
        currentTime: 15,
        selectedElementIds: new Set(["index.html#b"]),
        selectedElementId: "index.html#b",
      });
      await pending;
    });
    expect(h.commits).toHaveLength(1);
    expect(h.commits[0]!.files).toHaveLength(2);
    const copies = h.document().sequence.tracks[0]!.clips.filter((c) => c.id.startsWith("copy:"));
    expect(copies.map((c) => c.startFrame)).toEqual([180, 210]);
    expect(copies.every((c) => c.parameterTracks[0]!.keyframes.length === 2)).toBe(true);
    expect(h.reloadPreview).toHaveBeenCalledOnce();
    const copiedElements = copies.map((clip) =>
      element(clip.binding!.domId!, clip.startFrame / 30),
    );
    usePlayerStore.setState({
      elements: [...usePlayerStore.getState().elements, ...copiedElements],
    });
    expect(usePlayerStore.getState().selectedElementIds).toEqual(
      new Set(copiedElements.map((el) => el.key)),
    );
  });
  it("pastes keyframes only and selects the exact rendered diamonds so subsequent Delete remains scoped", async () => {
    const h = harness();
    usePlayerStore.setState({
      selectedKeyframes: new Set([keys(h.document())[0]!]),
      currentTime: 1,
    });
    h.api().handleCopy();
    await act(async () => {
      await h.api().handlePaste();
    });
    expect(h.document().sequence.tracks[0]!.clips).toHaveLength(2);
    expect(
      h.document().sequence.tracks[0]!.clips[0]!.parameterTracks[0]!.keyframes.map((k) => k.frame),
    ).toEqual([0, 30, 90]);
    const rendered = new Set(keys(h.document()));
    expect([...usePlayerStore.getState().selectedKeyframes].every((k) => rendered.has(k))).toBe(
      true,
    );
    expect(usePlayerStore.getState().selectedKeyframes.size).toBe(1);
  });
  it("selects all rendered native keys in the clip and all unlocked clips when selection is at clip scope", () => {
    const h = harness();
    usePlayerStore.setState({
      selectedKeyframes: new Set([keys(h.document())[0]!]),
    });
    selectAllTimelineItems(h.document());
    expect(usePlayerStore.getState().selectedKeyframes).toEqual(new Set(keys(h.document())));
    usePlayerStore.setState({
      selectedKeyframes: new Set(),
      elements: [element("a"), { ...element("b", 1), timelineLocked: true }],
    });
    const clearCanvas = vi.fn(() =>
      usePlayerStore.setState({ selectedElementIds: new Set(), selectedElementId: null }),
    );
    selectAllTimelineItems(h.document(), clearCanvas);
    expect(clearCanvas).toHaveBeenCalledOnce();
    expect(usePlayerStore.getState().selectedElementIds).toEqual(new Set(["index.html#a"]));
  });
  it("does not delete clips when copying their source fails during Cut", async () => {
    const h = harness();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false })),
    );
    await act(async () => {
      await h.api().handleCut();
    });
    expect(h.deleteClips).not.toHaveBeenCalled();
    expect(h.commits).toHaveLength(0);
    expect(h.showToast).toHaveBeenCalledWith(expect.stringContaining("read"), "error");
  });
  it("leaves files and the native view unchanged when the durable transaction rejects paste", async () => {
    const h = harness();
    const before = new Map(h.files);
    h.commitFileTransaction.mockRejectedValueOnce(new Error("revision conflict"));
    h.api().handleCopy();
    await act(async () => {
      await h.api().handlePaste();
    });
    expect(h.files).toEqual(before);
    expect(h.document().revision).toBe(0);
    expect(h.reloadPreview).not.toHaveBeenCalled();
    expect(h.showToast).toHaveBeenCalledWith("revision conflict", "error");
  });
});
