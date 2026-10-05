// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { TimelineElement } from "../../../player/index";
import type { NativeProjectDocument } from "../../../../shared/project/nativeProjectDocument";

const mocks = vi.hoisted(() => ({
  probeMediaUrl: vi.fn(),
  commitNativeTimelineAudio: vi.fn(),
  resolveNativeClipSelection: vi.fn(),
}));
vi.mock("../../../player/lib/mediaProbe", () => ({ probeMediaUrl: mocks.probeMediaUrl }));
vi.mock("../../../../shared/project/nativePropertyEditPlan", () => ({ resolveNativeClipSelection: mocks.resolveNativeClipSelection }));
vi.mock("../../project/nativeTimelineAudioTransaction", () => ({ commitNativeTimelineAudio: mocks.commitNativeTimelineAudio }));

import { useNativeAudioActions } from "../useNativeAudioActions";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

const video = {
  id: "video", tag: "video", src: "media/voice.mp4", start: 0, duration: 3, track: 0,
} as TimelineElement;
const detachedAudio = { ...video, id: "audio", tag: "audio" } as TimelineElement;

function mountAction() {
  const document = { id: "native:p1", revision: 1, assets: [
    { id: "asset", kind: "video" }, { id: "audio-asset", kind: "audio" },
  ] } as NativeProjectDocument;
  const projectIdRef = { current: "p1" };
  const nativeDocumentRef = { current: document };
  const editQueueRef = { current: Promise.resolve() as Promise<unknown> };
  const reloadPreview = vi.fn();
  const showToast = vi.fn();
  const options = {
    projectIdRef, nativeDocumentRef, editQueueRef,
    nativeProjectEditing: {
      readOptionalProjectFile: vi.fn(), onNativeDocumentCommitted: vi.fn(),
    },
    writeProjectFile: vi.fn(), recordEdit: vi.fn(), showToast,
    domEditSaveTimestampRef: { current: 0 },
    pendingTimelineEditPathRef: { current: new Set<string>() },
    reloadPreview,
  } as unknown as Parameters<typeof useNativeAudioActions>[0];
  let action!: ReturnType<typeof useNativeAudioActions>["handleNativeAudioAction"];
  function Harness() { action = useNativeAudioActions(options).handleNativeAudioAction; return null; }
  const host = documentGlobal.createElement("div");
  documentGlobal.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<Harness />));
  return { action, projectIdRef, nativeDocumentRef, editQueueRef, reloadPreview, showToast,
    cleanup: () => { act(() => root.unmount()); host.remove(); } };
}

const documentGlobal = globalThis.document;
afterEach(() => vi.clearAllMocks());

it("still detaches and refreshes an active project's video", async () => {
  mocks.probeMediaUrl.mockResolvedValue({ hasAudio: true });
  mocks.resolveNativeClipSelection.mockReturnValue({ ok: true, located: { clip: { id: "video", assetId: "asset", binding: { sourceFile: "index.html" } } } });
  const harness = mountAction();
  try {
    mocks.commitNativeTimelineAudio.mockImplementation(async (input: { onCommitted: (next: NativeProjectDocument) => void }) => {
      input.onCommitted(harness.nativeDocumentRef.current);
    });
    await act(async () => { await harness.action(video, "detach"); });
    expect(mocks.commitNativeTimelineAudio).toHaveBeenCalledOnce();
    expect(harness.reloadPreview).toHaveBeenCalledOnce();
    expect(harness.showToast).not.toHaveBeenCalled();
  } finally { harness.cleanup(); }
});

it("does not detach old-project video after its media probe finishes in another project", async () => {
  const probe = deferred<{ hasAudio: boolean }>();
  mocks.probeMediaUrl.mockReturnValue(probe.promise);
  mocks.resolveNativeClipSelection.mockReturnValue({ ok: true, located: { clip: { id: "video", assetId: "asset", binding: { sourceFile: "index.html" } } } });
  const harness = mountAction();
  try {
    const operation = harness.action(video, "detach");
    harness.projectIdRef.current = "p2";
    harness.nativeDocumentRef.current = { ...harness.nativeDocumentRef.current, id: "native:p2" };
    await act(async () => { probe.resolve({ hasAudio: true }); await operation; });
    expect(mocks.commitNativeTimelineAudio).not.toHaveBeenCalled();
    expect(harness.reloadPreview).not.toHaveBeenCalled();
  } finally { harness.cleanup(); }
});

it("does not reattach an old-project clip when its queued edit starts after navigation", async () => {
  const priorEdit = deferred<void>();
  mocks.resolveNativeClipSelection.mockReturnValue({ ok: true, located: { clip: { id: "audio", assetId: "audio-asset", audioDetachedFrom: "video", binding: { sourceFile: "index.html" } } } });
  const harness = mountAction();
  try {
    harness.editQueueRef.current = priorEdit.promise;
    const operation = harness.action(detachedAudio, "reattach");
    harness.projectIdRef.current = "p2";
    await act(async () => { priorEdit.resolve(); await operation; });
    expect(mocks.commitNativeTimelineAudio).not.toHaveBeenCalled();
    expect(harness.reloadPreview).not.toHaveBeenCalled();
  } finally { harness.cleanup(); }
});
