import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { parseExpressionAt } from "acorn";
import { describe, expect, it, vi } from "vitest";

const studioRoot = resolve(import.meta.dirname, "..");
const producerBundles = [
  "node_modules/@hyperframes/producer/dist/index.js",
  "node_modules/@hyperframes/producer/dist/public-server.js",
  "node_modules/@hyperframes/producer/dist/distributed.js",
];

function loadFunction(relativePath: string, declaration: string, bindings: Record<string, unknown>) {
  const source = readFileSync(resolve(studioRoot, relativePath), "utf8");
  const start = source.indexOf(declaration);
  if (start < 0) throw new Error(`Missing ${declaration} in ${relativePath}`);
  const expression = parseExpressionAt(source, start, { ecmaVersion: "latest" });
  return runInNewContext(`(${source.slice(expression.start, expression.end)})`, bindings);
}

describe.each([
  "node_modules/@hyperframes/engine/dist/services/browserManager.js",
  ...producerBundles,
])("background GPU memory probe: %s", (relativePath) => {
  it("keeps hardware detection working without showing a Windows command window", () => {
    const execSync = vi.fn(() => "8192\n");
    const probe = loadFunction(relativePath, "function probeNvidiaVramMb(", {
      _cachedVramMb: null, execSync, execSync2: execSync,
    }) as () => number | null;
    expect(probe()).toBe(8192);
    expect(execSync).toHaveBeenCalledWith(
      "nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits",
      expect.objectContaining({ windowsHide: true, timeout: 3000, stdio: ["pipe", "pipe", "pipe"] }),
    );
    expect(probe()).toBe(8192);
    expect(execSync).toHaveBeenCalledOnce();
  });

  it("still falls back when NVIDIA tooling is unavailable", () => {
    const execSync = vi.fn(() => { throw new Error("nvidia-smi unavailable"); });
    const probe = loadFunction(relativePath, "function probeNvidiaVramMb(", {
      _cachedVramMb: null, execSync, execSync2: execSync,
    }) as () => number | null;
    expect(probe()).toBeNull();
  });
});

describe.each(producerBundles)("background final media probe: %s", (relativePath) => {
  it("keeps the output probe hidden while preserving its result and cancellation signal", async () => {
    const child = { stdout: new EventEmitter() };
    const spawn = vi.fn(() => child);
    const trackChildProcess = vi.fn();
    const managedOptions = vi.fn();
    const probe = loadFunction(relativePath, "async function runFfprobeJson(", {
      spawn8: spawn,
      getFfprobeBinary: () => "C:\\MpVFX\\ffprobe.exe",
      trackChildProcess,
      ManagedChildProcess: class {
        constructor(process: unknown, options: unknown) { managedOptions(process, options); }
        async wait() {
          child.stdout.emit("data", Buffer.from('{"streams":[{"nb_frames":"30"}]}'));
          return { reason: "exit", exitCode: 0 };
        }
      },
    }) as (args: string[], signal: AbortSignal) => Promise<unknown>;
    const signal = new AbortController().signal;
    const args = ["-v", "error", "-of", "json", "--", "C:\\renders\\cut.mp4"];
    await expect(probe(args, signal)).resolves.toEqual({ streams: [{ nb_frames: "30" }] });
    expect(spawn).toHaveBeenCalledWith("C:\\MpVFX\\ffprobe.exe", args, {
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    expect(trackChildProcess).toHaveBeenCalledWith(child);
    expect(managedOptions).toHaveBeenCalledWith(child, expect.objectContaining({ signal, deadlineAtMs: expect.any(Number) }));
  });
});
