// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MEDIA_IMPORT_ACCEPT } from "../../utils/mediaImportPolicy";
import { MediaImportControl } from "./MediaImportControl";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("MediaImportControl", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the centralized supported-format list and allows multi-file imports", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => {
      root.render(<MediaImportControl onImport={vi.fn()} />);
    });

    const input = host.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    expect(input?.accept).toBe(MEDIA_IMPORT_ACCEPT);
    expect(input?.multiple).toBe(true);
    await act(async () => root.unmount());
  });

  it("clears the picker so selecting the same file twice imports twice", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    const onImport = vi.fn(async () => {});
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => {
      root.render(<MediaImportControl onImport={onImport} />);
    });
    const input = host.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("media file input not rendered");
    const selected = [new File(["video"], "clip.mp4", { type: "video/mp4" })];
    Object.defineProperty(input, "files", { configurable: true, get: () => selected });

    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    expect(input.value).toBe("");
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));

    expect(onImport).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
  });
});
