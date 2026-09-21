import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const verifier = () => require("../scripts/verify-packaged-privacy.cjs") as {
  assertPublicContent(content: string, label: string): void;
  assertPackagedPrivacy(result: { outputPaths: string[]; platform: string }): void;
};

describe("installer publication privacy", () => {
  it("excludes local state, diagnostic reports, credentials, and first-party source from Forge", () => {
    const { packagerConfig } = require("../forge.config.cjs");
    for (const path of ["/.env", "/resources/signing.p8", "/resources/auth.p12", "/node_modules/example/.env.local", "/dist/session.jsonl", "/dist/native.dmp", "/resources/MpVFX-diagnostics-test.json.gz", "/diagnostics/logger.ts", "/.codex/session.json", "/desktop-dist/main.js.map", "/dist/index.js.map", "/out/report.json"]) {
      expect(packagerConfig.ignore.some((rule: RegExp) => rule.test(path)), path).toBe(true);
    }
    for (const path of ["/package.json", "/package-lock.json", "/desktop-dist/main.js", "/dist/index.html", "/dist/assets/index-example.js", "/node_modules/esbuild/package.json", "/resources/legal/PRIVACY.md"]) {
      expect(packagerConfig.ignore.some((rule: RegExp) => rule.test(path)), path).toBe(false);
    }
  });

  it("rejects credential content without printing its value", () => {
    const token = "ghp_" + "a".repeat(36);
    let error: unknown;
    try { verifier().assertPublicContent(`const key = '${token}'`, "app.js"); } catch (caught) { error = caught; }
    expect(String(error)).toMatch(/credential.*app.js/i);
    expect(String(error)).not.toContain(token);
    expect(() => verifier().assertPublicContent("const key = process.env.GH_TOKEN", "app.js")).not.toThrow();
  });

  it("inspects actual ASAR contents and extra resources, on all package layouts", async () => {
    const { createPackage } = require("@electron/asar");
    const fixture = mkdtempSync(join(tmpdir(), "mpvfx-publication-privacy-"));
    try {
      const source = join(fixture, "input");
      mkdirSync(join(source, "dist"), { recursive: true });
      writeFileSync(join(source, "package.json"), '{"name":"mpvfx"}');
      writeFileSync(join(source, "dist/index.html"), "<p>MpVFX</p>");
      for (const platform of ["darwin", "win32", "linux"]) {
        const output = join(fixture, platform);
        const resources = platform === "darwin" ? join(output, "MpVFX.app/Contents/Resources") : join(output, "resources");
        mkdirSync(resources, { recursive: true });
        await createPackage(source, join(resources, "app.asar"));
        expect(() => verifier().assertPackagedPrivacy({ outputPaths: [output], platform })).not.toThrow();
        writeFileSync(join(resources, "session.dmp"), "private memory");
        expect(() => verifier().assertPackagedPrivacy({ outputPaths: [output], platform })).toThrow(/private.*session.dmp/i);
        rmSync(join(resources, "session.dmp"));
        writeFileSync(join(source, "dist/session.jsonl"), "private local log");
        await createPackage(source, join(resources, "app.asar"));
        expect(() => verifier().assertPackagedPrivacy({ outputPaths: [output], platform })).toThrow(/private.*session.jsonl/i);
        rmSync(join(source, "dist/session.jsonl"));
      }
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
});
