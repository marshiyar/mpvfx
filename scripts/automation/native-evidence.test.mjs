import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareNativeEvidence } from './native-evidence.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJYoAAAAASUVORK5CYII=', 'base64');
const hosted = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_SHA: 'a'.repeat(40) };
const checks = ['visible-native-lanes', 'exact-midpoint', 'pause-reseek', 'outgoing-interpolation-persistence', 'canvas-position', 'canvas-rotation', 'inspector-width', 'inspector-scale', 'preserved-pose-a', 'all-channel-keyframe-add-remove', 'atomic-undo-redo', 'save-reopen',
  'keyframe-clipboard-and-scoped-delete',
  'clip-copy-cut-duplicate',
  'complete-curve-split-and-reopen',
  'select-delete-all-and-undo',
];
function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'mpvfx-native-evidence-'));
  const input = join(root, 'raw'), output = join(root, 'public');
  mkdirSync(input);
  writeFileSync(join(input, 'initial.png'), png);
  writeFileSync(join(input, 'result.json'), JSON.stringify({ mode: 'electron', platform: process.platform, architecture: process.arch, passed: checks, poseA: { private: 'PRIVATE_CANARY' } }));
  try { fn({ input, output, env: hosted }); } finally { rmSync(root, { recursive: true, force: true }); }
}
test('native evidence includes pixels and projected checks, never logs, UI text or raw poses', () => fixture((options) => {
  writeFileSync(join(options.input, 'application.log'), 'PRIVATE_CANARY');
  writeFileSync(join(options.input, 'initial-ui.json'), 'PRIVATE_CANARY');
  assert.equal(prepareNativeEvidence(options).status, 'passed');
  assert.deepEqual(readdirSync(options.output).sort(), ['initial.png', 'manifest.json', 'result.json']);
  assert.ok(!readFileSync(join(options.output, 'result.json'), 'utf8').includes('PRIVATE_CANARY'));
}));
test('native evidence rejects local runs, symlinks, extra files, metadata and incomplete result schemas', () => {
  for (const kind of ['local', 'symlink', 'extra', 'metadata', 'schema', 'revision']) fixture((options) => {
    if (kind === 'local') options.env = {};
    if (kind === 'revision') options.env = { ...hosted, GITHUB_SHA: 'private path' };
    if (kind === 'symlink') symlinkSync(join(options.input, 'result.json'), join(options.input, 'pose-a.png'));
    if (kind === 'extra') writeFileSync(join(options.input, 'private.csv'), 'PRIVATE_CANARY');
    if (kind === 'schema') writeFileSync(join(options.input, 'result.json'), JSON.stringify({ mode: 'browser', passed: checks }));
    if (kind === 'metadata') {
      const data = Buffer.from('PRIVATE_CANARY'), chunk = Buffer.alloc(data.length + 12);
      chunk.writeUInt32BE(data.length); chunk.write('tEXt', 4); data.copy(chunk, 8);
      writeFileSync(join(options.input, 'initial.png'), Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]));
    }
    assert.throws(() => prepareNativeEvidence(options));
    assert.equal(existsSync(options.output), false);
  });
});
test('failed native scenarios retain a screenshot without manufacturing a passing result', () => fixture((options) => {
  rmSync(join(options.input, 'result.json'));
  const clean = prepareNativeEvidence(options);
  assert.equal(clean.status, 'incomplete');
  assert.deepEqual(clean.passed, []);
}));
