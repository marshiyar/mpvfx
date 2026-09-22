import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import { runInNewContext } from "node:vm";
import { parseExpressionAt } from "acorn";
import { afterEach, describe, expect, it, vi } from "vitest";

const studioRoot = resolve(import.meta.dirname, "..");
const launchers = [
  "node_modules/@puppeteer/browsers/lib/launch.js",
  "node_modules/@hyperframes/producer/dist/index.js",
  "node_modules/@hyperframes/producer/dist/public-server.js",
  "node_modules/@hyperframes/producer/dist/distributed.js",
];

// Exercise the actual installed launcher, including the copies inlined into
// producer bundles. Mock only the OS boundary so this regression runs on macOS
// and Linux too; a native Windows export remains the final UI acceptance check.
function loadLauncher(relativePath: string, platform: NodeJS.Platform) {
  const source = readFileSync(resolve(studioRoot, relativePath), "utf8");
  const spawnIndex = source.indexOf("this.#browserProcess = childProcess.spawn(");
  const classStart = source.lastIndexOf("class ", spawnIndex);
  if (spawnIndex < 0 || classStart < 0) throw new Error(`Missing browser launcher: ${relativePath}`);
  const expression = parseExpressionAt(source, classStart, { ecmaVersion: "latest" });
  const classSource = source.slice(expression.start, expression.end);
  const child = Object.assign(new EventEmitter(), {
    pid: 12345,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  const spawn = vi.fn(() => child);
  const execSync = vi.fn();
  const kill = vi.fn();
  const subscribe = vi.fn();
  const unsubscribe = vi.fn();
  const bindings: Record<string, unknown> = {
    process: { platform, kill },
    childProcess: { spawn, execSync },
    pidExists: () => true,
    subscribeToProcessEvent: subscribe,
    unsubscribeFromProcessEvent: unsubscribe,
  };
  for (const name of classSource.match(/\bEventEmitter\d*\b/g) ?? []) bindings[name] = EventEmitter;
  for (const name of classSource.match(/\breadline\d*\b/g) ?? []) bindings[name] = readline;
  const Launcher = runInNewContext(`(${classSource})`, bindings) as new (options: {
    executablePath: string;
    args: string[];
  }) => { hasClosed(): Promise<void>; getRecentLogs(): string[]; kill(): void };
  return { Launcher, child, spawn, execSync, kill, subscribe, unsubscribe };
}

describe.each(launchers)("background browser process: %s", (relativePath) => {
  it.each(["win32", "darwin", "linux"] as const)(
    "uses the correct process group on %s while preserving diagnostics and cleanup",
    async (platform) => {
      const { Launcher, child, spawn, execSync, kill, subscribe, unsubscribe } = loadLauncher(relativePath, platform);
      const browser = new Launcher({ executablePath: "chrome-headless-shell", args: ["--headless"] });
      try {
        expect(spawn).toHaveBeenCalledWith("chrome-headless-shell", ["--headless"], expect.objectContaining({
          detached: platform !== "win32",
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        }));
        child.stderr.write("GPU diagnostic remains available\n");
        expect(browser.getRecentLogs()).toContain("GPU diagnostic remains available");
        expect(subscribe).toHaveBeenCalledWith("exit", expect.any(Function));
        browser.kill();
        if (platform === "win32") {
          expect(execSync).toHaveBeenCalledWith("taskkill /pid 12345 /T /F", { windowsHide: true });
          expect(kill).not.toHaveBeenCalled();
        } else {
          expect(kill).toHaveBeenCalledWith(-12345, "SIGKILL");
          expect(execSync).not.toHaveBeenCalled();
        }
      } finally {
        child.stdout.end();
        child.stderr.end();
        child.emit("exit", 0);
        await browser.hasClosed();
      }
      expect(unsubscribe).toHaveBeenCalledWith("exit", expect.any(Function));
    },
  );
});

describe("Windows browser packaging guard", () => {
  const { applyWindowsBrowserLaunchPolicy, assertWindowsBrowserLaunchPolicy } = createRequire(import.meta.url)(
    "../scripts/apply-windows-browser-patch.cjs",
  ) as {
    applyWindowsBrowserLaunchPolicy(root: string): void;
    assertWindowsBrowserLaunchPolicy(root: string): void;
  };
  const roots: string[] = [];
  const guardedTargets = [
    ...launchers,
    "node_modules/@hyperframes/engine/dist/services/browserManager.js",
    "node_modules/@hyperframes/engine/dist/utils/psnrFilterAvailability.js",
    "node_modules/@hyperframes/engine/dist/utils/psnr.js",
  ];
  const unpatched = [
    "opts.detached ??= true;",
    'childProcess.execSync(`taskkill /pid ${this.#browserProcess.pid} /T /F`);',
    'execSync("nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits", {});',
    'spawn(getFfprobeBinary(), args, { stdio: ["ignore", "pipe", "pipe"] });',
    'execFileP(getFfmpegBinary(), ["-hide_banner", "-filters"], {});',
    'execFileP(getFfmpegBinary(), [], { maxBuffer: 4 * 1024 * 1024 });',
  ].join("\n");
  function createFixture() {
    const root = mkdtempSync(join(tmpdir(), "mpvfx-browser-policy-"));
    roots.push(root);
    for (const relativePath of guardedTargets) {
      const path = resolve(root, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, unpatched);
    }
    return root;
  }
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("repairs fresh dependencies and can run again before packaging", () => {
    const root = createFixture();
    expect(() => assertWindowsBrowserLaunchPolicy(root)).toThrow(/Windows consoles/);
    applyWindowsBrowserLaunchPolicy(root);
    const patched = guardedTargets.map((path) => readFileSync(resolve(root, path), "utf8"));
    expect(() => assertWindowsBrowserLaunchPolicy(root)).not.toThrow();
    applyWindowsBrowserLaunchPolicy(root);
    expect(guardedTargets.map((path) => readFileSync(resolve(root, path), "utf8"))).toEqual(patched);
  });

  it("rejects a package if any bundled producer launcher loses the patch", () => {
    const root = createFixture();
    applyWindowsBrowserLaunchPolicy(root);
    for (const relativePath of guardedTargets) {
      const path = resolve(root, relativePath);
      const patched = readFileSync(path, "utf8");
      writeFileSync(path, unpatched);
      expect(() => assertWindowsBrowserLaunchPolicy(root)).toThrow(/Windows consoles/);
      writeFileSync(path, patched);
    }
  });

  it("stops on an upstream launcher change before modifying any dependency", () => {
    const root = createFixture();
    writeFileSync(resolve(root, guardedTargets.at(-1)!), "// Upstream launcher implementation changed");
    expect(() => applyWindowsBrowserLaunchPolicy(root)).toThrow(/Unsupported Windows browser launch policy/);
    expect(readFileSync(resolve(root, launchers[0]!), "utf8")).toBe(unpatched);
    expect(() => assertWindowsBrowserLaunchPolicy(root)).toThrow();
  });
});
