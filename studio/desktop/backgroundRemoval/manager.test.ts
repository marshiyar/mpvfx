import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_MODEL, ensureModel, modelPath } from "./manager";

describe("background-removal model download integrity", () => {
  const originalDirectory = process.env.MPVFX_BACKGROUND_REMOVAL_MODELS_DIR;
  let temporaryDirectory: string | null = null;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalDirectory === undefined) delete process.env.MPVFX_BACKGROUND_REMOVAL_MODELS_DIR;
    else process.env.MPVFX_BACKGROUND_REMOVAL_MODELS_DIR = originalDirectory;
    if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  });

  it("rejects and removes a download whose SHA-256 is not the pinned model digest", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "mpvfx-model-integrity-"));
    process.env.MPVFX_BACKGROUND_REMOVAL_MODELS_DIR = temporaryDirectory;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })),
    );

    await expect(ensureModel(DEFAULT_MODEL)).rejects.toThrow(/integrity check failed/i);
    expect(existsSync(modelPath(DEFAULT_MODEL))).toBe(false);
    expect(readdirSync(temporaryDirectory)).toEqual([]);
  });

  it("does not trust a corrupted file already present in the model cache", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "mpvfx-model-cache-integrity-"));
    process.env.MPVFX_BACKGROUND_REMOVAL_MODELS_DIR = temporaryDirectory;
    writeFileSync(modelPath(DEFAULT_MODEL), new Uint8Array([9, 9, 9]));
    const fetchMock = vi.fn(
      async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(ensureModel(DEFAULT_MODEL)).rejects.toThrow(/integrity check failed/i);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(existsSync(modelPath(DEFAULT_MODEL))).toBe(false);
  });
});
