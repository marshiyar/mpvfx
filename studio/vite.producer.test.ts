import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createRetryingModuleLoader,
  ensureProducerDist,
  resolveInstalledProducerEntry,
} from "./vite.producer";

describe("ensureProducerDist", () => {
  it("uses the installed ESM producer without invoking a package build", () => {
    const result = ensureProducerDist({
      studioDir: "/repo/packages/studio",
      resolveInstalledProducerEntryImpl: () => "/repo/studio/node_modules/@hyperframes/producer/dist/index.js",
    });

    expect(result).toEqual({
      producerDistEntry: "/repo/studio/node_modules/@hyperframes/producer/dist/index.js",
    });
  });

  it("reports an npm recovery command instead of falling back to Bun", () => {
    expect(() =>
      ensureProducerDist({
        studioDir: "/repo/studio",
        resolveInstalledProducerEntryImpl: () => null,
      }),
    ).toThrow("npm install");
  });
});

describe("producer resolution", () => {
  it("resolves the import-only producer package installed by npm", () => {
    expect(resolveInstalledProducerEntry(process.cwd())).toBe(
      resolve(process.cwd(), "node_modules/@hyperframes/producer/dist/index.js"),
    );
  });
});

describe("createRetryingModuleLoader", () => {
  it("retries after an initial load failure instead of caching the rejection", async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("ok");
    const getModule = createRetryingModuleLoader(load);

    await expect(getModule()).rejects.toThrow("boom");
    await expect(getModule()).resolves.toBe("ok");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("reuses the same promise after a successful load", async () => {
    const load = vi.fn<() => Promise<string>>().mockResolvedValue("ok");
    const getModule = createRetryingModuleLoader(load);

    await expect(getModule()).resolves.toBe("ok");
    await expect(getModule()).resolves.toBe("ok");
    expect(load).toHaveBeenCalledTimes(1);
  });
});
