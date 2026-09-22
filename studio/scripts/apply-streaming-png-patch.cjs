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

// Parallel captures are saved as frame_%06d.png before encoding. Feed those
// same frames as RGBA as well, without a second raw-video copy on disk. Keep
// the caller's encoder, audio, GOP, color, rate and chunk-range arguments.
async function mpvfxPreparePngSequenceInput(args, platform, signal) {
  const input = args.indexOf("-i");
  if (platform !== "linux" || input < 0 || !/(?:^|\/)frame_%06d\.png$/.test(args[input + 1] ?? "")) return null;
  signal?.throwIfAborted();
  const { readdir, readFile } = await import("node:fs/promises");
  const { dirname, join } = await import("node:path");
  const { decodePng } = await import("@hyperframes/engine/alpha-blit");
  const { Readable } = await import("node:stream");
  const { pipeline } = await import("node:stream/promises");
  const prefix = args.slice(0, input);
  const startIndex = prefix.indexOf("-start_number");
  const start = startIndex < 0 ? 0 : Number(prefix[startIndex + 1]);
  const limitIndex = args.indexOf("-frames:v", input + 2);
  const limit = limitIndex < 0 ? Infinity : Number(args[limitIndex + 1]);
  if (!Number.isSafeInteger(start) || start < 0 || (limit !== Infinity && (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(start + limit)))) {
    throw new Error("Invalid captured PNG frame range");
  }
  if (startIndex >= 0) prefix.splice(startIndex, 2);
  const directory = dirname(args[input + 1]);
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^frame_\d{6,}\.png$/.test(entry.name))
    .map(({ name }) => ({ name, index: Number(name.slice(6, -4)) }))
    .filter(({ index }) => index >= start && index < start + limit)
    .sort((a, b) => a.index - b.index);
  if (!files.length || (limit !== Infinity && files.length !== limit) || files.some(({ name, index }, offset) => index !== start + offset || name !== `frame_${String(index).padStart(6, "0")}.png`)) {
    throw new Error("Captured PNG frame sequence has missing or invalid frames");
  }
  async function readFrame(name) {
    signal?.throwIfAborted();
    const bytes = await readFile(join(directory, name), { signal });
    signal?.throwIfAborted();
    return decodePng(bytes);
  }
  let first = await readFrame(files[0].name);
  const { width, height } = first;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || first.data.length !== width * height * 4) {
    throw new Error("Invalid captured PNG frame dimensions");
  }
  async function* frames() {
    yield first.data;
    first = null;
    for (const file of files.slice(1)) {
      const frame = await readFrame(file.name);
      if (frame.width !== width || frame.height !== height || frame.data.length !== width * height * 4) throw new Error("Captured PNG dimensions changed during encoding");
      yield frame.data;
    }
  }
  return {
    args: [...prefix, "-f", "rawvideo", "-pix_fmt", "rgba", "-video_size", `${width}x${height}`, "-i", "pipe:0", ...args.slice(input + 2)],
    // Attach error and back-pressure handling immediately after spawn. Loading
    // modules here would leave an early child/pipe failure without a listener.
    pipe: (stdin, pipeSignal) => pipeline(Readable.from(frames(), { objectMode: false, highWaterMark: 1 }), stdin, { signal: pipeSignal }),
  };
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

const sequenceTargets = [
  "node_modules/@hyperframes/engine/dist/utils/runFfmpeg.js",
  ...targets.slice(1),
];
const sequenceHelpers = `// MpVFX lossless saved PNG compatibility\n${mpvfxPreparePngSequenceInput.toString()}\n`;
const sequenceSetup = `
  const mpvfxInputStart = Date.now();
  let mpvfxPngInput;
  try {
    mpvfxPngInput = await mpvfxPreparePngSequenceInput(args, process.platform, opts?.signal);
  } catch {
    return { success: false, exitCode: null, stderr: "Unable to read a complete, valid captured PNG frame sequence", durationMs: Date.now() - mpvfxInputStart, terminationReason: opts?.signal?.aborted ? "abort" : "exit" };
  }
  if (mpvfxPngInput) args = mpvfxPngInput.args;
  const mpvfxInputAbort = mpvfxPngInput ? new AbortController() : null;`;
const sequenceWait = `let mpvfxFeedError = false;
  const mpvfxFeed = mpvfxPngInput ? mpvfxPngInput.pipe(ffmpeg.stdin, mpvfxInputAbort.signal).catch(() => {
    mpvfxFeedError = true;
    mpvfxInputAbort.abort();
  }) : null;
  let outcome = await managed.wait();
  mpvfxInputAbort?.abort();
  await mpvfxFeed;
  if (mpvfxFeedError && !opts?.signal?.aborted && (outcome.reason === "exit" || outcome.reason === "abort")) {
    outcome = { ...outcome, reason: "exit", exitCode: outcome.exitCode || 1, stderr: outcome.stderr || "Captured PNG frames could not be decoded or sent to FFmpeg" };
  }`;

function patchPngSequenceSource(source, name) {
  const functions = [...source.matchAll(/async function runFfmpeg\(args, opts\) \{[\s\S]*?\n\}/g)];
  if (functions.length !== 1) throw new Error(`Unsupported saved PNG implementation: ${name}`);
  const original = functions[0][0];
  if (source.includes(sequenceHelpers) && original.includes(sequenceSetup) && original.includes(sequenceWait) && original.includes("signal: mpvfxInputAbort ? AbortSignal.any")) return source;
  if (source.includes("// MpVFX lossless saved PNG compatibility") || !original.includes("signal: opts?.signal,") || !original.includes("const outcome = await managed.wait();")) {
    throw new Error(`Unsupported saved PNG implementation: ${name}`);
  }
  const patched = original
    .replace("async function runFfmpeg(args, opts) {", `async function runFfmpeg(args, opts) {${sequenceSetup}`)
    .replace("signal: opts?.signal,", "signal: mpvfxInputAbort ? AbortSignal.any([mpvfxInputAbort.signal, ...(opts?.signal ? [opts.signal] : [])]) : opts?.signal,")
    .replace("const outcome = await managed.wait();", sequenceWait);
  // Keep executable shebangs first and `export` attached to runFfmpeg.
  const patchedSource = source.replace(original, patched);
  const shebang = patchedSource.match(/^#![^\n]*(?:\n|$)/)?.[0] ?? "";
  return shebang + sequenceHelpers + patchedSource.slice(shebang.length);
}

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
  const patches = [...new Set([...targets, ...sequenceTargets])].map((name) => {
    const path = join(root, name), source = readFileSync(path, "utf8");
    let patched = targets.includes(name) ? patchStreamingPngSource(source, name) : source;
    if (sequenceTargets.includes(name)) patched = patchPngSequenceSource(patched, name);
    return { path, source, patched };
  });
  for (const { path, source, patched } of patches) if (source !== patched) writeFileSync(path, patched);
}
function assertStreamingPngPolicy(root) {
  for (const name of targets) {
    const source = readFileSync(join(root, name), "utf8");
    if (patchStreamingPngSource(source, name) !== source) throw new Error(`Missing lossless PNG streaming compatibility: ${name}`);
  }
  for (const name of sequenceTargets) {
    const source = readFileSync(join(root, name), "utf8");
    if (patchPngSequenceSource(source, name) !== source) throw new Error(`Missing lossless saved PNG compatibility: ${name}`);
  }
}
module.exports = { needsRawPngInput, rawPngInputArgs, decodeCapturedPng, mpvfxPreparePngSequenceInput, patchPngSequenceSource, patchStreamingPngSource, applyStreamingPngPolicy, assertStreamingPngPolicy };
if (require.main === module) applyStreamingPngPolicy();
