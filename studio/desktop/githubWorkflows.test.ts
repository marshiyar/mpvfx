import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const studioRoot = resolve(repositoryRoot, "studio");

function readRepositoryFile(path: string): string {
  return readFileSync(resolve(repositoryRoot, path), "utf8");
}

describe("GitHub Actions readiness", () => {
  it("keeps tests and source compilation in a dedicated non-publishing workflow", () => {
    const workflow = readRepositoryFile(".github/workflows/tests.yml");

    expect(workflow).toContain("npm ci --prefix studio");
    expect(workflow).toContain("npm --prefix studio test");
    expect(workflow).toContain("npm --prefix studio run typecheck");
    expect(workflow).toContain("npm --prefix studio run build");
    expect(workflow.match(/persist-credentials: false/g)).toHaveLength(3);
    expect(workflow).not.toMatch(/npm publish|electron-forge publish|gh release|upload-artifact/i);
  });

  it("builds native installers on matching macOS, Windows, and Linux hosts", () => {
    const workflow = readRepositoryFile(".github/workflows/desktop.yml");

    expect(workflow).toContain("macos-15\n            arch: arm64");
    expect(workflow).toContain("macos-15-intel\n            arch: x64");
    expect(workflow).toContain("windows-2025\n            arch: x64");
    expect(workflow).toContain("ubuntu-24.04\n            arch: x64");
    expect(workflow).toContain("npm --prefix studio run ${{ matrix.script }}");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).not.toContain("actions/upload-artifact");
    expect(workflow).not.toMatch(/electron-forge publish|softprops\/action-gh-release|gh release/i);
  });

  it("uses the Node 22-compatible test command", () => {
    const pkg = readFileSync(resolve(studioRoot, "package.json"), "utf8");

    expect(pkg).not.toContain("--no-webstorage");
  });

  it("ignores generated builds and local projects without hiding source or lockfiles", () => {
    const rootIgnore = readRepositoryFile(".gitignore");
    const studioIgnore = readRepositoryFile("studio/.gitignore");
    const combined = `${rootIgnore}\n${studioIgnore}`;

    for (const path of ["node_modules/", "dist/", "desktop-dist/", "out/", "data/projects/"]) {
      expect(combined).toContain(path);
    }
    expect(combined).toContain(".hyperframes/");
    expect(combined).not.toContain("package-lock.json");
    expect(combined).not.toContain("src/");
  });
});
