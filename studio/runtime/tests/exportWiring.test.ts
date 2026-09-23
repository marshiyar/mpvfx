import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(import.meta.dirname, "../service.ts"), "utf8");

describe("desktop export policy wiring", () => {
  it("validates render requests before handing them to the installed Studio server", () => {
    expect(source).toContain('from "./export/requestPolicy"');
    expect(source.indexOf("validateStandaloneExportHttpRequest(")).toBeLessThan(
      source.indexOf("getApi()).fetch(fetchRequest)"),
    );
  });

  it("serves the FFmpeg capability endpoint before the installed API fallback", () => {
    expect(source).toContain('from "./media/ffmpegStatus"');
    expect(source.indexOf("ffmpegEnvironmentResponse(")).toBeLessThan(
      source.indexOf("getApi()).fetch(fetchRequest)"),
    );
  });
});
