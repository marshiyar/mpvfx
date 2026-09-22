import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");
const optionalFiles = [
  "THIRD_PARTY_NOTICES.md", "CODE_OF_CONDUCT.md", "CONTRIBUTING.md", "PRIVACY.md",
  "SECURITY.md", "SUPPORT.md", ".editorconfig", "docs/ARCHITECTURE.md",
  "studio/tests/e2e/fixtures/ASSET_PROVENANCE.md",
];
let fixture: string;

function runScript(name: string, ...args: string[]) {
  return spawnSync(process.execPath, [resolve(fixture, "scripts", name), ...args], {
    cwd: fixture,
    encoding: "utf8",
  });
}

function expectSuccess(result: ReturnType<typeof runScript>) {
  expect(result.status, result.stderr || result.stdout).toBe(0);
}

beforeEach(() => {
  fixture = mkdtempSync(resolve(tmpdir(), "mpvfx-release-checks-"));
  const publication = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  expect(publication.status).toBe(0);
  for (const path of publication.stdout.split("\0").filter(Boolean)) {
    // Copy release infrastructure without application sources, dependencies, or user projects.
    const releaseInput = !path.includes("/")
      || /^(?:scripts|docs|\.github|third_party\/licenses|studio\/resources\/legal|studio\/scripts)\//u.test(path)
      || /^studio\/package(?:-lock)?\.json$/u.test(path)
      || path === "studio/public/ASSET_PROVENANCE.md";
    if (!releaseInput || optionalFiles.includes(path)) continue;
    const source = resolve(repositoryRoot, path);
    if (!existsSync(source)) continue;
    const target = resolve(fixture, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
  expect(spawnSync("git", ["init", "--quiet", fixture]).status).toBe(0);
});

afterEach(() => {
  rmSync(fixture, { recursive: true, force: true });
});

describe("optional publication files", () => {
  it("passes both release gates after repository documents are deliberately removed", () => {
    expectSuccess(runScript("check-release-readiness.mjs"));
    expectSuccess(runScript("generate-third-party-notices.mjs", "--check"));
    for (const path of optionalFiles) {
      expect(existsSync(resolve(fixture, path)), path).toBe(false);
    }
  });

  it("refreshes packaged notices without recreating removed repository documents", () => {
    const privacyPath = resolve(fixture, "studio/resources/legal/PRIVACY.md");
    const privacy = readFileSync(privacyPath, "utf8");
    expectSuccess(runScript("generate-third-party-notices.mjs"));
    expectSuccess(runScript("generate-third-party-notices.mjs", "--check"));
    expect(readFileSync(privacyPath, "utf8")).toBe(privacy);
    for (const path of optionalFiles) {
      expect(existsSync(resolve(fixture, path)), path).toBe(false);
    }
  });

  it("still detects stale packaged notices and synchronizes optional documents when present", () => {
    const bundledNotices = resolve(fixture, "studio/resources/legal/THIRD_PARTY_NOTICES.md");
    writeFileSync(bundledNotices, "outdated packaged notices\n");
    writeFileSync(resolve(fixture, "THIRD_PARTY_NOTICES.md"), "outdated repository notices\n");
    writeFileSync(resolve(fixture, "PRIVACY.md"), "# Updated privacy policy\n");
    const stale = runScript("generate-third-party-notices.mjs", "--check");
    expect(stale.status).not.toBe(0);
    expect(stale.stderr).toContain("Generated legal notices are missing or stale");
    expect(stale.stderr).toContain(bundledNotices);
    expectSuccess(runScript("generate-third-party-notices.mjs"));
    expectSuccess(runScript("generate-third-party-notices.mjs", "--check"));
    expect(readFileSync(resolve(fixture, "THIRD_PARTY_NOTICES.md"), "utf8"))
      .toBe(readFileSync(bundledNotices, "utf8"));
    expect(readFileSync(resolve(fixture, "studio/resources/legal/PRIVACY.md"), "utf8"))
      .toBe("# Updated privacy policy\n");
  });
});
