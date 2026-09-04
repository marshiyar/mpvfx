import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(join(scriptDirectory, "ffmpeg-runtime-manifest.json"), "utf8"),
);
const verifier = require("./verify-redistributable-ffmpeg.cjs");

const platform = process.env.npm_config_platform || process.platform;
const arch = process.env.npm_config_arch || process.arch;
const target = verifier.runtimeTarget(platform, arch);

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function installedBinaryIsCurrent(destination, expectedDigest) {
  if (!existsSync(destination)) return false;
  return digest(readFileSync(destination)) === expectedDigest;
}

async function download(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(300_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolveWait) => setTimeout(resolveWait, attempt * 1_000));
      }
    }
  }
  throw new Error(`Failed to download audited media binary from ${url}`, {
    cause: lastError,
  });
}

async function installBinary(name, record, destination) {
  const temporary = `${destination}.mpvfx-${process.pid}.download`;
  const url = `${manifest.sourceRepository}/releases/download/${manifest.release}/${record.asset}`;
  try {
    if (installedBinaryIsCurrent(destination, record.sha256)) return;
    console.log(`Installing audited ${name} ${manifest.ffmpegVersion} for ${target.key}...`);
    const bytes = await download(url);
    const actual = digest(bytes);
    if (actual !== record.sha256) {
      throw new Error(
        `Audited ${name} checksum mismatch for ${target.key}: expected ${record.sha256}, received ${actual}`,
      );
    }
    writeFileSync(temporary, bytes, { mode: 0o755 });
    chmodSync(temporary, 0o755);
    rmSync(destination, { force: true });
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

async function install() {
  await installBinary("FFmpeg", target.ffmpeg, verifier.installedFfmpegPath(platform));
  await installBinary(
    "FFprobe",
    target.ffprobe,
    verifier.installedFfprobePath(platform, arch),
  );
  verifier.assertInstalledRedistributableFfmpeg(platform, arch);
  console.log(
    `Verified redistributable FFmpeg and FFprobe ${manifest.ffmpegVersion} (${target.key}).`,
  );
}

await install();
