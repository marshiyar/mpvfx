import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  LEGACY_STANDALONE_COMPOSITION_SOURCE,
  STANDALONE_PROJECT_ID,
  createStandaloneCompositionSource,
  ensureStandaloneProject,
} from "./vite.standalone-project";

const tempDirs: string[] = [];

function makeProjectsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hyperframes-standalone-project-"));
  tempDirs.push(dir);
  return dir;
}

function makeGsapSource(projectsDir: string): string {
  const sourcePath = join(projectsDir, "test-gsap.min.js");
  writeFileSync(sourcePath, "window.gsap={timeline:()=>({})};", "utf-8");
  return sourcePath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("standalone Studio project bootstrap", () => {
  it("creates a persistent empty project that is immediately editable", () => {
    const projectsDir = makeProjectsDir();
    const gsapSourcePath = makeGsapSource(projectsDir);

    expect(ensureStandaloneProject(projectsDir, { gsapSourcePath })).toEqual({
      created: true,
      id: STANDALONE_PROJECT_ID,
    });

    const source = readFileSync(join(projectsDir, STANDALONE_PROJECT_ID, "index.html"), "utf-8");
    expect(source).toContain('data-composition-id="main"');
    expect(source).toContain('data-hf-id="hf-root"');
    expect(source).toContain('data-width="1920"');
    expect(source).toContain('data-height="1080"');
    expect(source).toContain('data-duration="5"');
    expect(source).toContain("width: 1920px");
    expect(source).toContain("height: 1080px");
    expect(source).toContain('<script src="vendor/gsap.min.js"></script>');
    expect(source).toContain("window.__timelines = window.__timelines || {};");
    expect(source).toContain(
      'window.__timelines["main"] = gsap.timeline({ paused: true });',
    );
    expect(source).not.toContain("<template");
    expect(source).not.toMatch(/https?:\/\//);
    expect(readFileSync(join(projectsDir, STANDALONE_PROJECT_ID, "vendor/gsap.min.js"), "utf-8")).toBe(
      "window.gsap={timeline:()=>({})};",
    );
  });

  it("keeps existing projects available while adding the standalone project", () => {
    const projectsDir = makeProjectsDir();
    const existingDir = join(projectsDir, "storyboard-sample");
    mkdirSync(existingDir, { recursive: true });
    writeFileSync(join(existingDir, "index.html"), "existing project", "utf-8");

    ensureStandaloneProject(projectsDir);

    expect(readFileSync(join(existingDir, "index.html"), "utf-8")).toBe("existing project");
    expect(existsSync(join(projectsDir, STANDALONE_PROJECT_ID, "index.html"))).toBe(true);
  });

  it("never overwrites an existing standalone project", () => {
    const projectsDir = makeProjectsDir();
    const projectDir = join(projectsDir, STANDALONE_PROJECT_ID);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "index.html"), "user edit", "utf-8");

    expect(ensureStandaloneProject(projectsDir)).toEqual({
      created: false,
      id: STANDALONE_PROJECT_ID,
    });
    expect(readFileSync(join(projectDir, "index.html"), "utf-8")).toBe("user edit");
  });

  it("migrates only the untouched legacy starter to the valid timeline contract", () => {
    const projectsDir = makeProjectsDir();
    const projectDir = join(projectsDir, STANDALONE_PROJECT_ID);
    const gsapSourcePath = makeGsapSource(projectsDir);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "index.html"),
      LEGACY_STANDALONE_COMPOSITION_SOURCE,
      "utf-8",
    );

    expect(ensureStandaloneProject(projectsDir, { gsapSourcePath })).toEqual({
      created: false,
      id: STANDALONE_PROJECT_ID,
    });

    const source = readFileSync(join(projectDir, "index.html"), "utf-8");
    expect(source).toContain('window.__timelines["main"] = gsap.timeline({ paused: true });');
    expect(existsSync(join(projectDir, "vendor/gsap.min.js"))).toBe(true);
  });

  it("generates the same deterministic starter source every time", () => {
    expect(createStandaloneCompositionSource()).toBe(createStandaloneCompositionSource());
  });

  it("repairs a missing generated runtime without changing the composition", () => {
    const projectsDir = makeProjectsDir();
    const gsapSourcePath = makeGsapSource(projectsDir);
    ensureStandaloneProject(projectsDir, { gsapSourcePath });
    const projectDir = join(projectsDir, STANDALONE_PROJECT_ID);
    const indexPath = join(projectDir, "index.html");
    const sourceBefore = readFileSync(indexPath, "utf-8");
    rmSync(join(projectDir, "vendor/gsap.min.js"));

    ensureStandaloneProject(projectsDir, { gsapSourcePath });

    expect(readFileSync(indexPath, "utf-8")).toBe(sourceBefore);
    expect(existsSync(join(projectDir, "vendor/gsap.min.js"))).toBe(true);
  });

  it("preserves a user-customized local runtime", () => {
    const projectsDir = makeProjectsDir();
    const firstGsapSource = makeGsapSource(projectsDir);
    ensureStandaloneProject(projectsDir, { gsapSourcePath: firstGsapSource });
    const vendorPath = join(projectsDir, STANDALONE_PROJECT_ID, "vendor/gsap.min.js");
    writeFileSync(vendorPath, "user-customized-runtime", "utf-8");
    const replacementPath = join(projectsDir, "replacement-gsap.min.js");
    writeFileSync(replacementPath, "replacement-runtime", "utf-8");

    ensureStandaloneProject(projectsDir, { gsapSourcePath: replacementPath });

    expect(readFileSync(vendorPath, "utf-8")).toBe("user-customized-runtime");
  });
});
