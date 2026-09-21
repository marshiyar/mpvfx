const { lstatSync, readFileSync, readdirSync, unlinkSync } = require("node:fs");
const { join, normalize } = require("node:path");
const { homedir } = require("node:os");

// Shared by Forge's exclusion rules, the built-artifact check, and the Git
// publication check. Report filenames/rule names only, never matched values.
const PRIVATE_FILE_PATTERN = /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc|\.netrc|\.DS_Store|[^/]*\.(?:pem|key|p8|p12|pfx|jks|keystore|mobileprovision|dmp|jsonl|log|stderr|stdout|csv)|[^/]*diagnostics[^/]*\.json\.gz)$/i;
const PRIVATE_DIRECTORY_PATTERN = /(?:^|\/)(?:\.git|\.agents|\.codex|\.claude|\.chatgpt|\.cursor|\.hyperframes|native-crashes|diagnostics-verification)(?:\/|$)/i;
const TEXT_FILE_PATTERN = /\.(?:[cm]?[jt]sx?|json|html|css|md|txt|ya?ml|toml|ini|conf)$/i;
const CREDENTIAL_PATTERNS = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{70,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}\b/,
  /https?:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+/,
];

function assertPublicContent(content, label) {
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(content))) {
    throw new Error(`Potential credential content in ${label}; review locally (value withheld)`);
  }
}

function assertPublicPath(path) {
  const normalized = path.replace(/\\/g, "/");
  if (/\.csv$/i.test(normalized)) throw new Error("Private CSV files cannot be published (filename withheld)");
  if (PRIVATE_FILE_PATTERN.test(normalized) || PRIVATE_DIRECTORY_PATTERN.test(normalized)) {
    throw new Error(`Private file cannot be published: ${normalized}`);
  }
}

function assertPackagedPrivacy(result) {
  // Loaded lazily so the repository gate runs before npm install.
  const { listPackage, extractFile, statFile, uncache } = require("@electron/asar");
  for (const output of result.outputPaths) {
    const resources = result.platform === "darwin"
      ? join(output.endsWith(".app") ? output : join(output, "MpVFX.app"), "Contents/Resources")
      : join(output, "resources");
    const archive = join(resources, "app.asar");
    uncache(archive);
    const firstParty = /^(?:dist|desktop-dist|resources)(?:\/|$)|^package(?:-lock)?\.json$/;
    for (const raw of listPackage(archive)) {
      const entry = raw.replace(/\\/g, "/").replace(/^\/+/, "");
      assertPublicPath(entry);
      if (!entry.startsWith("node_modules/") && entry !== "node_modules" && !firstParty.test(entry)) {
        throw new Error(`Unexpected non-runtime file in application archive: ${entry}`);
      }
      // Policy uses portable separators; ASAR's lookup uses host-native path
      // separators for nested directories (notably on Windows).
      const lookup = normalize(entry);
      if (!TEXT_FILE_PATTERN.test(entry) || statFile(archive, lookup).files) continue;
      const content = extractFile(archive, lookup).toString("utf8");
      assertPublicContent(content, entry);
      if (firstParty.test(entry) && content.includes(`${homedir()}/`)) {
        throw new Error(`Local home path embedded in application: ${entry} (value withheld)`);
      }
    }
    // extraResource and ASAR-unpacked files bypass the archive exclusion rules.
    function inspect(directory, prefix = "") {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name), relative = `${prefix}${name}`;
        assertPublicPath(relative);
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) continue; // Never follow a link into local data.
        if (stat.isDirectory()) inspect(path, `${relative}/`);
        else if (TEXT_FILE_PATTERN.test(name)) assertPublicContent(readFileSync(path, "utf8"), relative);
      }
    }
    inspect(resources);
  }
  console.log(`Packaged privacy check passed for ${result.platform}: runtime files only; no credential matches or local diagnostic files.`);
}

function removePackagedFinderMetadata(result) {
  // Finder can write these into a developer's browser cache. Delete only the
  // copies inside generated artifacts, never the source cache or user data.
  function walk(directory) {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name), stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(path);
      else if (name === ".DS_Store") unlinkSync(path);
    }
  }
  for (const output of result.outputPaths) walk(output);
}

module.exports = { PRIVATE_FILE_PATTERN, PRIVATE_DIRECTORY_PATTERN, assertPublicPath, assertPublicContent, assertPackagedPrivacy, removePackagedFinderMetadata };
