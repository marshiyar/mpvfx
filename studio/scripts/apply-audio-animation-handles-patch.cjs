const { readFileSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { createHash } = require("node:crypto");

// Clip-local automation can precede In after a trim/split. The evaluator already
// supports signed times; the upstream normalizer clamped them to zero, changing
// both interpolation and subsequent trim-extension. Patch every runtime copy so
// preview, persistence, and rendered audio consume the same authored curve.
const plain = [
  "return { t: Math.max(0, t), v: clamped, ...shapeFields(p) };",
  "return { t, v: clamped, ...shapeFields(p) }; // MpVFX: preserve animation handles",
];
const bundled = [
  "return{t:Math.max(0,n),v:i,...wp(e)}",
  "return{t:n,v:i,...wp(e)}/*MpVFX: preserve animation handles*/",
];
const bundledFx = [
  "return{t:Math.max(0,n),v:a,...Le(e)}",
  "return{t:n,v:a,...Le(e)}/*MpVFX: preserve animation handles*/",
];
const volume = [
  "time: Math.max(0, k.time - trackStart)",
  "time: k.time - trackStart /*MpVFX: preserve volume handles*/",
];
const bundledVolume = [
  "time:Math.max(0,o.time-t)",
  "time:o.time-t/*MpVFX: preserve volume handles*/",
];
const fallbackVolume = [
  "time: Math.max(0, Math.min(trimDuration, keyframe.time - track.start))",
  "time: keyframe.time - track.start /*MpVFX: preserve volume handles*/",
];
const producerPaths = ["index.js", "public-server.js", "distributed.js"]
  .map(file => `node_modules/@hyperframes/producer/dist/${file}`);
const targets = [
  { path: "node_modules/@hyperframes/core/dist/audioAutomation.js", pair: plain },
  ...producerPaths.map(path => ({ path, pair: plain })),
  ...["core", "producer"].map(pkg => ({ path: `node_modules/@hyperframes/${pkg}/dist/hyperframe.runtime.iife.js`, pair: bundled })),
  { path: "node_modules/@hyperframes/core/dist/generated/runtime-inline.js", pair: bundled },
  { path: "node_modules/@hyperframes/core/dist/generated/audio-fx-runtime-inline.js", pair: bundledFx },
  ...producerPaths.map(path => ({ path, pair: bundledFx })),
  { path: "node_modules/@hyperframes/core/dist/runtime/mediaVolumeEnvelope.js", pair: volume, kind: "envelope" },
  ...producerPaths.map(path => ({ path, pair: volume, kind: "envelope" })),
  ...["core/dist/hyperframe.runtime.iife.js", "core/dist/generated/runtime-inline.js", "producer/dist/hyperframe.runtime.iife.js"]
    .map(path => ({ path: `node_modules/@hyperframes/${path}`, pair: bundledVolume, kind: "envelope" })),
  ...producerPaths.map(path => ({ path, pair: fallbackVolume, kind: "envelope" })),
];
const runtimePath = "node_modules/@hyperframes/producer/dist/hyperframe.runtime.iife.js";
const manifestPath = "node_modules/@hyperframes/producer/dist/hyperframe.manifest.json";
const sha256 = (source) => createHash("sha256").update(source, "utf8").digest("hex");

function runtimeManifestPatch(root, runtime) {
  const full = join(root, manifestPath);
  const source = readFileSync(full, "utf8");
  const manifest = JSON.parse(source);
  // Accept the verified upstream bytes or this exact patch's bytes. Never
  // disable the producer integrity check or bless an unrelated modification.
  const original = targets.filter(target => target.path === runtimePath)
    .reduce((source, { pair }) => source.replace(pair[1], pair[0]), runtime.source);
  const digest = sha256(runtime.patched);
  if (
    manifest.artifacts?.iife !== "hyperframe.runtime.iife.js" ||
    ![sha256(runtime.source), sha256(original), digest].includes(manifest.sha256)
  ) throw new Error("Audio runtime integrity checksum does not match the supported artifact");
  return {
    full,
    source,
    patched: manifest.sha256 === digest
      ? source
      : `${JSON.stringify({ ...manifest, sha256: digest }, null, 2)}\n`,
  };
}
function patchAudioAnimationHandles(source, pair, name) {
  const [before, after] = pair;
  const oldCount = source.split(before).length - 1;
  const newCount = source.split(after).length - 1;
  if (newCount === 1 && oldCount === 0) return source;
  if (oldCount !== 1 || newCount !== 0) throw new Error(`Unsupported audio automation normalizer in ${name}; review the dependency before shipping`);
  return source.replace(before, after);
}
function applyAudioAnimationHandles(root = resolve(__dirname, "..")) {
  const byPath = new Map();
  for (const { path, pair } of targets) {
    const full = join(root, path);
    const existing = byPath.get(path);
    const source = existing?.source ?? readFileSync(full, "utf8");
    byPath.set(path, {
      path, full, source,
      patched: patchAudioAnimationHandles(existing?.patched ?? source, pair, path),
    });
  }
  const patches = [...byPath.values()];
  patches.push(runtimeManifestPatch(root, patches.find(patch => patch.path === runtimePath)));
  for (const { full, source, patched } of patches) if (source !== patched) writeFileSync(full, patched);
}
function assertAudioAnimationHandles(root) {
  for (const { path, pair } of targets) {
    const source = readFileSync(join(root, path), "utf8");
    if (patchAudioAnimationHandles(source, pair, path) !== source) throw new Error(`Packaged audio runtime discards animation handles: ${path}`);
  }
  const runtime = readFileSync(join(root, runtimePath), "utf8");
  const manifest = runtimeManifestPatch(root, { source: runtime, patched: runtime });
  if (manifest.source !== manifest.patched) throw new Error("Packaged audio runtime integrity checksum is stale");
}
module.exports = { applyAudioAnimationHandles, assertAudioAnimationHandles, targets };
if (require.main === module) applyAudioAnimationHandles();
