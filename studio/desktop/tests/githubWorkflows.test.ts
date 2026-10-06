import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const studioRoot = resolve(repositoryRoot, "studio");

function readRepositoryFile(path: string): string {
  return readFileSync(resolve(repositoryRoot, path), "utf8");
}

describe("GitHub Actions readiness", () => {
  it("reports PR checks before deciding whether expensive work is needed", () => {
    for (const file of ["desktop.yml", "tests.yml", "security.yml"]) {
      const workflow = readRepositoryFile(`.github/workflows/${file}`);
      expect(workflow).toMatch(/pull_request:\s*\n\s*push:/);
      expect(workflow).toContain("needs: changes");
      expect(workflow).toContain("!cancelled()");
      expect(workflow).toContain("needs.changes.result != 'success'");
      expect(workflow).toContain(".previous_filename // empty");
    }
  });

  it("runs the source build and behavior suite in a non-publishing workflow", () => {
    const workflow = readRepositoryFile(".github/workflows/tests.yml");

    expect(workflow).toContain("npm ci --prefix studio");
    expect(workflow).not.toContain("npm --prefix studio run typecheck");
    expect(workflow).toContain("npm --prefix studio run build");
    expect(readFileSync(resolve(studioRoot, "package.json"), "utf8")).toContain(
      '"build": "npm run typecheck &&',
    );
    expect(workflow.match(/persist-credentials: false/g)).toHaveLength(1);
    expect(workflow).not.toMatch(/npm publish|electron-forge publish|gh release/i);
    expect(workflow).toContain("npm --prefix studio test");
  });

  it("builds Apple Silicon, Windows, and Linux installers without the retired Intel macOS target", () => {
    const workflow = readRepositoryFile(".github/workflows/desktop.yml");

    expect(workflow).toContain("macos-15\n            arch: arm64");
    expect(workflow).not.toContain("macos-15-intel");
    expect(workflow).not.toContain("desktop:make:mac:x64");
    expect(workflow).toContain("windows-2025\n            arch: x64");
    expect(workflow).toContain("ubuntu-24.04\n            arch: x64");
    expect(workflow).toContain("npm --prefix studio run ${{ matrix.script }}");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("npm --prefix studio run test:packaged-interface");
    expect(workflow).toContain("name: v007-ui-evidence");
    expect(workflow).not.toContain("studio/out/make/**");
    expect(workflow).not.toMatch(/electron-forge publish|softprops\/action-gh-release|gh release/i);
  });

  it("uses the portable test command on Node 24", () => {
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
