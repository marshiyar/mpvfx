import { describe, expect, it } from "vitest";
import { validateStandaloneExportHttpRequest } from "./vite.export-request-policy";

const validate = (body: unknown) =>
  validateStandaloneExportHttpRequest({
    method: "POST",
    requestPath: "/projects/demo/render",
    body: Buffer.from(JSON.stringify(body)),
  });

describe("standalone export HTTP request validation", () => {
  it.each([
    { format: "mp4", quality: "draft", fps: 24 },
    { format: "webm", quality: "standard", fps: 30 },
    { format: "mov", quality: "high", fps: 60 },
    { format: "mp4", quality: "standard", fps: 30, resolution: "square-4k" },
  ])("accepts canonical request %o", (body) => expect(validate(body)).toBeNull());

  it.each([
    { format: "mp4", dimensions: { width: 7680, height: 4320 } },
    { format: "webm", dimensions: { width: 4320, height: 7680 } },
    { format: "mov", dimensions: { width: 1080, height: 1350 } },
  ])("accepts exact standalone output dimensions %o", (body) => {
    expect(validate(body)).toBeNull();
  });

  it.each([
    { dimensions: { width: 7682, height: 4320 } },
    { dimensions: { width: 4322, height: 4322 } },
    { dimensions: { width: 1919, height: 1080 } },
    { dimensions: { width: "1920", height: 1080 } },
    { dimensions: { width: 1920 } },
  ])("rejects invalid or over-8K output dimensions %o", async (body) => {
    const response = validate(body);
    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toMatchObject({ error: expect.stringContaining("dimensions") });
  });

  it.each([
    ["format", { format: "gif" }],
    ["format type", { format: 1 }],
    ["quality", { quality: "lossless" }],
    ["frame rate", { fps: 25 }],
    ["NaN-like frame rate", { fps: "NaN" }],
    ["resolution", { resolution: "8k" }],
    ["auto must be omitted", { resolution: "auto" }],
    ["WebM supersampling", { format: "webm", resolution: "landscape-4k" }],
    ["MOV supersampling", { format: "mov", resolution: "portrait" }],
  ] as const)("rejects unsupported %s", async (_label, body) => {
    const response = validate(body);
    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toMatchObject({ error: expect.any(String) });
  });

  it.each([
    "codec",
    "crf",
    "videoBitrate",
    "audioBitrate",
    "colorSpace",
    "colorProfile",
    "alpha",
    "hdrMode",
    "outputDynamicRange",
    "workers",
    "gpu",
    "useGpu",
    "videoFrameFormat",
    "gifLoop",
    "outputResolution",
    "width",
    "height",
  ])(
    "rejects ignored advanced override %s instead of silently exporting something else",
    async (field) => {
      const response = validate({ format: "mp4", [field]: "custom" });
      expect(response?.status).toBe(400);
      await expect(response?.json()).resolves.toMatchObject({ error: expect.stringContaining(field) });
    },
  );

  it.each([1, 0, -1, 999, "auto", null, {}])(
    "rejects every client worker override shape (%j)",
    async (workers) => {
      const response = validate({ format: "mp4", workers });
      expect(response?.status).toBe(400);
      await expect(response?.json()).resolves.toMatchObject({
        error: expect.stringContaining("workers"),
      });
    },
  );

  it("does not confuse a project variable named workers with a renderer override", () => {
    expect(validate({ format: "mp4", variables: { workers: 5 } })).toBeNull();
  });

  it("preserves route-supported composition, variables, and telemetry fields", () => {
    expect(
      validate({
        format: "mp4",
        composition: "compositions/intro.html",
        variables: { title: "Intro" },
        telemetryDistinctId: "anon-1",
        telemetryOptOut: false,
      }),
    ).toBeNull();
  });

  it("rejects malformed JSON", async () => {
    const response = validateStandaloneExportHttpRequest({
      method: "POST",
      requestPath: "/projects/demo/render",
      body: Buffer.from("{bad"),
    });
    expect(response?.status).toBe(400);
  });

  it("does not inspect unrelated requests", () => {
    expect(
      validateStandaloneExportHttpRequest({
        method: "POST",
        requestPath: "/projects/demo/upload",
        body: Buffer.from("not json"),
      }),
    ).toBeNull();
  });
});
