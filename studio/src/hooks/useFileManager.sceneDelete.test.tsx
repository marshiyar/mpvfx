// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../components/feedback/projectProvenance", () => ({
  captureProjectProvenance: vi.fn(),
}));

import { useFileManager } from "./useFileManager";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("reusable scene deletion client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("preflights the version, uses the protected endpoint, and refreshes scenes", async () => {
    let deleted = false;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.includes("/files/compositions%2Fintro.html")) {
          return Response.json({
            content: '<main data-composition-id="intro"></main>',
            version: "v1",
          });
        }
        if (url.includes("/file-mutations/delete-composition/")) {
          deleted = true;
          return Response.json({ ok: true, backupPath: ".hyperframes/deleted-scenes/1/intro.html" });
        }
        return Response.json({
          files: deleted ? ["index.html"] : ["index.html", "compositions/intro.html"],
          compositions: deleted ? ["index.html"] : ["index.html", "compositions/intro.html"],
          dir: "/projects/demo",
        });
      }),
    );

    const captured: { current: ReturnType<typeof useFileManager> | null } = { current: null };
    function Probe(): null {
      captured.current = useFileManager({
        projectId: "demo",
        showToast: vi.fn(),
        setRefreshKey: vi.fn(),
      });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Probe />));
    await vi.waitFor(() => expect(captured.current?.fileTreeLoaded).toBe(true));

    let result = false;
    await act(async () => {
      result = (await captured.current?.handleDeleteComposition("compositions/intro.html")) ?? false;
    });

    expect(result).toBe(true);
    expect(captured.current?.compositions).toEqual(["index.html"]);
    const mutation = calls.find((call) =>
      call.url.includes("/file-mutations/delete-composition/"),
    );
    expect(mutation).toMatchObject({
      url: "/api/projects/demo/file-mutations/delete-composition/compositions%2Fintro.html",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: "v1" }),
      },
    });
    await act(async () => root.unmount());
  });

  it("keeps the scene and explains a protected-server rejection", async () => {
    const showToast = vi.fn();
    let listingRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/files/compositions%2Fintro.html")) {
          return Response.json({ content: "scene", version: "v1" });
        }
        if (url.includes("/file-mutations/delete-composition/")) {
          return Response.json(
            { error: "Scene is still used by another composition" },
            { status: 409 },
          );
        }
        listingRequests += 1;
        return Response.json({
          files: ["index.html", "compositions/intro.html"],
          compositions: ["index.html", "compositions/intro.html"],
        });
      }),
    );

    const captured: { current: ReturnType<typeof useFileManager> | null } = { current: null };
    function Probe(): null {
      captured.current = useFileManager({ projectId: "demo", showToast, setRefreshKey: vi.fn() });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Probe />));
    await vi.waitFor(() => expect(captured.current?.fileTreeLoaded).toBe(true));

    let result = true;
    await act(async () => {
      result = (await captured.current?.handleDeleteComposition("compositions/intro.html")) ?? true;
    });

    expect(result).toBe(false);
    expect(listingRequests).toBe(1);
    expect(captured.current?.compositions).toContain("compositions/intro.html");
    expect(showToast).toHaveBeenCalledWith(
      "Couldn't delete compositions/intro.html: Scene is still used by another composition",
      "error",
    );
    await act(async () => root.unmount());
  });

  it("keeps a committed deletion successful when the follow-up refresh fails", async () => {
    const showToast = vi.fn();
    let listings = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/files/compositions%2Fintro.html")) {
          return Response.json({ content: "scene", version: "v1" });
        }
        if (url.includes("/file-mutations/delete-composition/")) {
          return Response.json({ ok: true });
        }
        listings += 1;
        if (listings > 1) {
          return Response.json({ error: "listing unavailable" }, { status: 503 });
        }
        return Response.json({
          files: ["index.html", "compositions/intro.html"],
          compositions: ["index.html", "compositions/intro.html"],
        });
      }),
    );

    const captured: { current: ReturnType<typeof useFileManager> | null } = { current: null };
    function Probe(): null {
      captured.current = useFileManager({ projectId: "demo", showToast, setRefreshKey: vi.fn() });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Probe />));
    await vi.waitFor(() => expect(captured.current?.fileTreeLoaded).toBe(true));

    let result = false;
    await act(async () => {
      result = (await captured.current?.handleDeleteComposition("compositions/intro.html")) ?? false;
    });

    expect(result).toBe(true);
    expect(captured.current?.compositions).toEqual(["index.html"]);
    expect(showToast).toHaveBeenCalledWith(
      "Deleted compositions/intro.html, but couldn't refresh the library. Reload to sync.",
      "error",
    );
    await act(async () => root.unmount());
  });

  it("does not apply a late project-A deletion completion to project B", async () => {
    let resolveMutation!: (response: Response) => void;
    let projectBListings = 0;
    const setRefreshKey = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/projects/a/files/compositions%2Fintro.html")) {
          return Promise.resolve(Response.json({ content: "scene-a", version: "v1" }));
        }
        if (url.includes("/projects/a/file-mutations/delete-composition/")) {
          return new Promise<Response>((resolve) => {
            resolveMutation = resolve;
          });
        }
        if (url === "/api/projects/b") projectBListings += 1;
        return Promise.resolve(
          Response.json({
            files: ["index.html", "compositions/intro.html"],
            compositions: ["index.html", "compositions/intro.html"],
          }),
        );
      }),
    );

    const captured: { current: ReturnType<typeof useFileManager> | null } = { current: null };
    function Probe({ projectId }: { projectId: string }): null {
      captured.current = useFileManager({ projectId, showToast: vi.fn(), setRefreshKey });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Probe projectId="a" />));
    await vi.waitFor(() => expect(captured.current?.fileTreeLoaded).toBe(true));

    let deletion!: Promise<boolean>;
    await act(async () => {
      deletion = captured.current!.handleDeleteComposition("compositions/intro.html");
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => root.render(<Probe projectId="b" />));
    await vi.waitFor(() => expect(projectBListings).toBe(1));
    act(() => {
      captured.current?.setEditingFile({ path: "compositions/intro.html", content: "scene-b" });
    });

    resolveMutation(Response.json({ ok: true }));
    await act(async () => deletion);

    expect(captured.current?.editingFile).toEqual({
      path: "compositions/intro.html",
      content: "scene-b",
    });
    expect(projectBListings).toBe(1);
    expect(setRefreshKey).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});
