import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { minimalEnvironment, publicResult, prepareEvidence } from './privacy.mjs';

const hosted = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' };
const result = () => ({ version: '0.0.2', platform: 'win32', architecture: 'x64', sha256: 'a'.repeat(64), buildFingerprint: 'b'.repeat(64), passed: ['published-installer-checksum'], failures: [], exports: [], screenshots: [] });
function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'mpvfx-evidence-test-'));
  const input = join(root, 'evidence'), output = join(root, 'public-evidence');
  mkdirSync(input);
  writeFileSync(join(input, 'result.json'), JSON.stringify(result()));
  try { fn({ input, output, env: hosted }); } finally { rmSync(root, { recursive: true, force: true }); }
}
test('child environments never inherit credentials, tracing configuration, or Node injection', () => {
  const env = minimalEnvironment({ PATH: '/bin', SystemRoot: 'C:\\Windows', HOME: '/synthetic/home', GH_TOKEN: 'private', NODE_OPTIONS: '--require=private', APPLE_ID: 'private', MPVFX_TELEMETRY_URL: 'private', ELECTRON_RUN_AS_NODE: '1' });
  assert.deepEqual(env, { PATH: '/bin', SystemRoot: 'C:\\Windows', HOME: '/synthetic/home' });
});
test('public results contain bounded facts, never errors, titles, paths, or report contents', () => {
  const privateText = 'PRIVATE_CANARY_DO_NOT_PUBLISH';
  const clean = publicResult({ ...result(), arbitrary: privateText, shortcuts: [privateText], failures: [{ phase: 'mp4-render-1', message: privateText, observations: [{ title: privateText }] }], exports: [{ format: 'mov', status: 'failed', elapsedMs: 42, stderr: privateText }], screenshots: [privateText] });
  assert.ok(!JSON.stringify(clean).includes(privateText));
  assert.equal(clean.shortcutCount, 1);
  assert.deepEqual(clean.failures, [{ phase: 'mp4-render-1', code: 'scenario-failed' }]);
  assert.throws(() => publicResult({ ...result(), version: privateText }), /Invalid evidence/);
});
test('uploads are unavailable outside a disposable hosted runner', () => fixture((options) => {
  assert.throws(() => prepareEvidence({ ...options, env: {} }), /hosted/);
  assert.equal(existsSync(options.output), false);
}));
test('unexpected files, symlinks and oversized files fail closed without leaking their names', () => {
  for (const kind of ['unknown', 'symlink', 'oversize']) fixture((options) => {
    const path = join(options.input, kind === 'unknown' ? 'PRIVATE_CANARY_DO_NOT_PUBLISH.json' : '01-first-launch-app.png');
    if (kind === 'symlink') symlinkSync(join(options.input, 'result.json'), path);
    else writeFileSync(path, kind === 'oversize' ? Buffer.alloc(17 * 1024 * 1024) : 'private');
    let error; try { prepareEvidence(options); } catch (caught) { error = caught; }
    assert.ok(error);
    assert.ok(!String(error).includes('PRIVATE_CANARY'));
    assert.equal(existsSync(options.output), false);
  });
});
test('only projected JSON enters the public directory; raw desktops are omitted', () => fixture((options) => {
  writeFileSync(join(options.input, '10-native-crash-dialog-desktop.png'), 'private desktop pixels');
  writeFileSync(join(options.input, 'result.json'), JSON.stringify({ ...result(), failures: [{ phase: 'diagnostic-report', message: 'PRIVATE_CANARY' }] }));
  prepareEvidence(options);
  assert.deepEqual(readdirSync(options.output).sort(), ['manifest.json', 'result.json']);
  assert.ok(!readFileSync(join(options.output, 'result.json'), 'utf8').includes('PRIVATE_CANARY'));
}));
test('Windows native frames require the masked capture policy and exclude window metadata', () => fixture((options) => {
  writeFileSync(join(options.input, 'windows-desktop.json'), JSON.stringify({ frames: 1, observations: [{ windows: [{ title: 'PRIVATE_CANARY' }] }] }));
  writeFileSync(join(options.input, 'desktop-00000.png'), 'untrusted');
  assert.throws(() => prepareEvidence(options), /capture policy/);
  assert.equal(existsSync(options.output), false);
}));
test('valid synthetic pixels get a checksum manifest; metadata-bearing images are rejected', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJYoAAAAASUVORK5CYII=', 'base64');
  fixture((options) => {
    writeFileSync(join(options.input, '01-first-launch-app.png'), png);
    prepareEvidence(options);
    const manifest = JSON.parse(readFileSync(join(options.output, 'manifest.json'), 'utf8'));
    assert.equal(manifest.files.find((file) => file.name.endsWith('.png')).sha256.length, 64);
  });
  fixture((options) => {
    const text = Buffer.from('PRIVATE_CANARY');
    const chunk = Buffer.alloc(text.length + 12); chunk.writeUInt32BE(text.length); chunk.write('tEXt', 4); text.copy(chunk, 8);
    writeFileSync(join(options.input, '01-first-launch-app.png'), Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]));
    assert.throws(() => prepareEvidence(options), /image metadata/);
    assert.equal(existsSync(options.output), false);
  });
});
test('masked Windows frames retain timing but never process identities or titles', () => fixture((options) => {
  writeFileSync(join(options.input, 'desktop-00000.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJYoAAAAASUVORK5CYII=', 'base64'));
  writeFileSync(join(options.input, 'windows-desktop.json'), JSON.stringify({ capturePolicy: 'mpvfx-windows-only', observations: [{ image: 'desktop-00000.png', elapsedMs: 123, phase: 'first-launch', windows: [{ title: 'PRIVATE_CANARY', pid: 999 }] }] }));
  prepareEvidence(options);
  const capture = readFileSync(join(options.output, 'windows-desktop.json'), 'utf8');
  assert.ok(!capture.includes('PRIVATE_CANARY')); assert.ok(!capture.includes('999'));
  assert.equal(JSON.parse(capture).observations[0].elapsedMs, 123);
}));
