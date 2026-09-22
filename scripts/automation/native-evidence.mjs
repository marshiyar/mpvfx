/** Project only generated-media app screenshots and bounded test facts for CI. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertHosted, inspectPng } from './privacy.mjs';

const labels = ['initial', 'pose-a', 'pose-midpoint', 'pose-b', 'reopened-midpoint', 'failure'];
const checks = ['visible-native-lanes', 'exact-midpoint', 'pause-reseek', 'outgoing-interpolation-persistence', 'canvas-position', 'canvas-rotation', 'inspector-width', 'inspector-scale', 'preserved-pose-a', 'all-channel-keyframe-add-remove', 'atomic-undo-redo', 'save-reopen'];
const reject = () => { throw new Error('Invalid native evidence'); };

export function prepareNativeEvidence({ input, output, env = process.env }) {
  assertHosted(env);
  if (existsSync(output) || resolve(input) === resolve(output)) reject();
  const source = lstatSync(input);
  if (!source.isDirectory() || source.isSymbolicLink()) reject();
  const names = readdirSync(input);
  const allowed = new Set(['result.json', 'application.log', ...labels.flatMap((name) => [`${name}.png`, `${name}-ui.json`])]);
  const files = new Map();
  for (const name of names) {
    const path = join(input, name), stat = lstatSync(path);
    if (!allowed.has(name) || !stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) reject();
    if (name.endsWith('.png')) {
      const bytes = readFileSync(path);
      inspectPng(bytes);
      files.set(name, bytes);
    }
  }
  if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')) reject();
  if (!['darwin', 'win32', 'linux'].includes(process.platform) || !['arm64', 'x64'].includes(process.arch)) reject();
  const clean = {
    schema: 1, revision: env.GITHUB_SHA, mode: 'electron',
    platform: process.platform, architecture: process.arch,
    status: 'incomplete', passed: [],
    limitations: ['synthetic-media-only', 'hosted-hardware', 'source-build-not-installer'],
  };
  if (names.includes('result.json')) {
    const raw = JSON.parse(readFileSync(join(input, 'result.json'), 'utf8'));
    if (raw.mode !== 'electron' || raw.platform !== clean.platform || raw.architecture !== clean.architecture ||
        !Array.isArray(raw.passed) || raw.passed.length !== checks.length ||
        new Set(raw.passed).size !== checks.length || raw.passed.some((name) => !checks.includes(name))) reject();
    clean.status = 'passed';
    clean.passed = checks;
  }
  files.set('result.json', Buffer.from(JSON.stringify(clean, null, 2)));
  const manifest = [...files].map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }));
  // All validation precedes staging. Raw UI text, poses, paths and logs never enter it.
  try {
    mkdirSync(output);
    for (const [name, bytes] of files) writeFileSync(join(output, name), bytes);
    writeFileSync(join(output, 'manifest.json'), JSON.stringify({ schema: 1, provenance: 'disposable-hosted-synthetic-test', files: manifest }, null, 2));
  } catch {
    rmSync(output, { recursive: true, force: true });
    reject();
  }
  return clean;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const root = resolve('studio/out/native-keyframe-verification');
    prepareNativeEvidence({ input: join(root, `${process.platform}-${process.arch}-electron`), output: join(root, 'public-evidence') });
    console.log('Synthetic native evidence privacy gate passed.');
  } catch { console.error('Native evidence privacy gate failed; upload is blocked.'); process.exitCode = 1; }
}
