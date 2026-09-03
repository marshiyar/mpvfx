import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(import.meta.dirname, "studio.http-service.ts"), "utf8");

describe("standalone Vite export policy wiring", () => {
  it("validates render requests before handing them to the installed Studio server", () => {
    expect(source).toContain('from "./vite.export-request-policy"');
    expect(source.indexOf("validateStandaloneExportHttpRequest(")).toBeLessThan(
      source.indexOf("getApi()).fetch(fetchRequest)"),
    );
  });

  it("serves the FFmpeg capability endpoint before the installed API fallback", () => {
    expect(source).toContain('from "./vite.ffmpeg-status"');
    expect(source.indexOf("ffmpegEnvironmentResponse(")).toBeLessThan(
      source.indexOf("getApi()).fetch(fetchRequest)"),
    );
  });
});
