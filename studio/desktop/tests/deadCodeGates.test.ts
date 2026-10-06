import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const studioRoot = resolve(import.meta.dirname, "../..");
const repositoryRoot = resolve(studioRoot, "..");

// Mirror of the studio layout that studio/knip.jsonc describes: every `project`
// glob matches at least one file and every plugin config exists, so the REAL
// config file runs against these fixtures verbatim via --config. Package
// versions are fake on purpose: nothing here is ever installed, and knip
// performs no network I/O, so the unused-dependency case needs no download.
// Local stub packages exist only so knip can load (execute) the plugin configs
// that import vite, vitest/config, and tsup, mirroring the real install.
const knipFixturePackage = {
  name: "mpvfx-knip-gate-fixture",
  private: true,
  version: "1.0.0",
  scripts: {
    "build:native": "node native/build.mjs",
    report: "vite-node --version",
    tooling: "cmake --version",
  },
  dependencies: { esbuild: "1.0.0", puppeteer: "1.0.0" },
  devDependencies: {
    "@electron-forge/maker-deb": "1.0.0",
    "@electron-forge/maker-dmg": "1.0.0",
    "@electron-forge/maker-rpm": "1.0.0",
    "@electron-forge/maker-squirrel": "1.0.0",
    autoprefixer: "1.0.0",
    postcss: "1.0.0",
    tailwindcss: "1.0.0",
    tsup: "1.0.0",
    vite: "1.0.0",
    vitest: "1.0.0",
  },
};

const knipFixtureFiles: Record<string, string> = {
  "desktop/main.ts": 'import "../runtime/index";\nimport "../shared/util";\nimport "../src/app.css";\n',
  "desktop/preload.ts": 'import "../shared/util";\n',
  "runtime/index.ts": 'import "../shared/util";\nexport const runtime = 1;\n',
  "shared/util.ts": "export const shared = 1;\n",
  "src/app.css": "/* gate fixture style */\n",
  "src/features/project/nativeExportFrameRuntime.entry.ts":
    'import { installX } from "./nativeExportFrameRuntime";\n(globalThis as Record<string, unknown>).__x = installX;\n',
  "src/features/project/nativeExportFrameRuntime.ts": "export function installX(): void {}\n",
  "native/build.mjs":
    'import { spawnSync } from "node:child_process";\nimport { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\nspawnSync("cmake", ["--version"]);\nrequire.resolve("@electron/node-gyp/bin/node-gyp.js");\n',
  ".configurations/forge.config.cjs": "module.exports = {};\n",
  ".configurations/vite.config.ts": 'import { defineConfig } from "vite";\nexport default defineConfig({});\n',
  ".configurations/vitest.config.ts":
    'import { defineConfig } from "vitest/config";\nexport default defineConfig({});\n',
  ".configurations/vitest.runtime.config.ts":
    'import { defineConfig } from "vitest/config";\nexport default defineConfig({});\n',
  ".configurations/tsup.desktop.config.ts":
    'import { defineConfig } from "tsup";\nexport default defineConfig({});\n',
  ".configurations/postcss.config.js": "export default { plugins: { tailwindcss: {}, autoprefixer: {} } };\n",
  ".configurations/tailwind.config.js":
    "/** @type {import('tailwindcss').Config} */\nexport default { content: [] };\n",
  ".puppeteerrc.cjs": "module.exports = {};\n",
  "tests/e2e/smoke.mjs": 'console.log("smoke");\n',
  "node_modules/vite/package.json": '{"name":"vite","version":"1.0.0","main":"index.js"}',
  "node_modules/vite/index.js": "module.exports = { defineConfig: (c) => c };\n",
  "node_modules/vitest/package.json":
    '{"name":"vitest","version":"1.0.0","exports":{".":"./index.js","./config":"./config.js"}}',
  "node_modules/vitest/index.js": "module.exports = {};\n",
  "node_modules/vitest/config.js": "module.exports = { defineConfig: (c) => c, mergeConfig: (a) => a };\n",
  "node_modules/tsup/package.json": '{"name":"tsup","version":"1.0.0","main":"index.js"}',
  "node_modules/tsup/index.js": "module.exports = { defineConfig: (c) => c };\n",
};

function writeKnipFixture(): string {
  const fixture = mkdtempSync(join(tmpdir(), "mpvfx-knip-gate-"));
  writeFileSync(resolve(fixture, "package.json"), `${JSON.stringify(knipFixturePackage, null, 2)}\n`);
  for (const [name, content] of Object.entries(knipFixtureFiles)) {
    const path = resolve(fixture, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return fixture;
}

/** Runs the repo's knip binary with the REAL studio/knip.jsonc and the REAL
 * gate flags parsed from studio/package.json's check:knip script. cwd (not
 * knip's --directory, which breaks import-graph resolution) is the fixture. */
function runKnipGate(fixture: string) {
  const knipEntry = resolve(studioRoot, "node_modules/knip/bin/knip.js");
  expect(existsSync(knipEntry)).toBe(true);
  const pkg = JSON.parse(readFileSync(resolve(studioRoot, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const flags = pkg.scripts["check:knip"].replace(/^knip\s+/, "").split(/\s+/);
  return spawnSync(
    process.execPath,
    [knipEntry, "--config", resolve(studioRoot, "knip.jsonc"), "--no-progress", ...flags],
    { cwd: fixture, encoding: "utf8" },
  );
}

function writeArchitectureFixture(withViolation: boolean): string {
  const fixture = mkdtempSync(join(tmpdir(), "mpvfx-architecture-gate-"));
  const files: Record<string, string> = {
    "shared/util.ts": "export const shared = 1;\n",
    "runtime/secret.ts": "export const secret = 1;\n",
    "desktop/ok.ts": "export {};\n",
    "src/renderer/good.ts": 'import "../../shared/util";\n',
  };
  if (withViolation) files["src/renderer/bad.ts"] = 'import "../../runtime/secret";\n';
  for (const [name, content] of Object.entries(files)) {
    const path = resolve(fixture, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return fixture;
}

function loadArchitectureChecker() {
  return createRequire(import.meta.url)(
    resolve(repositoryRoot, "scripts/verification_checks/check-architecture.mjs"),
  ) as {
    inspectArchitecture(root: string): { files: number; problems: string[] };
    checkDependency(file: string, specifier: string): string | null;
  };
}

function readKnipConfig() {
  const text = readFileSync(resolve(studioRoot, "knip.jsonc"), "utf8");
  return JSON.parse(text.replace(/^\s*\/\/.*$/gm, "")) as {
    entry: string[];
    project: string[];
    ignoreDependencies: string[];
    ignoreBinaries: string[];
  };
}

describe("dead-code gates", () => {
  it("passes the real knip gate on a clean fixture", { timeout: 120_000 }, () => {
    const fixture = writeKnipFixture();
    try {
      const result = runKnipGate(fixture);
      expect(`${result.stdout}\n${result.stderr}`).toBe("\n");
      expect(result.status).toBe(0);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("fails check:knip naming an unreachable source file", { timeout: 120_000 }, () => {
    const fixture = writeKnipFixture();
    try {
      writeFileSync(resolve(fixture, "src/nowhere.ts"), "export const orphan = 1;\n");
      const result = runKnipGate(fixture);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain("Unused files");
      expect(result.stdout).toContain("src/nowhere.ts");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("fails a declared-but-unused dependency without installing anything", { timeout: 120_000 }, () => {
    const fixture = writeKnipFixture();
    try {
      const manifestPath = resolve(fixture, "package.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        dependencies: Record<string, string>;
      };
      manifest.dependencies["mpvfx-fixture-unused-dep"] = "1.0.0";
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const result = runKnipGate(fixture);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain("Unused dependencies");
      expect(result.stdout).toContain("mpvfx-fixture-unused-dep");
      expect(existsSync(resolve(fixture, "node_modules/mpvfx-fixture-unused-dep"))).toBe(false);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("fails a forbidden renderer-to-runtime import", () => {
    const { inspectArchitecture, checkDependency } = loadArchitectureChecker();
    expect(checkDependency("src/renderer/bad.ts", "../../runtime/secret")).toContain(
      "src may depend only on src, shared",
    );
    const fixture = writeArchitectureFixture(true);
    try {
      const { problems } = inspectArchitecture(fixture);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("src/renderer/bad.ts");
      expect(problems[0]).toContain("src may depend only on src, shared");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("passes a permitted shared import", () => {
    const { inspectArchitecture, checkDependency } = loadArchitectureChecker();
    expect(checkDependency("src/renderer/good.ts", "../../shared/util")).toBeNull();
    const fixture = writeArchitectureFixture(false);
    try {
      expect(inspectArchitecture(fixture).problems).toEqual([]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("propagates a failed gate through the publication hook", { timeout: 180_000 }, () => {
    const probe = resolve(studioRoot, "src/__publicationGateProbe.ts");
    writeFileSync(probe, 'import "../runtime/environment";\n');
    try {
      const result = spawnSync("sh", [resolve(repositoryRoot, ".githooks/check-publication")], {
        cwd: repositoryRoot,
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("__publicationGateProbe");
    } finally {
      rmSync(probe, { force: true });
    }
  });

  it("justifies every knip entry with a real file and consumer", () => {
    const { entry } = readKnipConfig();
    expect(entry).toContain("desktop/main.ts");
    expect(entry).toContain("desktop/preload.ts");
    expect(entry).toContain("src/features/project/nativeExportFrameRuntime.entry.ts");
    expect(entry).toContain(".configurations/forge.config.cjs");
    expect(entry).toContain(".puppeteerrc.cjs");
    expect(entry).toContain("tests/e2e/*.mjs");

    const tsup = readFileSync(resolve(studioRoot, ".configurations/tsup.desktop.config.ts"), "utf8");
    expect(tsup).toContain("../desktop/main.ts");
    expect(tsup).toContain("../desktop/preload.ts");
    expect(readFileSync(resolve(studioRoot, "desktop/main.ts"), "utf8")).toContain("preload");
    expect(
      readFileSync(resolve(studioRoot, "src/features/project/nativeExportFrameRuntime.entry.ts"), "utf8"),
    ).toContain("installNativeExportFrameRuntime");
    expect(
      readFileSync(resolve(repositoryRoot, "scripts/build/build-native-export-frame-runtime.mjs"), "utf8"),
    ).toContain("src/features/project/nativeExportFrameRuntime.entry.ts");
    expect(
      readdirSync(resolve(studioRoot, "tests/e2e")).filter((name) => name.endsWith(".mjs")).length,
    ).toBeGreaterThan(0);
    for (const name of ["desktop/main.ts", "desktop/preload.ts", ".configurations/forge.config.cjs", ".puppeteerrc.cjs"]) {
      expect(existsSync(resolve(studioRoot, name))).toBe(true);
    }
  });

  it("justifies every ignored dependency with a real consumer", () => {
    const { ignoreDependencies } = readKnipConfig();
    expect([...ignoreDependencies].sort()).toEqual([
      "@electron-forge/maker-deb",
      "@electron-forge/maker-dmg",
      "@electron-forge/maker-rpm",
      "@electron-forge/maker-squirrel",
      "@electron/node-gyp",
      "esbuild",
      "puppeteer",
    ]);

    const frameBuild = readFileSync(
      resolve(repositoryRoot, "scripts/build/build-native-export-frame-runtime.mjs"),
      "utf8",
    );
    expect(frameBuild).toContain('"esbuild"');
    expect(
      readFileSync(
        resolve(repositoryRoot, "scripts/verification_checks/verify-packaged-runtime-dependencies.cjs"),
        "utf8",
      ),
    ).toContain("esbuild");

    const forge = readFileSync(resolve(studioRoot, ".configurations/forge.config.cjs"), "utf8");
    for (const maker of ["maker-deb", "maker-dmg", "maker-rpm", "maker-squirrel"]) {
      expect(forge).toContain(`"@electron-forge/${maker}"`);
    }
    expect(forge).toContain(".puppeteer-cache/chrome-headless-shell");
    const puppeteerRc = readFileSync(resolve(studioRoot, ".puppeteerrc.cjs"), "utf8");
    expect(puppeteerRc).toContain("cacheDirectory");
    expect(puppeteerRc).toContain("chrome-headless-shell");
    expect(readFileSync(resolve(studioRoot, "runtime/preview/browser.ts"), "utf8")).toContain("puppeteer-core");

    for (const build of ["native/vkf/build.mjs", "native/library/build.mjs"]) {
      expect(readFileSync(resolve(studioRoot, build), "utf8")).toContain("@electron/node-gyp/bin/node-gyp.js");
    }
  });

  it("justifies every ignored binary with a real consumer", () => {
    const { ignoreBinaries } = readKnipConfig();
    expect([...ignoreBinaries].sort()).toEqual(["cmake", "vite-node"]);

    for (const build of ["native/vkf/build.mjs", "native/library/build.mjs"]) {
      expect(readFileSync(resolve(studioRoot, build), "utf8")).toContain('"cmake"');
    }
    const pkg = JSON.parse(readFileSync(resolve(studioRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["report:sdk-cutover"]).toContain("vite-node");
  });

  it("runs the publication hook gates under the MPVFX_NODE-selected runtime", () => {
    const hook = readFileSync(resolve(repositoryRoot, ".githooks/check-publication"), "utf8");
    expect(hook).toContain('export PATH="$(dirname "$node_binary"):$PATH"');
    expect(hook).toContain("npm --prefix studio run check:architecture");
    expect(hook).toContain("npm --prefix studio run check:knip");
  });
});
