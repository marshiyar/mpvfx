// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../components/feedback/projectProvenance", () => ({
  captureProjectProvenance: vi.fn(),
}));

import { useFileManager } from "./useFileManager";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("media library refresh after import", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("adds the uploaded media to the assets exposed to the Media section", async () => {
    let uploaded = false;
    const listingUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          uploaded = true;
          return Response.json({ files: ["camera.mp4"] }, { status: 201 });
        }
        listingUrls.push(String(input));
        return Response.json({
          files: uploaded ? ["index.html", "camera.mp4"] : ["index.html"],
          compositions: ["index.html"],
          dir: "/projects/my-video",
        });
      }),
    );

    const captured: { current: ReturnType<typeof useFileManager> | null } = { current: null };
    function Probe(): null {
      captured.current = useFileManager({
        projectId: "project/a",
        showToast: vi.fn(),
        setRefreshKey: vi.fn(),
      });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Probe />));
    await vi.waitFor(() => expect(captured.current?.fileTreeLoaded).toBe(true));

    await act(async () => {
      await captured.current?.uploadProjectFiles([
        new File(["video"], "camera.mp4", { type: "video/mp4" }),
      ]);
    });

    expect(captured.current?.assets).toContain("camera.mp4");
    expect(listingUrls).toEqual([
      "/api/projects/project%2Fa",
      "/api/projects/project%2Fa",
    ]);
    await act(async () => root.unmount());
  });
});
