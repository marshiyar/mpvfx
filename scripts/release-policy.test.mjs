import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");

test("release checks allow intentional removal of optional repository documents", () => {
  const scratch = mkdtempSync(join(tmpdir(), "mpvfx-release-policy-"));
  const optional = [
    "THIRD_PARTY_NOTICES.md", "CODE_OF_CONDUCT.md", "CONTRIBUTING.md",
    "PRIVACY.md", "SECURITY.md", "SUPPORT.md", ".editorconfig",
    "docs/ARCHITECTURE.md", "studio/tests/e2e/fixtures/ASSET_PROVENANCE.md",
  ];
  const run = (script, ...args) => execFileSync(process.execPath, [join(scratch, "scripts", script), ...args], {
    cwd: scratch, encoding: "utf8", stdio: "pipe",
  });
  try {
    const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
    for (const path of tracked.split("\0").filter(Boolean)) {
      if (!existsSync(join(root, path))) continue;
      mkdirSync(dirname(join(scratch, path)), { recursive: true });
      cpSync(join(root, path), join(scratch, path));
    }
    for (const path of optional) rmSync(join(scratch, path), { force: true });
    assert.match(run("check-release-readiness.mjs"), /Release-readiness check passed/);
    run("generate-third-party-notices.mjs");
    run("generate-third-party-notices.mjs", "--check");
    for (const path of optional) assert.equal(existsSync(join(scratch, path)), false, path);
    // Packaged attribution is still enforced when optional root copies are absent.
    rmSync(join(scratch, "studio/resources/legal/THIRD_PARTY_NOTICES.md"));
    assert.throws(() => run("check-release-readiness.mjs"), /Missing required publication file: studio\/resources\/legal\/THIRD_PARTY_NOTICES.md/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
