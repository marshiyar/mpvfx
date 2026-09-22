/** Public CI evidence is a projection of synthetic tests, never a log archive. */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const fail = (reason = 'schema') => { throw new Error(`Invalid evidence: ${reason}`); };
const enumValue = (value, choices) => choices.includes(value) ? value : fail();
const number = (value, max = 1e9) => Number.isFinite(value) && value >= 0 && value <= max ? Math.round(value) : fail();
const phasePattern = /^(?:download|installer|install-squirrel|mount-dmg|install-deb|installer-shortcuts|first-launch|import-media|timeline-cuts|mp4-(?:render-[14]|cancel-3)|mov-render-2|minimum-viewport|diagnostic-report|native-renderer-crash|restart-after-crash|desktop-monitor|complete)$/;
const passedPattern = /^(?:published-installer-checksum|visible-squirrel-installation|published-dmg-mounted-and-app-copied|published-deb-installed|released-app-first-launch|ui-media-import-and-add-to-timeline|three-ui-timeline-cuts|ui-(?:mp4|mov)-(?:cancel|export-verified-pixels)-[1-4]|ui-save-diagnostic-report|native-crash-dialog-and-restart-with-cuts-preserved)$/;
const imagePattern = /^(?:(?:01-first-launch|02-imported-media|03-three-cuts|0[4-7]-(?:mp4|mov)-(?:rendering|complete|cancelled)|06-cancelling|08-minimum-viewport|09-diagnostics|11-recovered-editor|failure(?:-(?:mp4|mov)-[1-4])?)-app|output-[1-4]-(?:red|blue))\.png$/;
const desktopPattern = /^(?:\d\d-[a-z0-9-]+|failure(?:-[a-z0-9-]+)?)-desktop\.png$/;
const windowsFrame = /^desktop-\d{5}\.png$/;

export function assertHosted(env) {
  if (env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted') throw new Error('Evidence requires a disposable hosted runner');
}

export function minimalEnvironment(env = process.env) {
  // Deliberately omit tokens, signing material, NODE_OPTIONS, proxy credentials,
  // tracing endpoints and arbitrary application overrides. Case matters on Unix.
  const allowed = /^(?:PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|PUBLIC|SystemRoot|WINDIR|ComSpec|TEMP|TMP|TMPDIR|DISPLAY|XAUTHORITY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|LANG|LC_ALL)$/i;
  return Object.fromEntries(Object.entries(env).filter(([key]) => allowed.test(key)));
}

export function publicResult(raw) {
  if (!raw || typeof raw !== 'object' || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(raw.version ?? '')) fail();
  const clean = {
    schema: 1, version: raw.version,
    platform: enumValue(raw.platform, ['win32', 'darwin', 'linux']),
    architecture: enumValue(raw.architecture, ['x64', 'arm64']),
    passed: [], failures: [], exports: [],
    limitations: ['synthetic-media-only', 'hosted-hardware', 'manual-design-review-required'],
  };
  for (const key of ['sha256', 'buildFingerprint']) if (raw[key] !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(raw[key])) fail();
    clean[key] = raw[key];
  }
  for (const key of ['passed', 'failures', 'exports']) if (!Array.isArray(raw[key]) || raw[key].length > 64) fail();
  clean.passed = raw.passed.filter((value) => typeof value === 'string' && passedPattern.test(value));
  clean.failures = raw.failures.map((value) => ({ phase: phasePattern.test(value?.phase) ? value.phase : 'harness', code: 'scenario-failed' }));
  clean.exports = raw.exports.map((item) => ({
    format: enumValue(item.format, ['mp4', 'mov']),
    status: enumValue(item.status, ['complete', 'cancelled', 'failed', 'error']),
    elapsedMs: number(item.elapsedMs),
    ...(item.helperCount === undefined ? {} : { helperCount: number(item.helperCount, 100000) }),
  }));
  if (Array.isArray(raw.shortcuts)) clean.shortcutCount = number(raw.shortcuts.length, 1000);
  if (raw.windowsDesktop) {
    clean.windowsDesktop = {};
    for (const key of ['frames', 'durationMs', 'sampleIntervalMs', 'screenWidth', 'screenHeight', 'unexpectedConsoleObservations']) clean.windowsDesktop[key] = number(raw.windowsDesktop[key]);
    clean.windowsDesktop.eventHookActive = raw.windowsDesktop.eventHookActive === true;
  }
  return clean;
}

export function inspectPng(bytes) {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) fail('image');
  let offset = 8, header = false, pixels = false, ended = false;
  // Reject metadata chunks (including text/EXIF) even in an allowed filename.
  const chunks = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND', 'sRGB', 'gAMA', 'cHRM', 'pHYs', 'sBIT']);
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), kind = bytes.toString('ascii', offset + 4, offset + 8);
    if (!chunks.has(kind) || offset + 12 + length > bytes.length) fail('image metadata');
    if (kind === 'IHDR') {
      if (offset !== 8 || length !== 13) fail('image');
      const width = bytes.readUInt32BE(offset + 8), height = bytes.readUInt32BE(offset + 12);
      if (!width || !height || width > 8192 || height > 8192) fail('image dimensions');
      header = true;
    }
    if (kind === 'IDAT') pixels = true;
    offset += length + 12;
    if (kind === 'IEND') { ended = true; break; }
  }
  if (!header || !pixels || !ended || offset !== bytes.length) fail('image');
}

export function prepareEvidence({ input, output, env = process.env }) {
  assertHosted(env);
  if (resolve(input) === resolve(output) || existsSync(output)) fail('output must be new');
  if (lstatSync(input).isSymbolicLink() || !lstatSync(input).isDirectory()) fail('input');
  const names = readdirSync(input);
  if (names.length > 1500) fail('file count');
  for (const name of names) {
    const stat = lstatSync(join(input, name));
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 16 * 1024 * 1024) fail('file boundary');
    if (!['result.json', 'windows-desktop.json', 'edited-output.mp4', 'windows-desktop.mp4'].includes(name) && !imagePattern.test(name) && !windowsFrame.test(name) && !desktopPattern.test(name)) fail('unexpected file');
  }
  const raw = JSON.parse(readFileSync(join(input, 'result.json'), 'utf8'));
  const clean = publicResult(raw);
  const hasWindows = names.some((name) => windowsFrame.test(name) || name === 'windows-desktop.mp4');
  let capture;
  if (hasWindows) {
    capture = JSON.parse(readFileSync(join(input, 'windows-desktop.json'), 'utf8').replace(/^\uFEFF/, ''));
    if (clean.platform !== 'win32' || capture.capturePolicy !== 'mpvfx-windows-only') fail('capture policy');
  }
  const selected = names.filter((name) => imagePattern.test(name) || windowsFrame.test(name) || name === 'edited-output.mp4' || name === 'windows-desktop.mp4');
  if (selected.reduce((sum, name) => sum + lstatSync(join(input, name)).size, 0) > 160 * 1024 * 1024) fail('total size');
  for (const name of selected) {
    const bytes = readFileSync(join(input, name));
    if (name.endsWith('.png')) inspectPng(bytes);
    else if (bytes.toString('ascii', 4, 8) !== 'ftyp') fail('video');
  }
  // Validation completes before a public directory exists. No error text or
  // arbitrary raw JSON ever crosses the boundary, including on failed tests.
  try {
    mkdirSync(output);
    for (const name of selected) copyFileSync(join(input, name), join(output, name));
    writeFileSync(join(output, 'result.json'), JSON.stringify(clean, null, 2));
    if (capture) {
      const observations = (capture.observations ?? []).filter((item) => windowsFrame.test(item.image ?? '')).map((item) => ({ image: item.image, elapsedMs: number(item.elapsedMs), phase: phasePattern.test(item.phase) ? item.phase : 'harness' }));
      writeFileSync(join(output, 'windows-desktop.json'), JSON.stringify({ schema: 1, capturePolicy: 'mpvfx-windows-only', observations }, null, 2));
    }
    const files = readdirSync(output).sort().map((name) => {
      const bytes = readFileSync(join(output, name));
      return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    });
    writeFileSync(join(output, 'manifest.json'), JSON.stringify({ schema: 1, provenance: 'disposable-hosted-synthetic-test', files }, null, 2));
    return clean;
  } catch {
    rmSync(output, { recursive: true, force: true });
    fail('staging');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    prepareEvidence({ input: resolve('studio/out/visual-release/evidence'), output: resolve('studio/out/visual-release/public-evidence') });
    console.log('Synthetic evidence privacy gate passed.');
  } catch { console.error('Evidence privacy gate failed; no artifact upload is permitted.'); process.exitCode = 1; }
}
