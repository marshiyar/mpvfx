import { describe, expect, it } from "vitest";
import { buildStandaloneProducerRenderConfig } from "./vite.export-adapter";

describe("standalone export adapter forwarding", () => {
  it("forwards every supported producer setting without renaming it", () => {
    expect(
      buildStandaloneProducerRenderConfig({
        fps: { num: 60, den: 1 },
        quality: "high",
        format: "mp4",
        outputResolution: "square-4k",
        composition: "compositions/outro.html",
        variables: { title: "Final" },
        renderBodyScripts: ["window.ready = true"],
      }),
    ).toEqual({
      fps: { num: 60, den: 1 },
      quality: "high",
      format: "mp4",
      outputResolution: "square-4k",
      useGpu: true,
      entryFile: "compositions/outro.html",
      variables: { title: "Final" },
      renderBodyScripts: ["window.ready = true"],
    });
  });

  it.each(["webm", "mov"] as const)(
    "defensively omits unsupported output resolution for %s",
    (format) => {
      expect(
        buildStandaloneProducerRenderConfig({
          fps: { num: 30, den: 1 },
          quality: "standard",
          format,
          outputResolution: "landscape-4k",
        }),
      ).not.toHaveProperty("outputResolution");
    },
  );

  it("omits absent optional settings", () => {
    expect(
      buildStandaloneProducerRenderConfig({
        fps: { num: 24, den: 1 },
        quality: "draft",
        format: "webm",
      }),
    ).toEqual({ fps: { num: 24, den: 1 }, quality: "draft", format: "webm" });
  });

  it("automatically enables the producer's probed hardware encoder for MP4", () => {
    expect(
      buildStandaloneProducerRenderConfig({
        fps: { num: 30, den: 1 },
        quality: "standard",
        format: "mp4",
      }),
    ).toMatchObject({ useGpu: true });
  });

  it.each(["webm", "mov"] as const)(
    "does not request an incompatible hardware encoder for %s",
    (format) => {
      expect(
        buildStandaloneProducerRenderConfig({
          fps: { num: 30, den: 1 },
          quality: "standard",
          format,
        }),
      ).not.toHaveProperty("useGpu");
    },
  );

  it("does not forward a runtime-injected worker override outside the allowlisted input", () => {
    const untrusted = {
      fps: { num: 30, den: 1 },
      quality: "standard",
      format: "mp4",
      workers: 99,
      producerConfig: { concurrency: 99 },
    } as unknown as Parameters<typeof buildStandaloneProducerRenderConfig>[0];

    const config = buildStandaloneProducerRenderConfig(untrusted);
    expect(config).not.toHaveProperty("workers");
    expect(config).not.toHaveProperty("producerConfig");
  });
});
