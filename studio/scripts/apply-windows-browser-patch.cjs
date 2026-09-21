const { readFileSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

// Puppeteer's detached default creates a console for chrome-headless-shell on
// Windows even with windowsHide. Keep POSIX process groups for tree cleanup,
// while letting Windows launch the helper without a separate console.
// Producer bundles its own Puppeteer: changing only the top-level dependency
// leaves edited-video exports on the old behavior.
const producerTargets = [
  "node_modules/@hyperframes/producer/dist/index.js",
  "node_modules/@hyperframes/producer/dist/public-server.js",
  "node_modules/@hyperframes/producer/dist/distributed.js",
];
const browserReplacements = [
  ["opts.detached ??= true;", 'opts.detached ??= process.platform !== "win32";'],
  [
    'childProcess.execSync(`taskkill /pid ${this.#browserProcess.pid} /T /F`);',
    'childProcess.execSync(`taskkill /pid ${this.#browserProcess.pid} /T /F`, { windowsHide: true });',
  ],
];
// These probes also run on the full composition path. Hiding only Chromium
// leaves console flashes during worker sizing and final audio/video checks.
const gpuProbeReplacements = [[
  '"nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits", {',
  '"nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits", { windowsHide: true,',
]];
const mediaProbeReplacements = [[
  'getFfprobeBinary(), args, { stdio: ["ignore", "pipe", "pipe"] }',
  'getFfprobeBinary(), args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }',
]];
const targets = [
  { relativePath: "node_modules/@puppeteer/browsers/lib/launch.js", replacements: browserReplacements },
  ...producerTargets.map((relativePath) => ({
    relativePath,
    replacements: [...browserReplacements, ...gpuProbeReplacements, ...mediaProbeReplacements],
  })),
  { relativePath: "node_modules/@hyperframes/engine/dist/services/browserManager.js", replacements: gpuProbeReplacements },
];

function patchBrowserLauncherSource(source, name = "browser launcher", replacements = browserReplacements) {
  for (const [before, after] of replacements) {
    const newCount = source.split(after).length - 1;
    // Some repaired calls extend the old prefix; do not count that prefix as
    // an additional unpatched occurrence on repeated builds.
    const oldCount = source.split(after).join("").split(before).length - 1;
    if (oldCount === 0 && newCount === 1) continue;
    if (oldCount !== 1 || newCount !== 0) {
      throw new Error(`Unsupported Windows browser launch policy in ${name}; review the dependency before shipping`);
    }
    source = source.replace(before, after);
  }
  return source;
}

function applyWindowsBrowserLaunchPolicy(root = resolve(__dirname, "..")) {
  // Validate every target before writing, so an upstream change cannot leave
  // only some of the browser launchers repaired.
  const patches = targets.map(({ relativePath, replacements }) => {
    const path = join(root, relativePath);
    const source = readFileSync(path, "utf8");
    return { path, source, patched: patchBrowserLauncherSource(source, relativePath, replacements) };
  });
  for (const { path, source, patched } of patches) {
    if (source !== patched) writeFileSync(path, patched);
  }
}

function assertWindowsBrowserLaunchPolicy(root) {
  for (const { relativePath, replacements } of targets) {
    const source = readFileSync(join(root, relativePath), "utf8");
    if (patchBrowserLauncherSource(source, relativePath, replacements) !== source) {
      throw new Error(`Packaged browser can open Windows consoles: ${relativePath}`);
    }
  }
}

module.exports = { patchBrowserLauncherSource, applyWindowsBrowserLaunchPolicy, assertWindowsBrowserLaunchPolicy };
if (require.main === module) applyWindowsBrowserLaunchPolicy();
