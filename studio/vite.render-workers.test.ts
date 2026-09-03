import { describe, expect, it } from "vitest";
import { buildStandaloneProducerRenderConfig } from "./vite.export-adapter";

describe("standalone export worker selection", () => {
  it.each([
    "Apple Silicon MacBook",
    "Intel MacBook",
    "low-core Mac laptop",
    "Windows laptop",
    "Windows workstation",
    "low-memory Windows device",
    "Linux desktop",
    "Linux virtual machine",
  ])("keeps %s on renderer-managed automatic sizing", (_deviceProfile) => {
    const config = buildStandaloneProducerRenderConfig({
      fps: { num: 30, den: 1 },
      quality: "standard",
      format: "mp4",
    });

    expect(config).not.toHaveProperty("workers");
    expect(config).not.toHaveProperty("producerConfig");
  });
});
