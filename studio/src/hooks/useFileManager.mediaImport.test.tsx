// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SUPPORTED_MEDIA_IMPORT_EXTENSIONS } from "../utils/mediaImportPolicy";

const refreshFileTree = vi.fn(async () => {});

vi.mock("./useFileTree", () => ({
  useFileTree: () => ({
    projectDir: "",
    fileTree: [],
    fileTreeLoaded: true,
    refreshFileTree,
    compositions: [],
    assets: [],
    fontAssets: [],
  }),
}));

import { useFileManager } from "./useFileManager";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function mount(projectId: string | null = "project/a") {
  const showToast = vi.fn();
  const setRefreshKey = vi.fn();
  const captured: { current: ReturnType<typeof useFileManager> | null } = { current: null };
  function Probe() {
    captured.current = useFileManager({ projectId, showToast, setRefreshKey });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  if (!captured.current) throw new Error("file manager did not mount");
  return { manager: captured.current, root, showToast, setRefreshKey };
}

function mediaFile(extension: string): File {
  return new File(["media"], `sample.${extension}`);
}

describe("useFileManager media imports", () => {
  afterEach(() => {
    refreshFileTree.mockClear();
    vi.unstubAllGlobals();
  });

  it("sends every supported media, font, and LUT extension through the upload workflow", async () => {
    const allExtensions = Object.values(SUPPORTED_MEDIA_IMPORT_EXTENSIONS).flat();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ files: allExtensions.map((ext) => `sample.${ext}`) }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { manager, root } = await mount();

    const result = await manager.uploadProjectFiles(allExtensions.map(mediaFile));

    expect(result).toEqual(allExtensions.map((ext) => `sample.${ext}`));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/projects/project%2Fa/upload");
    expect(init?.method).toBe("POST");
    expect((init?.body as FormData).getAll("file").map((entry) => (entry as File).name)).toEqual(
      allExtensions.map((ext) => `sample.${ext}`),
    );
    expect(refreshFileTree).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it("filters unsupported, empty, and MIME-mismatched files before the request", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ files: ["keep.mp4"] }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { manager, root, showToast } = await mount();
    const keep = new File(["video"], "keep.mp4", { type: "video/mp4" });

    await manager.uploadProjectFiles([
      keep,
      new File(["pdf"], "notes.pdf", { type: "application/pdf" }),
      new File([], "empty.png", { type: "image/png" }),
      new File(["wrong"], "poster.png", { type: "video/mp4" }),
    ]);

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect((init?.body as FormData).getAll("file")).toEqual([keep]);
    expect(showToast).toHaveBeenCalledWith(
      "Unsupported files skipped: notes.pdf, empty.png, poster.png",
      "error",
    );
    await act(async () => root.unmount());
  });

  it("does not make an empty request when every file is rejected", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { manager, root, showToast } = await mount();

    await expect(manager.uploadProjectFiles([mediaFile("pdf")])).resolves.toEqual([]);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith("Unsupported files skipped: sample.pdf", "error");
    await act(async () => root.unmount());
  });

  it("reports server-side stream validation and size failures without losing good files", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            files: ["good.mov"],
            invalid: [{ name: "fake.mov", reason: "no supported video stream found" }],
            skipped: ["huge.mxf"],
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const { manager, root, showToast } = await mount();

    await expect(manager.uploadProjectFiles([mediaFile("mov")])).resolves.toEqual(["good.mov"]);

    expect(showToast).toHaveBeenCalledWith("Skipped (too large): huge.mxf");
    expect(showToast).toHaveBeenCalledWith("Unsupported media skipped: fake.mov");
    await act(async () => root.unmount());
  });

  it("preserves a requested safe subdirectory for font and LUT imports", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ files: ["assets/luts/look.cube"] }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { manager, root } = await mount("project");

    await manager.uploadProjectFiles([mediaFile("cube")], "assets/luts");

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/projects/project/upload?dir=assets%2Fluts",
    );
    await act(async () => root.unmount());
  });

  it.each([
    [413, "Upload rejected: payload too large"],
    [415, "Upload failed (415)"],
    [500, "Upload failed (500)"],
  ] as const)("reports HTTP %s without refreshing the project", async (status, message) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("failure", { status })),
    );
    const { manager, root, showToast } = await mount();

    await expect(manager.uploadProjectFiles([mediaFile("mp4")])).resolves.toEqual([]);

    expect(showToast).toHaveBeenCalledWith(message);
    expect(refreshFileTree).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("distinguishes a malformed success response from a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("not-json", {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const { manager, root, showToast } = await mount();

    await expect(manager.uploadProjectFiles([mediaFile("mp4")])).resolves.toEqual([]);

    expect(showToast).toHaveBeenCalledWith("Upload failed: invalid server response");
    expect(showToast).not.toHaveBeenCalledWith("Upload failed: network error");
    expect(refreshFileTree).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("reports a network failure without refreshing the project", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    const { manager, root, showToast } = await mount();

    await expect(manager.uploadProjectFiles([mediaFile("mp4")])).resolves.toEqual([]);

    expect(showToast).toHaveBeenCalledWith("Upload failed: network error");
    expect(refreshFileTree).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("is a no-op without an active project", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { manager, root } = await mount(null);
    await expect(manager.uploadProjectFiles([mediaFile("mp4")])).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});
