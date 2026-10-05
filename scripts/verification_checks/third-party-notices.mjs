import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const lock = JSON.parse(readFileSync(resolve(root, "studio/package-lock.json"), "utf8"));
const output = resolve(root, "studio/legal/NOTICES/THIRD_PARTY_NOTICES.md");
const write = process.argv.includes("--write");

// npm omits these identifiers from its lockfile. The installed package license
// files, rather than a guessed registry value, establish each override.
const licenseOverrides = new Map([
  ["color-convert", "MIT"],
  ["parse-cache-control", "BSD-3-Clause"],
]);
// color-convert 0.5.3 is an optional development dependency. npm ci may omit
// it on another OS, so retain the exact audited tarball identity as evidence.
const optionalColorConvert = {
  version: "0.5.3",
  integrity: "sha512-RwBeO/B/vZR3dfKL1ye/vx8MHZ40ugzpyfeVG5GsiuGnrlMWe2o8wxBbLCpw9CsxV+wHuzYlCiWnybrIA0ling==",
};

function packageName(path) {
  return path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
}

function licenseFor(name, metadata, path) {
  if (metadata.license) return metadata.license;
  const override = name.startsWith("@hyperframes/") ? "Apache-2.0" : licenseOverrides.get(name);
  if (!override) return undefined;
  const installedLicense = resolve(root, "studio", path, "LICENSE");
  if (!existsSync(installedLicense) && metadata.optional && name === "color-convert" &&
      metadata.version === optionalColorConvert.version && metadata.integrity === optionalColorConvert.integrity) {
    return override;
  }
  const licenseFile = readFileSync(installedLicense, "utf8");
  const marker = override === "Apache-2.0" ? /Apache License\s+Version 2\.0/
    : override === "MIT" ? /Permission is hereby granted, free of charge/
      : /Redistribution and use in source and binary forms/;
  if (!marker.test(licenseFile)) throw new Error(`Review installed license for ${name}@${metadata.version}`);
  return override;
}

function cell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

const packages = new Map();
const unknown = [];
for (const [path, metadata] of Object.entries(lock.packages ?? {})) {
  if (!path.includes("node_modules/") || metadata.link || !metadata.version) continue;
  const name = packageName(path);
  const license = licenseFor(name, metadata, path);
  if (!license) {
    unknown.push(`${name}@${metadata.version}`);
    continue;
  }
  const key = `${name}@${metadata.version}`;
  const prior = packages.get(key);
  packages.set(key, {
    name,
    version: metadata.version,
    license,
    scope: prior?.scope === "runtime" || metadata.dev !== true ? "runtime" : "development",
  });
}
if (unknown.length) {
  throw new Error(`Review dependency license files before generating notices:\n${[...new Set(unknown)].sort().join("\n")}`);
}

const entries = [...packages.values()].sort((a, b) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0,
);
function table(scope) {
  return [
    "| Package | Version | Declared license |",
    "| --- | --- | --- |",
    ...entries.filter((entry) => entry.scope === scope).map((entry) =>
      `| [${cell(entry.name)}](https://www.npmjs.com/package/${encodeURIComponent(entry.name)}) | ${cell(entry.version)} | ${cell(entry.license)} |`),
  ].join("\n");
}

const version = lock.packages?.[""]?.version;
if (!version) throw new Error("Package lock has no application version");
const notice = `# MpVFX third-party notices

This inventory was generated from \`studio/package-lock.json\` for MpVFX ${version}. It records
the license identifiers declared by the exact JavaScript dependency versions in the lockfile.
Package license files and notices control if they differ from this inventory.

## Binary distribution

MpVFX installs checksum-verified FFmpeg and FFprobe 8.1.2 programs from Shaka Project release
\`n8.1.2-1\`. They are GPL version 3 or later. See \`FFMPEG_SOURCE.md\` for exact provenance,
configuration and corresponding-source details; releases include that source archive.

## Material requiring prominent notice

- MpVFX-owned source and Apache-derived attribution are described in \`NOTICE.txt\`.
- Electron carries Chromium notices in its packaged \`LICENSES.chromium.html\`.
- GSAP's license notice is retained in \`GSAP-NOTICE.txt\`.
- Remote asset provenance and limitations are described in \`REMOTE_ASSETS.md\`.

## Runtime and production dependencies

${table("runtime")}

## Development, build, and test dependencies

${table("development")}

## Full terms

This lockfile inventory does not replace full license texts or package notices. After \`npm ci\`,
those files remain under \`studio/node_modules\`. A distributable application must retain
notices required by its packaged dependency graph and Electron, plus the FFmpeg source offer.
`;

if (write) {
  writeFileSync(output, notice);
  console.log(`Updated ${entries.length} dependency notice records.`);
} else if (readFileSync(output, "utf8") !== notice) {
  throw new Error("Third-party notices are stale. Run npm --prefix studio run notices:update.");
} else {
  console.log(`Verified ${entries.length} dependency notice records.`);
}
