// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { TimelineElement } from "../../../player/index";
import { usePlayerStore } from "../../../player/index";
import { desktopRequest } from "../../../lib/desktopClient";
import { useRemoveSilence } from "../useRemoveSilence";

vi.mock("../../../lib/desktopClient", () => ({
  desktopRequest: vi.fn(async () => ({
    ok: true,
    json: async () => ({ ranges: [{ start: 0, end: 5 }] }),
  })),
}));
vi.mock("../../../player/components/thumbnailUtils", () => ({
  resolveMediaPreviewUrl: (src: string) => `${window.location.origin}/api/projects/p1/preview/${src}`,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  usePlayerStore.getState().reset();
  document.body.innerHTML = "";
});

it.each(["video", "audio"] as const)("reports one summary for a %s silence delete", async tag => {
  const clip: TimelineElement = {
    id: "clip", domId: "clip", tag, kind: tag, src: `media/clip.${tag === "audio" ? "wav" : "mp4"}`,
    start: 0, duration: 5, track: 0, sourceFile: "index.html",
  };
  usePlayerStore.getState().setElements([clip]);
  const showToast = vi.fn();
  const deleteElements = vi.fn(async () => {
    usePlayerStore.getState().setElements([]);
  });
  let removeSilence!: ReturnType<typeof useRemoveSilence>["handleRemoveSilence"];
  function Probe() {
    removeSilence = useRemoveSilence({
      projectId: "p1", activeCompPath: "index.html", showToast,
      writeProjectFile: vi.fn(), recordEdit: vi.fn(),
      domEditSaveTimestampRef: { current: 0 }, reloadPreview: vi.fn(),
      deleteElements, moveElement: vi.fn(), splitElement: vi.fn(),
      isNativeElement: () => false,
    }).handleRemoveSilence;
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Probe />));
    await act(async () => removeSilence(clip));
    expect(vi.mocked(desktopRequest).mock.lastCall?.[0]).toBe("/api/projects/p1/media/silences");
    expect(JSON.parse(String(vi.mocked(desktopRequest).mock.lastCall?.[1]?.body)).source).toBe(clip.src);
    expect(deleteElements).toHaveBeenCalledWith([clip], { suppressSuccessToast: true });
    expect(showToast).toHaveBeenCalledExactlyOnceWith("Removed 1 silences, 5.0s", "info");
  } finally {
    await act(async () => root.unmount());
  }
});
