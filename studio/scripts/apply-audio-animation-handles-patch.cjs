const { readFileSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

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
const targets = [
  ...["core/dist/audioAutomation.js", "producer/dist/index.js", "producer/dist/public-server.js", "producer/dist/distributed.js"].map(path => ({ path: `node_modules/@hyperframes/${path}`, pair: plain })),
  ...["core", "producer"].map(pkg => ({ path: `node_modules/@hyperframes/${pkg}/dist/hyperframe.runtime.iife.js`, pair: bundled })),
];
function patchAudioAnimationHandles(source, pair, name) {
  const [before, after] = pair;
  const oldCount = source.split(before).length - 1;
  const newCount = source.split(after).length - 1;
  if (newCount === 1 && oldCount === 0) return source;
  if (oldCount !== 1 || newCount !== 0) throw new Error(`Unsupported audio automation normalizer in ${name}; review the dependency before shipping`);
  return source.replace(before, after);
}
function applyAudioAnimationHandles(root = resolve(__dirname, "..")) {
  const patches = targets.map(({ path, pair }) => {
    const full = join(root, path);
    const source = readFileSync(full, "utf8");
    return { full, source, patched: patchAudioAnimationHandles(source, pair, path) };
  });
  for (const { full, source, patched } of patches) if (source !== patched) writeFileSync(full, patched);
}
function assertAudioAnimationHandles(root) {
  for (const { path, pair } of targets) {
    const source = readFileSync(join(root, path), "utf8");
    if (patchAudioAnimationHandles(source, pair, path) !== source) throw new Error(`Packaged audio runtime discards animation handles: ${path}`);
  }
}
module.exports = { applyAudioAnimationHandles, assertAudioAnimationHandles, targets };
if (require.main === module) applyAudioAnimationHandles();
