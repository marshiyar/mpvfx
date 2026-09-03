import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  main: string;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

describe("cross-platform Electron packaging", () => {
  it("builds a desktop entrypoint and never starts npm or Vite inside the installed app", () => {
    expect(pkg.main).toBe("desktop-dist/main.js");
    expect(pkg.scripts).toMatchObject({
      "desktop:dev": expect.any(String),
      "desktop:build": expect.any(String),
      "desktop:package": expect.any(String),
      "desktop:make": expect.any(String),
    });
    expect(pkg.scripts["desktop:dev"]).toContain("electron");
    expect(pkg.scripts["desktop:build"]).toContain("desktop:compile");
  });

  it("pins Forge packaging to the supported Node 22 toolchain", () => {
    expect(readFileSync(resolve(root, ".nvmrc"), "utf8").trim()).toMatch(/^22\./);
    expect(pkg.scripts["desktop:package"]).toContain("check-desktop-packaging-node");
    expect(pkg.scripts["desktop:make"]).toContain("check-desktop-packaging-node");
  });

  it("declares native makers for macOS, Windows, and Linux", () => {
    const config = createRequire(import.meta.url)(resolve(root, "forge.config.cjs")) as {
      packagerConfig: { asar: unknown; ignore: RegExp[]; extraResource?: string[] };
      hooks?: { postPackage?: unknown };
      makers: Array<{ name: string; platforms?: string[] }>;
    };
    const makers = new Map(config.makers.map((maker) => [maker.name, maker.platforms]));

    expect(config.packagerConfig.asar).toBeTruthy();
    expect(config.packagerConfig.extraResource).toContain("resources/legal");
    expect(config.hooks?.postPackage).toBeTypeOf("function");
    expect(makers.get("@electron-forge/maker-dmg")).toContain("darwin");
    expect(makers.get("@electron-forge/maker-squirrel")).toContain("win32");
    expect(makers.get("@electron-forge/maker-deb")).toContain("linux");
    expect(makers.get("@electron-forge/maker-rpm")).toContain("linux");
  });

  it("fails packaging when required legal notices are missing from the application", () => {
    const forgeSource = readFileSync(resolve(root, "forge.config.cjs"), "utf8");

    expect(forgeSource).toContain("assertPackagedLegalResources");
    expect(existsSync(resolve(root, "scripts/verify-packaged-legal.cjs"))).toBe(true);
  });

  it("keeps server-side editor and media tooling in production dependencies", () => {
    for (const name of [
      "@hyperframes/producer",
      "esbuild",
      "chokidar",
      "puppeteer-core",
      "ffmpeg-static",
      "@ffprobe-installer/ffprobe",
      "onnxruntime-node",
      "sharp",
    ]) {
      expect(pkg.dependencies, name).toHaveProperty(name);
      expect(pkg.devDependencies, name).not.toHaveProperty(name);
    }
    expect(pkg.devDependencies).toHaveProperty("electron");
    expect(pkg.devDependencies).toHaveProperty("@electron-forge/cli");
    expect(pkg.dependencies).not.toHaveProperty("ffprobe-static");
  });

  it("unpacks the esbuild package and its platform executable for producer runtime imports", () => {
    const config = createRequire(import.meta.url)(resolve(root, "forge.config.cjs")) as {
      packagerConfig: { asar: { unpack?: string } };
    };
    const unpack = config.packagerConfig.asar.unpack ?? "";

    expect(unpack).toContain("esbuild");
    expect(unpack).toContain("@esbuild/**");
  });

  it("verifies the packaged top-level esbuild module and native executable", () => {
    const forgeSource = readFileSync(resolve(root, "forge.config.cjs"), "utf8");
    expect(forgeSource).toContain("assertPackagedRuntimeDependencies");

    const verifier = createRequire(import.meta.url)(
      resolve(root, "scripts/verify-packaged-runtime-dependencies.cjs"),
    ) as {
      packagedEsbuildPaths(
        outputPath: string,
        platform: string,
        arch: string,
      ): Record<string, string>;
    };
    expect(verifier.packagedEsbuildPaths("/tmp/MpVFX-darwin-arm64", "darwin", "arm64")).toEqual({
      archive: "/tmp/MpVFX-darwin-arm64/MpVFX.app/Contents/Resources/app.asar",
      packageEntry: "node_modules/esbuild/package.json",
      jsEntry: "node_modules/esbuild/lib/main.js",
      binary:
        "/tmp/MpVFX-darwin-arm64/MpVFX.app/Contents/Resources/app.asar.unpacked/node_modules/@esbuild/darwin-arm64/bin/esbuild",
    });
  });

  it("establishes bundled binary paths before loading any server or render dependency", () => {
    const mainSource = readFileSync(resolve(root, "desktop/main.ts"), "utf8");

    expect(mainSource).not.toMatch(/^import .*\.\/editorServer/m);
    expect(mainSource).not.toMatch(/^import .*\.\.\/vite\.browser/m);
    const environmentIndex = mainSource.indexOf("applyDesktopRuntimeEnvironment(");
    const assertionIndex = mainSource.indexOf("assertBundledMediaBinariesAvailable()");
    const serverImportIndex = mainSource.indexOf('await import("./editorServer")');
    const browserImportIndex = mainSource.indexOf('await import("../vite.browser")');

    expect(environmentIndex).toBeGreaterThan(-1);
    expect(assertionIndex).toBeGreaterThan(environmentIndex);
    expect(serverImportIndex).toBeGreaterThan(assertionIndex);
    expect(browserImportIndex).toBeGreaterThan(assertionIndex);
  });

  it("uses a native Apple-Silicon FFprobe instead of an x86 binary in an arm64 package", () => {
    if (process.platform !== "darwin" || process.arch !== "arm64") return;
    const ffprobe = createRequire(import.meta.url)("@ffprobe-installer/ffprobe") as {
      path: string;
    };
    const header = readFileSync(ffprobe.path).subarray(0, 8);

    expect(header.readUInt32LE(0)).toBe(0xfeedfacf);
    expect(header.readUInt32LE(4)).toBe(0x0100000c);
  });

  it.each([
    ["darwin", "arm64", (() => {
      const header = Buffer.alloc(32);
      header.writeUInt32LE(0xfeedfacf, 0);
      header.writeUInt32LE(0x0100000c, 4);
      return header;
    })()],
    ["linux", "x64", (() => {
      const header = Buffer.alloc(64);
      header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
      header.writeUInt16LE(62, 18);
      return header;
    })()],
    ["win32", "x64", (() => {
      const header = Buffer.alloc(256);
      header.write("MZ", 0, "ascii");
      header.writeUInt32LE(128, 0x3c);
      header.write("PE\0\0", 128, "binary");
      header.writeUInt16LE(0x8664, 132);
      return header;
    })()],
  ] as const)("accepts a matching %s-%s executable header", (platform, arch, header) => {
    const verifier = createRequire(import.meta.url)(
      resolve(root, "scripts/verify-packaged-media-binaries.cjs"),
    ) as {
      assertExecutableBufferMatchesTarget(
        name: string,
        header: Buffer,
        platform: string,
        arch: string,
      ): void;
    };

    expect(() =>
      verifier.assertExecutableBufferMatchesTarget("FFmpeg", header, platform, arch),
    ).not.toThrow();
  });

  it("rejects a bundled executable built for a different platform or architecture", () => {
    const verifier = createRequire(import.meta.url)(
      resolve(root, "scripts/verify-packaged-media-binaries.cjs"),
    ) as {
      assertExecutableBufferMatchesTarget(
        name: string,
        header: Buffer,
        platform: string,
        arch: string,
      ): void;
    };
    const arm64MachO = Buffer.alloc(32);
    arm64MachO.writeUInt32LE(0xfeedfacf, 0);
    arm64MachO.writeUInt32LE(0x0100000c, 4);

    expect(() =>
      verifier.assertExecutableBufferMatchesTarget("FFmpeg", arm64MachO, "darwin", "x64"),
    ).toThrow(/FFmpeg.*darwin-x64.*darwin-arm64/i);
    expect(() =>
      verifier.assertExecutableBufferMatchesTarget("FFmpeg", arm64MachO, "linux", "arm64"),
    ).toThrow(/FFmpeg.*linux-arm64.*darwin-arm64/i);
  });

  it("rejects a packaged renderer that contains the removed off-canvas selector", () => {
    const verifier = createRequire(import.meta.url)(
      resolve(root, "scripts/verify-packaged-renderer.cjs"),
    ) as {
      assertRendererArchiveBuffer(buffer: Buffer, archivePath: string): void;
    };

    expect(() =>
      verifier.assertRendererArchiveBuffer(
        Buffer.from("aria-label=\"Select off-canvas element index.html:clip:0\""),
        "/tmp/MpVFX.app/Contents/Resources/app.asar",
      ),
    ).toThrow(/removed off-canvas editor overlay/i);
    expect(() =>
      verifier.assertRendererArchiveBuffer(
        Buffer.from("aria-label=\"Apply crop\""),
        "/tmp/MpVFX.app/Contents/Resources/app.asar",
      ),
    ).not.toThrow();
  });
});
