/** Deterministic health checks: no model, telemetry endpoint or private files. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { minimalEnvironment } from './privacy.mjs';

const root = resolve(import.meta.dirname, '../..');
const node = process.execPath;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const checks = [
  ['automation-privacy', node, ['--test', 'scripts/automation/privacy.test.mjs', 'scripts/automation/dispatch.test.mjs']],
  ['publication', node, ['scripts/check-release-readiness.mjs']],
  ['attribution', node, ['scripts/generate-third-party-notices.mjs', '--check']],
  ['diagnostics-regressions', npm, ['--prefix', 'studio', 'run', 'test:watch', '--', '--run', 'diagnostics', 'src/diagnostics', 'src/telemetry/policy.test.ts', 'src/utils/studioDebug.test.ts', 'desktop/publicationPrivacy.test.ts', 'desktop/githubWorkflows.test.ts', 'desktop/windowsRenderHelpers.test.ts', 'desktop/windowsBrowserLaunch.test.ts', 'desktop/streamingPngInput.test.ts']],
  ['typecheck', npm, ['--prefix', 'studio', 'run', 'typecheck']],
  ['build', npm, ['--prefix', 'studio', 'run', 'build']],
];
if (process.argv.includes('--plan')) {
  console.log(JSON.stringify({ checks: checks.map(([id]) => id), audit: 'public-lockfile-only', sendsTelemetry: false, usesAI: false }));
  process.exit(0);
}
const scratch = mkdtempSync(join(tmpdir(), 'mpvfx-quality-'));
try {
  const env = { ...minimalEnvironment(), CI: 'true', NPM_CONFIG_USERCONFIG: join(scratch, 'npmrc'), NPM_CONFIG_GLOBALCONFIG: join(scratch, 'global-npmrc'), NPM_CONFIG_CACHE: join(scratch, 'npm-cache'), NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/' };
  writeFileSync(env.NPM_CONFIG_USERCONFIG, ''); writeFileSync(env.NPM_CONFIG_GLOBALCONFIG, '');
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', env });
  const commit = git.stdout?.trim();
  if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error('No source revision');
  const summary = { schema: 1, commit, checks: [], advisories: [], dependencyAudit: 'unavailable' };
  for (const [id, command, args] of checks) {
    const start = Date.now();
    const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 12 * 60_000, maxBuffer: 24 * 1024 * 1024, windowsHide: true });
    // Command output stays in memory. Assertion output can contain project
    // values; only an allowlisted check id, status and duration is published.
    const status = result.error ? 'error' : result.status === 0 ? 'passed' : 'failed';
    summary.checks.push({ id, status, elapsedMs: Date.now() - start });
    console.log(`${id}: ${status}`);
  }
  const audit = spawnSync(npm, ['audit', '--prefix', 'studio', '--package-lock-only', '--ignore-scripts', '--json'], { cwd: root, env, encoding: 'utf8', timeout: 90_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  try {
    const data = JSON.parse(audit.stdout);
    if (audit.error || data.error || !data.vulnerabilities || !data.metadata?.vulnerabilities) throw new Error('unavailable');
    const found = new Map();
    for (const item of Object.values(data.vulnerabilities)) for (const via of item.via ?? []) {
      if (typeof via !== 'object') continue;
      const id = String(via.url ?? '').match(/^https:\/\/github\.com\/advisories\/(GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})$/)?.[1];
      if (id && ['info', 'low', 'moderate', 'high', 'critical'].includes(via.severity)) found.set(id, { id, severity: via.severity });
    }
    summary.advisories = [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
    summary.dependencyAudit = 'complete';
    // A nonzero audit with an unrecognized advisory must still fail closed.
    summary.dependencyAuditPassed = audit.status === 0;
  } catch { summary.dependencyAuditPassed = false; }
  const stable = { ...summary, checks: summary.checks.map(({ id, status }) => ({ id, status })) };
  summary.fingerprint = createHash('sha256').update(JSON.stringify(stable)).digest('hex');
  const output = join(root, 'studio/out/quality'); mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `MpVFX deterministic audit: ${commit}\n\n${summary.checks.map((check) => `- ${check.id}: ${check.status}`).join('\n')}\n- Dependency audit: ${summary.dependencyAudit}; ${summary.advisories.length} advisory IDs.\n\nOnly structured test status and public advisory IDs are retained. No raw logs, profiles or crash reports.\n`);
  process.exitCode = summary.checks.every((check) => check.status === 'passed') && summary.dependencyAuditPassed ? 0 : 1;
} catch { console.error('Quality audit could not produce a verified summary.'); process.exitCode = 1; }
finally { rmSync(scratch, { recursive: true, force: true }); }
