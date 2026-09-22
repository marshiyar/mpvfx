import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
const { targets, applyAudioAnimationHandles, assertAudioAnimationHandles } = createRequire(
  import.meta.url,
)("../scripts/apply-audio-animation-handles-patch.cjs") as {
  targets: { path: string; pair: [string, string]; kind?: string }[];
  applyAudioAnimationHandles(root: string): void;
  assertAudioAnimationHandles(root: string): void;
};
const root = resolve(import.meta.dirname, "..");
const scratch: string[] = [];
const manifestPath = "node_modules/@hyperframes/producer/dist/hyperframe.manifest.json";
const runtimePath = "node_modules/@hyperframes/producer/dist/hyperframe.runtime.iife.js";
const sha256 = (source: string) => createHash("sha256").update(source).digest("hex");
afterEach(() => {
  scratch.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true }));
});
describe("audio curve persistence in preview and export runtimes", () => {
  it("retains signed times in embedded preview and offline audio-effect runtimes", () => {
    for (const path of [
      "core/dist/generated/runtime-inline.js",
      "core/dist/generated/audio-fx-runtime-inline.js",
      "producer/dist/index.js",
      "producer/dist/public-server.js",
      "producer/dist/distributed.js",
    ]) {
      expect(readFileSync(join(root, "node_modules/@hyperframes", path), "utf8"))
        .not.toMatch(/t:Math\.max\(0,\w+\)/);
    }
  });
  it("keeps the producer's integrity manifest valid for the patched runtime", () => {
    const manifest = JSON.parse(readFileSync(join(root, manifestPath), "utf8"));
    expect(manifest.sha256).toBe(sha256(readFileSync(join(root, runtimePath), "utf8")));
  });
  it("does not clip PCM volume-envelope handles during conversion to clip-local time", () => {
    const source = readFileSync(join(root, "node_modules/@hyperframes/core/dist/runtime/mediaVolumeEnvelope.js"), "utf8");
    const fn = source.slice(source.indexOf("function normaliseEnvelope("), source.indexOf("/**", source.indexOf("function normaliseEnvelope(")));
    const envelope = runInNewContext(`(${fn})([{time:0,volume:0.2},{time:1.25,volume:1}],0.5,1)`, { clampAudioGain: (v: number) => v });
    expect(envelope).toEqual([{time:-0.5,volume:0.2},{time:0.75,volume:1}]);
  });
  it.each(targets)("keeps signed time in the installed $path ($kind)", ({ path, pair, kind }) => {
    const source = readFileSync(join(root, path), "utf8");
    expect(source).toContain(pair[1]);
    expect(source).not.toContain(pair[0]);
    // Execute the installed normalizer's return, including minified runtime copies.
    const statement = source.slice(
      source.indexOf(pair[1]),
      source.indexOf(pair[1]) + pair[1].length,
    );
    if (kind === "envelope") {
      const result = runInNewContext(`({${statement}})`, {
        k: { time: 1 }, o: { time: 1 }, keyframe: { time: 1 },
        trackStart: 3.5, t: 3.5, track: { start: 3.5 }, trimDuration: 1,
      });
      expect(result).toEqual({ time: -2.5 });
      return;
    }
    const result = runInNewContext(`(function(){${statement}\n})()`, {
      t: -2.5,
      n: -2.5,
      clamped: 0.4,
      i: 0.4,
      a: 0.4,
      p: {},
      e: {},
      shapeFields: () => ({ curve: 0.7 }),
      wp: () => ({ curve: 0.7 }),
      Le: () => ({ curve: 0.7 }),
    });
    expect(result).toEqual({ t: -2.5, v: 0.4, curve: 0.7 });
  });
  it("repairs fresh dependencies idempotently and refuses incomplete upgrades before writing", () => {
    const dir = mkdtempSync(join(tmpdir(), "audio-handles-"));
    scratch.push(dir);
    for (const { path, pair } of targets) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), `${pair[0]}\n`, { flag: "a" });
    }
    writeFileSync(join(dir, manifestPath), JSON.stringify({
      artifacts: { iife: "hyperframe.runtime.iife.js" },
      sha256: sha256(readFileSync(join(dir, runtimePath), "utf8")),
    }));
    expect(() => assertAudioAnimationHandles(dir)).toThrow();
    applyAudioAnimationHandles(dir);
    applyAudioAnimationHandles(dir);
    expect(() => assertAudioAnimationHandles(dir)).not.toThrow();
    const manifest = JSON.parse(readFileSync(join(dir, manifestPath), "utf8"));
    expect(manifest.sha256).toBe(sha256(readFileSync(join(dir, runtimePath), "utf8")));
    writeFileSync(join(dir, targets[0]!.path), targets[0]!.pair[0]);
    writeFileSync(join(dir, targets.at(-1)!.path), "upstream changed");
    expect(() => applyAudioAnimationHandles(dir)).toThrow(/Unsupported/);
    expect(readFileSync(join(dir, targets[0]!.path), "utf8")).toBe(targets[0]!.pair[0]);
  });
  it("refuses a mismatched integrity manifest instead of legitimizing an unknown runtime", () => {
    const dir = mkdtempSync(join(tmpdir(), "audio-handles-integrity-"));
    scratch.push(dir);
    for (const { path, pair } of targets) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), `${pair[0]}\n`, { flag: "a" });
    }
    writeFileSync(join(dir, manifestPath), JSON.stringify({
      artifacts: { iife: "hyperframe.runtime.iife.js" }, sha256: "0".repeat(64),
    }));
    expect(() => applyAudioAnimationHandles(dir)).toThrow(/integrity|checksum/i);
    expect(readFileSync(join(dir, targets[0]!.path), "utf8")).toBe(`${targets[0]!.pair[0]}\n`);
  });
});
