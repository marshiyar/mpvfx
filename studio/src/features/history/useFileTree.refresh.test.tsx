// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../feedback/projectProvenance", () => ({
  captureProjectProvenance: vi.fn(),
}));

import { useFileTree } from "./useFileTree";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("file tree composition refresh", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps recovery copies available to history without showing them as media", async () => {
    const deleted = ".hyperframes/deleted-media/delete-1/photo.png";
    const archivedFont = ".hyperframes/deleted-media/delete-2/Face.woff2";
    let listing = { files: ["index.html", "photo.png", "media/live.png", "fonts/Face.woff2"], compositions: ["index.html"] };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(listing)));
    let tree!: ReturnType<typeof useFileTree>;
    const projectIdRef = { current: "demo" };
    function Probe() { tree = useFileTree({ projectId: "demo", projectIdRef }); return null; }
    const root = createRoot(document.createElement("div"));
    try {
      await act(async () => root.render(<Probe />));
      expect(tree.assets).toContain("photo.png");
      listing = { files: ["index.html", deleted, archivedFont, "media/live.png", "fonts/Face.woff2"], compositions: ["index.html"] };
      await act(async () => tree.refreshFileTree());
      expect(tree.fileTree).toContain(deleted);
      expect(tree.assets).toEqual(["media/live.png", "fonts/Face.woff2"]);
      expect(tree.fontAssets.map((font) => font.path)).toEqual(["fonts/Face.woff2"]);
      listing = { files: ["index.html", "photo.png", "media/live.png", "fonts/Face.woff2"], compositions: ["index.html"] };
      await act(async () => tree.refreshFileTree());
      expect(tree.assets).toContain("photo.png");
    } finally { await act(async () => root.unmount()); }
  });

  it("refreshes the reusable composition list as well as ordinary files", async () => {
    let listing = {
      files: ["index.html", "compositions/intro.html"],
      compositions: ["index.html", "compositions/intro.html"],
      dir: "/projects/demo",
    };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(listing)));

    const captured: { current: ReturnType<typeof useFileTree> | null } = { current: null };
    const projectIdRef = { current: "demo" };
    function Probe(): null {
      captured.current = useFileTree({ projectId: "demo", projectIdRef });
      return null;
    }

    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Probe />));
    await vi.waitFor(() =>
      expect(captured.current?.compositions).toEqual([
        "index.html",
        "compositions/intro.html",
      ]),
    );

    listing = {
      files: ["index.html"],
      compositions: ["index.html"],
      dir: "/projects/demo",
    };
    await act(async () => captured.current?.refreshFileTree());

    expect(captured.current?.compositions).toEqual(["index.html"]);
    await act(async () => root.unmount());
  });

  it.each(["initial load", "earlier refresh"] as const)(
    "does not let an %s replace a newer project listing",
    async (oldRequest) => {
      const responses: Array<(response: Response) => void> = [];
      vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => responses.push(resolve))));
      let tree!: ReturnType<typeof useFileTree>;
      const projectIdRef = { current: "demo" };
      function Probe() {
        tree = useFileTree({ projectId: "demo", projectIdRef });
        return null;
      }
      const root = createRoot(document.createElement("div"));
      const listing = (files: string[]) => Response.json({ files, compositions: files.filter((file) => file.endsWith(".html")) });
      try {
        await act(async () => root.render(<Probe />));
        let oldRefresh: Promise<void> | undefined;
        if (oldRequest === "earlier refresh") {
          await act(async () => responses.shift()!(listing(["index.html"])));
          act(() => { oldRefresh = tree.refreshFileTree(); });
        }
        let newer!: Promise<void>;
        act(() => { newer = tree.refreshFileTree(); });
        const oldResponse = responses.shift()!;
        const newResponse = responses.shift()!;
        await act(async () => { newResponse(listing(["index.html", "new.html", "new.mp4"])); await newer; });
        await act(async () => { oldResponse(listing(["index.html", "deleted.html", "deleted.mp4"])); await oldRefresh; });

        expect(tree.fileTree).toEqual(["index.html", "new.html", "new.mp4"]);
        expect(tree.compositions).toEqual(["index.html", "new.html"]);
      } finally { await act(async () => root.unmount()); }
    },
  );

  it("does not resurrect a deleted path from an already pending listing", async () => {
    let resolveListing!: (response: Response) => void;
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({
      files: ["index.html", "deleted.html"], compositions: ["index.html", "deleted.html"],
    })).mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveListing = resolve; }));
    vi.stubGlobal("fetch", fetch);
    let tree!: ReturnType<typeof useFileTree>;
    const projectIdRef = { current: "demo" };
    function Probe() { tree = useFileTree({ projectId: "demo", projectIdRef }); return null; }
    const root = createRoot(document.createElement("div"));
    try {
      await act(async () => root.render(<Probe />));
      let refresh!: Promise<void>;
      act(() => { refresh = tree.refreshFileTree(); });
      act(() => tree.removeProjectPath("deleted.html"));
      await act(async () => {
        resolveListing(Response.json({ files: ["index.html", "deleted.html"], compositions: ["index.html", "deleted.html"] }));
        await refresh;
      });
      expect(tree.fileTree).toEqual(["index.html"]);
      expect(tree.compositions).toEqual(["index.html"]);
    } finally { await act(async () => root.unmount()); }
  });
});
