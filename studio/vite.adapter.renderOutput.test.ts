import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveRenderCompositionSourcePath,
  resolveStandaloneRenderDimensionPlan,
} from "./vite.adapter";

const adapterSource = readFileSync(join(import.meta.dirname, "vite.adapter.ts"), "utf8");

describe("render source preflight", () => {
  it("falls back to the project-named master composition when index.html is absent", () => {
    const exists = (path: string) => path === "/projects/demo/demo.html";
    expect(resolveRenderCompositionSourcePath("/projects/demo", "demo", undefined, exists)).toBe(
      "/projects/demo/demo.html",
    );
  });

  it("refuses an explicit composition path that escapes the project", () => {
    expect(
      resolveRenderCompositionSourcePath(
        "/projects/demo",
        "demo",
        "../outside.html",
        () => true,
      ),
    ).toBeNull();
  });
});

describe("render output dimension routing", () => {
  it("does not re-encode an exact target that is already the authored size", () => {
    expect(
      resolveStandaloneRenderDimensionPlan({
        format: "mp4",
        authored: { width: 1920, height: 1080 },
        requested: { width: 1920, height: 1080 },
      }),
    ).toEqual({ resizeDimensions: null, outputResolution: undefined });
  });

  it("renders a compatible MP4 4K target directly at 4K", () => {
    expect(
      resolveStandaloneRenderDimensionPlan({
        format: "mp4",
        authored: { width: 1920, height: 1080 },
        requested: { width: 3840, height: 2160 },
      }),
    ).toEqual({ resizeDimensions: null, outputResolution: "landscape-4k" });
  });

  it("retains the fitter for custom output dimensions", () => {
    expect(
      resolveStandaloneRenderDimensionPlan({
        format: "mp4",
        authored: { width: 1920, height: 1080 },
        requested: { width: 2560, height: 1440 },
      }),
    ).toEqual({
      resizeDimensions: { width: 2560, height: 1440 },
      outputResolution: undefined,
    });
  });

  it("does not send an alpha export through producer supersampling", () => {
    expect(
      resolveStandaloneRenderDimensionPlan({
        format: "webm",
        authored: { width: 1080, height: 1080 },
        requested: { width: 2160, height: 2160 },
      }),
    ).toEqual({
      resizeDimensions: { width: 2160, height: 2160 },
      outputResolution: undefined,
    });
  });
});

describe("direct media export routing", () => {
  it("attempts the proven browser-free media path before loading the producer", () => {
    expect(adapterSource).toContain('from "./vite.direct-media-export"');
    const directAttempt = adapterSource.indexOf("await tryDirectMediaExport(");
    const producerLoad = adapterSource.indexOf("await getProducerModule()", directAttempt);
    expect(directAttempt).toBeGreaterThan(-1);
    expect(producerLoad).toBeGreaterThan(directAttempt);
  });

  it("uses the same cancellation signal and staging path for the direct backend", () => {
    expect(adapterSource).toMatch(
      /tryDirectMediaExport\([\s\S]*?outputPath:\s*staging\.encodedOutputPath[\s\S]*?signal:\s*cancellation\.signal/,
    );
  });

  it("sends preset and custom MP4 targets through one final-size direct encode", () => {
    expect(adapterSource).toContain("outputDimensions: directOutputDimensions");
    expect(adapterSource).not.toMatch(
      /authoredDimensions\s*&&\s*!opts\.outputResolution\s*&&\s*!dimensionPlan\.outputResolution/,
    );
    expect(adapterSource).toContain(
      "if (dimensionPlan.resizeDimensions && !directRenderedFinalSize)",
    );
  });
});

describe("native audio export routing", () => {
  it("renders Producer from the static native-mute materialization", () => {
    expect(adapterSource).toContain("createNativeProjectExportMaterialization");
    expect(adapterSource).toMatch(
      /const producerProjectDir\s*=\s*createNativeProjectExportMaterialization\([\s\S]*?executeRenderJob\([\s\S]*?producerProjectDir/,
    );
    expect(adapterSource).not.toMatch(
      /executeRenderJob\(\s*job,\s*opts\.project\.dir/,
    );
  });

  it("creates a fresh job staging directory instead of adopting an existing path", () => {
    expect(adapterSource).toContain("mkdirSync(dirname(staging.directory), { recursive: true })");
    expect(adapterSource).toContain("mkdirSync(staging.directory)");
    expect(adapterSource).not.toContain(
      "mkdirSync(staging.directory, { recursive: true })",
    );
  });
});
