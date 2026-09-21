const { readFileSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

// The pinned Linux FFmpeg lacks PNG decoding. Decode Chrome's lossless RGB(A)
// captures with the engine's existing Node/zlib decoder, then pipe raw RGBA.
// Keep output encoding, color/range conversion, alpha, and back-pressure intact.
function needsRawPngInput(options, platform) {
  return platform === "linux" && options.imageFormat === "png" && !options.rawInputFormat;
}
function rawPngInputArgs(args, options) {
  const input = args.indexOf("-i");
  const rate = args[args.indexOf("-framerate") + 1];
  if (input < 0 || !rate || !Number.isSafeInteger(options.width) || !Number.isSafeInteger(options.height) || options.width <= 0 || options.height <= 0) {
    throw new Error("Unsupported PNG streaming input dimensions or frame rate");
  }
  args.splice(0, input, "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${options.width}x${options.height}`, "-framerate", rate);
}
function decodeCapturedPng(buffer, options, decodePng) {
  const frame = decodePng(buffer);
  if (frame.width !== options.width || frame.height !== options.height || frame.data.length !== options.width * options.height * 4) {
    throw new Error("Captured PNG dimensions differ from the streaming encoder");
  }
  return frame.data;
}

const targets = [
  "node_modules/@hyperframes/engine/dist/services/streamingEncoder.js",
  ...["index.js", "public-server.js", "distributed.js"].map((file) => `node_modules/@hyperframes/producer/dist/${file}`),
];
const beforeArgs = "const args = buildStreamingArgs(options, outputPath, gpuEncoder);";
const afterArgs = [
  "// MpVFX lossless PNG streaming compatibility",
  needsRawPngInput.toString(), rawPngInputArgs.toString(), decodeCapturedPng.toString(),
  'const mpvfxDecodePng = needsRawPngInput(options, process.platform) ? (await import("@hyperframes/engine/alpha-blit")).decodePng : null;',
  beforeArgs,
  "if (mpvfxDecodePng) rawPngInputArgs(args, options);",
].join("\n");
const beforeCopy = "const copy = Buffer.from(buffer);";
const afterCopy = "const copy = Buffer.from(mpvfxDecodePng ? decodeCapturedPng(buffer, options, mpvfxDecodePng) : buffer);";

function patchStreamingPngSource(source, name) {
  for (const [before, after] of [[beforeArgs, afterArgs], [beforeCopy, afterCopy]]) {
    const fresh = source.split(after).length - 1;
    const old = source.split(after).join("").split(before).length - 1;
    if (fresh === 1 && old === 0) continue;
    if (fresh !== 0 || old !== 1) throw new Error(`Unsupported streaming PNG implementation: ${name}`);
    source = source.replace(before, after);
  }
  return source;
}
function applyStreamingPngPolicy(root = resolve(__dirname, "..")) {
  const patches = targets.map((name) => {
    const path = join(root, name), source = readFileSync(path, "utf8");
    return { path, source, patched: patchStreamingPngSource(source, name) };
  });
  for (const { path, source, patched } of patches) if (source !== patched) writeFileSync(path, patched);
}
function assertStreamingPngPolicy(root) {
  for (const name of targets) {
    const source = readFileSync(join(root, name), "utf8");
    if (patchStreamingPngSource(source, name) !== source) throw new Error(`Missing lossless PNG streaming compatibility: ${name}`);
  }
}
module.exports = { needsRawPngInput, rawPngInputArgs, decodeCapturedPng, patchStreamingPngSource, applyStreamingPngPolicy, assertStreamingPngPolicy };
if (require.main === module) applyStreamingPngPolicy();
