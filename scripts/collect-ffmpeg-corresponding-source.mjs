import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { get as httpsGet } from "node:https";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceManifestPath = resolve(repositoryRoot, "scripts/ffmpeg-source-manifest.json");
const runtimeManifestPath = resolve(
  repositoryRoot,
  "studio/scripts/ffmpeg-runtime-manifest.json",
);
const sourceManifest = JSON.parse(readFileSync(sourceManifestPath, "utf8"));
const runtimeManifest = JSON.parse(readFileSync(runtimeManifestPath, "utf8"));
const outputPath = resolve(
  process.argv[2]
    ?? `ffmpeg-corresponding-source-${runtimeManifest.release}.tar.gz`,
);
const cacheDirectory = process.env.MPVFX_FFMPEG_SOURCE_CACHE
  ? resolve(process.env.MPVFX_FFMPEG_SOURCE_CACHE)
  : null;

if (sourceManifest.binaryRelease !== runtimeManifest.release) {
  throw new Error("FFmpeg source and binary manifests describe different releases");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function downloadBytes(url, redirectsRemaining = 5) {
  return new Promise((resolveDownload, rejectDownload) => {
    const request = httpsGet(
      url,
      {
        headers: {
          Accept: "*/*",
          "User-Agent": "MpVFX-source-collector/1.0",
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location) {
          response.resume();
          if (redirectsRemaining === 0) {
            rejectDownload(new Error(`Too many redirects while downloading ${url}`));
            return;
          }
          downloadBytes(new URL(location, url).toString(), redirectsRemaining - 1).then(
            resolveDownload,
            rejectDownload,
          );
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          rejectDownload(new Error(`HTTP ${status}`));
          return;
        }

        const chunks = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => resolveDownload(Buffer.concat(chunks)));
        response.on("error", rejectDownload);
      },
    );
    request.setTimeout(300_000, () => {
      request.destroy(new Error(`Timed out downloading ${url}`));
    });
    request.on("error", rejectDownload);
  });
}

async function fetchWithRetries(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await downloadBytes(url);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolveWait) => setTimeout(resolveWait, attempt * 1_000));
      }
    }
  }
  throw new Error(`Failed to download ${url} after ${attempts} attempts`, {
    cause: lastError,
  });
}

async function sourceBytes(component) {
  if (cacheDirectory) {
    const cachedPath = resolve(cacheDirectory, component.filename);
    if (existsSync(cachedPath)) return readFileSync(cachedPath);
  }
  return fetchWithRetries(component.url);
}

const temporaryRoot = mkdtempSync(resolve(tmpdir(), "mpvfx-ffmpeg-source-"));
const bundleName = `ffmpeg-corresponding-source-${runtimeManifest.release}`;
const bundleDirectory = resolve(temporaryRoot, bundleName);
const sourcesDirectory = resolve(bundleDirectory, "sources");
const temporaryOutput = `${outputPath}.mpvfx-${process.pid}.tmp`;

try {
  mkdirSync(sourcesDirectory, { recursive: true });
  const checksumLines = [];
  for (const component of sourceManifest.components) {
    console.log(`Collecting ${component.name} ${component.version}...`);
    const bytes = await sourceBytes(component);
    const actual = sha256(bytes);
    if (actual !== component.sha256) {
      throw new Error(
        `${component.name} source checksum mismatch: expected ${component.sha256}, received ${actual}`,
      );
    }
    writeFileSync(resolve(sourcesDirectory, component.filename), bytes);
    checksumLines.push(`${actual}  sources/${component.filename}`);
  }

  copyFileSync(sourceManifestPath, resolve(bundleDirectory, "SOURCE_MANIFEST.json"));
  copyFileSync(runtimeManifestPath, resolve(bundleDirectory, "BINARY_MANIFEST.json"));
  copyFileSync(
    resolve(repositoryRoot, "docs/FFMPEG_DISTRIBUTION.md"),
    resolve(bundleDirectory, "README.md"),
  );
  copyFileSync(
    resolve(repositoryRoot, "third_party/licenses/GPL-3.0.txt"),
    resolve(bundleDirectory, "GPL-3.0.txt"),
  );
  writeFileSync(resolve(bundleDirectory, "SHA256SUMS"), `${checksumLines.join("\n")}\n`);

  mkdirSync(dirname(outputPath), { recursive: true });
  const archive = spawnSync(
    "tar",
    ["-czf", temporaryOutput, "-C", temporaryRoot, bundleName],
    { encoding: "utf8" },
  );
  if (archive.error) throw archive.error;
  if (archive.status !== 0) {
    throw new Error(`tar failed: ${(archive.stderr || archive.stdout).trim()}`);
  }
  rmSync(outputPath, { force: true });
  renameSync(temporaryOutput, outputPath);
  console.log(`Wrote ${basename(outputPath)} (SHA-256 ${sha256(readFileSync(outputPath))}).`);
} finally {
  rmSync(temporaryOutput, { force: true });
  rmSync(temporaryRoot, { recursive: true, force: true });
}
