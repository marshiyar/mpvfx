// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TIMELINE_ASSET_MIME } from "../../utils/timelineAssetDrop";
import { AssetsTab } from "./AssetsTab";
import { MediaImportControl } from "./MediaImportControl";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("imported media library drag", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("shows an imported video and writes the exact timeline drag payload", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const setData = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    function Harness() {
      const [assets, setAssets] = useState<string[]>([]);
      const onImport = async (files: FileList) => {
        const file = Array.from(files)[0];
        if (file) setAssets([`assets/${file.name}`]);
      };
      return (
        <>
          <MediaImportControl onImport={onImport} />
          <AssetsTab projectId="project/#1?%" assets={assets} onImport={onImport} />
        </>
      );
    }

    await act(async () => root.render(<Harness />));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/project%2F%231%3F%25/preview/.media/manifest.jsonl",
    );
    const picker = host.querySelector<HTMLInputElement>('input[type="file"]');
    if (!picker) throw new Error("media picker did not render");
    const selected = [new File(["video"], "camera.mp4", { type: "video/mp4" })];
    Object.defineProperty(picker, "files", { configurable: true, get: () => selected });

    await act(async () => picker.dispatchEvent(new Event("change", { bubbles: true })));

    const card = [...host.querySelectorAll<HTMLElement>('[draggable="true"]')].find((element) =>
      element.textContent?.includes("camera.mp4"),
    );
    expect(card).toBeDefined();
    const dragStart = new Event("dragstart", { bubbles: true });
    Object.defineProperty(dragStart, "dataTransfer", {
      value: { effectAllowed: "none", setData },
    });
    await act(async () => card?.dispatchEvent(dragStart));

    expect(setData).toHaveBeenCalledWith(
      TIMELINE_ASSET_MIME,
      JSON.stringify({ path: "assets/camera.mp4" }),
    );
    expect(setData).toHaveBeenCalledWith("text/plain", "assets/camera.mp4");

    await act(async () => root.unmount());
  });

  it("still imports files dropped directly on the media pane", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    const onImport = vi.fn();
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => {
      root.render(<AssetsTab projectId="project" assets={[]} onImport={onImport} />);
    });
    const droppedFiles = [new File(["audio"], "voice.wav", { type: "audio/wav" })];
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { files: droppedFiles } });

    await act(async () => host.firstElementChild?.dispatchEvent(drop));

    expect(onImport).toHaveBeenCalledExactlyOnceWith(droppedFiles);
    await act(async () => root.unmount());
  });
});
