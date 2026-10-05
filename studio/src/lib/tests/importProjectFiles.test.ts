import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopBridge } from "../../../shared/desktopBridge";

const { desktopRequest } = vi.hoisted(() => ({
  desktopRequest: vi.fn(async (_path: string, _init?: RequestInit) =>
    Response.json({ files: ["uploaded.png"], invalid: [] })),
}));
vi.mock("../desktopClient", () => ({ desktopRequest }));
import { importProjectFiles } from "../importProjectFiles";

const LIMIT = 64 * 1024 * 1024;
function sizedFile(name: string, size: number): File {
  const file = new File(["fixture"], name, { type: "image/png" });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

let importFiles: ReturnType<typeof vi.fn>;
beforeEach(() => {
  desktopRequest.mockClear();
  importFiles = vi.fn(async () => null);
  vi.stubGlobal("window", { mpvfx: { importFiles } as unknown as DesktopBridge });
});
afterEach(() => vi.unstubAllGlobals());

describe("project file import transport", () => {
  it("uploads a generated file at 64 MiB but rejects one byte more before serialization", async () => {
    const atLimit = sizedFile("at-limit.png", LIMIT);
    const overLimit = sizedFile("too-large.png", LIMIT + 1);
    const response = await importProjectFiles("project", [atLimit, overLimit]);
    expect(await response.json()).toEqual({
      files: ["uploaded.png"],
      invalid: [{ name: "too-large.png", reason: expect.stringContaining("save it to disk") }],
    });
    expect(importFiles).toHaveBeenCalledTimes(2);
    expect(desktopRequest).toHaveBeenCalledOnce();
    const [, init] = desktopRequest.mock.calls[0]!;
    expect((init.body as FormData).getAll("file")).toEqual([atLimit]);
  });

  it("keeps native disk import available above the generated-file limit", async () => {
    const diskFile = sizedFile("large.mov", LIMIT + 1);
    importFiles.mockResolvedValueOnce({ files: ["large.mov"], invalid: [] });
    expect(await (await importProjectFiles("project", [diskFile])).json()).toEqual({ files: ["large.mov"], invalid: [] });
    expect(desktopRequest).not.toHaveBeenCalled();
  });

  it("splits a large browser batch into bounded requests and skips oversized files", async () => {
    vi.stubGlobal("window", { mpvfx: {} });
    const response = await importProjectFiles("project", [
      sizedFile("first.png", LIMIT / 2 + 1),
      sizedFile("second.png", LIMIT / 2 + 1),
      sizedFile("too-large.png", LIMIT + 1),
    ]);
    expect(desktopRequest).toHaveBeenCalledTimes(2);
    expect(await response.json()).toEqual({
      files: ["uploaded.png", "uploaded.png"],
      invalid: [{ name: "too-large.png", reason: expect.stringContaining("save it to disk") }],
    });
  });
});
