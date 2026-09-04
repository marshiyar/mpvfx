import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = resolve(repositoryRoot, "studio/package-lock.json");
const checkOnly = process.argv.includes("--check");

const licenseOverrides = new Map([
  ["color-convert", "MIT"],
  ["parse-cache-control", "BSD-3-Clause"],
]);

function dependencyName(path) {
  return path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
}

function declaredLicense(name, metadata) {
  if (name.startsWith("@hyperframes/")) return "Apache-2.0";
  return metadata.license ?? licenseOverrides.get(name) ?? "UNKNOWN — manual review required";
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function renderTable(entries) {
  const rows = ["| Package | Version | Declared license |", "| --- | --- | --- |"];
  for (const entry of entries) {
    const encodedName = entry.name.replace("/", "%2F");
    rows.push(
      `| [${escapeCell(entry.name)}](https://www.npmjs.com/package/${encodedName}) | ${escapeCell(entry.version)} | ${escapeCell(entry.license)} |`,
    );
  }
  return rows.join("\n");
}

const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const packages = new Map();
for (const [path, metadata] of Object.entries(lock.packages ?? {})) {
  if (!path.includes("node_modules/") || metadata.link || !metadata.version) continue;
  const name = dependencyName(path);
  const key = `${name}@${metadata.version}`;
  const scope = metadata.dev === true ? "development" : "runtime";
  const existing = packages.get(key);
  packages.set(key, {
    name,
    version: metadata.version,
    license: declaredLicense(name, metadata),
    scope: existing?.scope === "runtime" ? "runtime" : scope,
  });
}

const entries = [...packages.values()].sort((a, b) =>
  a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
);
const unknown = entries.filter((entry) => entry.license.startsWith("UNKNOWN"));
if (unknown.length > 0) {
  throw new Error(
    `Dependency license metadata needs review:\n${unknown.map((entry) => `${entry.name}@${entry.version}`).join("\n")}`,
  );
}

const runtime = entries.filter((entry) => entry.scope === "runtime");
const development = entries.filter((entry) => entry.scope === "development");
const appVersion = lock.packages?.[""]?.version ?? "unknown";

const notice = `# MpVFX third-party notices

This inventory was generated from \`studio/package-lock.json\` for MpVFX ${appVersion}. It records
the license identifiers declared by the exact JavaScript dependency versions in the lockfile. A
package's own license file and notices control if they differ from this convenience inventory.

## Binary distribution

This file is attribution, not a legal conclusion. During installation MpVFX replaces the
executables downloaded by the \`ffmpeg-static\` and \`@ffprobe-installer/ffprobe\` path wrappers
with exact SHA-256-pinned FFmpeg 8.1.2 assets from Shaka Project release \`n8.1.2-1\`. The selected
GPLv3 binaries contain no \`--enable-nonfree\` configuration. Packaging verifies their hashes,
architecture, version, and configuration. Exact provenance and corresponding-source details are in
\`docs/FFMPEG_DISTRIBUTION.md\` and the same record is included in every application package.

## Material requiring prominent notice

- Portions of the editor and rendering adapter derive from or depend on HyperFrames, Copyright
  2026 HeyGen, Inc., under Apache License 2.0. MpVFX modified, reorganized, and rebranded those
  portions. The full license is in \`third_party/licenses/Apache-2.0.txt\`.
- The packaged FFmpeg and FFprobe programs are GPL version 3 or later. Their full license is in
  \`third_party/licenses/GPL-3.0.txt\`; public binary releases include matching corresponding source.
- Electron packages Chromium and other components whose detailed notices are provided by
  \`LICENSES.chromium.html\` in a packaged Electron application.
- GSAP declares its Standard “no charge” license. Review that package's current standard-license
  terms before distribution or commercial use. Its retained notice is in
  \`third_party/licenses/GSAP-NOTICE.txt\`.
- The separately stored Stack Overflow QA corpus is not an npm dependency. Its per-post authors,
  URLs, dates, license versions, and modification notices are in
  \`third_party/stackexchange-video-qa/sources.jsonl\`.
- The background-removal weight is downloaded on demand and is not in the source or application
  package. Its checksum, lineage, and unresolved asset-specific licensing are recorded in
  \`docs/REMOTE_ASSETS.md\`.

## Runtime and production dependencies

${renderTable(runtime)}

## Development, build, and test dependencies

These packages are required to develop or produce MpVFX but are not intended as application
runtime dependencies.

${renderTable(development)}

## Full terms

The lockfile inventory does not replace full license texts or package notices. After \`npm ci\`,
those files remain in each package under \`studio/node_modules\`. A distributable application must
retain every notice required by the actual packaged dependency graph, plus Electron's Chromium
notices and any corresponding-source offer required by copyleft components.
`;

const outputs = new Map([
  [resolve(repositoryRoot, "THIRD_PARTY_NOTICES.md"), notice],
  [resolve(repositoryRoot, "studio/resources/legal/THIRD_PARTY_NOTICES.md"), notice],
  [resolve(repositoryRoot, "studio/resources/legal/MPVFX_LICENSE.txt"), readFileSync(resolve(repositoryRoot, "LICENSE"), "utf8")],
  [resolve(repositoryRoot, "studio/resources/legal/NOTICE.txt"), readFileSync(resolve(repositoryRoot, "NOTICE"), "utf8")],
  [resolve(repositoryRoot, "studio/resources/legal/PRIVACY.md"), readFileSync(resolve(repositoryRoot, "PRIVACY.md"), "utf8")],
  [resolve(repositoryRoot, "studio/resources/legal/REMOTE_ASSETS.md"), readFileSync(resolve(repositoryRoot, "docs/REMOTE_ASSETS.md"), "utf8")],
  [resolve(repositoryRoot, "studio/resources/legal/FFMPEG_SOURCE.md"), readFileSync(resolve(repositoryRoot, "docs/FFMPEG_DISTRIBUTION.md"), "utf8")],
  [resolve(repositoryRoot, "studio/resources/legal/Apache-2.0.txt"), readFileSync(resolve(repositoryRoot, "third_party/licenses/Apache-2.0.txt"), "utf8")],
  [resolve(repositoryRoot, "studio/resources/legal/GPL-3.0.txt"), readFileSync(resolve(repositoryRoot, "third_party/licenses/GPL-3.0.txt"), "utf8")],
  [resolve(repositoryRoot, "studio/resources/legal/GSAP-NOTICE.txt"), readFileSync(resolve(repositoryRoot, "third_party/licenses/GSAP-NOTICE.txt"), "utf8")],
]);

const stale = [];
for (const [path, content] of outputs) {
  if (checkOnly) {
    if (!existsSync(path) || readFileSync(path, "utf8") !== content) stale.push(path);
    continue;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

if (stale.length > 0) {
  throw new Error(
    `Generated legal notices are missing or stale:\n${stale.join("\n")}\nRun: npm --prefix studio run notices:update`,
  );
}

console.log(
  checkOnly
    ? `Verified ${entries.length} dependency notice records and packaged legal resources.`
    : `Wrote notices for ${entries.length} dependency versions and synchronized packaged legal resources.`,
);
