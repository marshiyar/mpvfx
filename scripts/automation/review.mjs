/** A compact, deduplicated inbox for the scheduled reviewer; no raw CI logs. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = 'marshiyar/mpvfx', branch = 'patches-windows';
const root = resolve(import.meta.dirname, '../..'), stateDir = join(root, 'studio/out/quality-review');
function gh(args) { return execFileSync('gh', args, { cwd: root, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024, windowsHide: true }); }
try {
  const workflows = ['quality-cycle.yml', 'visual-release.yml', 'quality-schedule.yml'];
  const runs = workflows.flatMap((workflow) => {
    const data = JSON.parse(gh(['run', 'list', '--repo', repo, '--workflow', workflow, '--branch', workflow === 'quality-schedule.yml' ? 'main' : branch, '--limit', '1', '--json', 'databaseId,headSha,status,conclusion']));
    return data.map((run) => {
      if (!Number.isSafeInteger(run.databaseId) || !/^[a-f0-9]{40}$/.test(run.headSha) || !['completed', 'in_progress', 'queued', 'waiting', 'pending', 'requested'].includes(run.status) || !['', 'success', 'failure', 'cancelled', 'timed_out', 'action_required', 'neutral', 'skipped', 'stale', 'startup_failure'].includes(run.conclusion)) throw new Error('Invalid run metadata');
      return { workflow, id: run.databaseId, commit: run.headSha, status: run.status, conclusion: run.conclusion, url: `https://github.com/${repo}/actions/runs/${run.databaseId}` };
    });
  });
  let audit = null;
  const source = runs.find((run) => run.workflow === 'quality-cycle.yml' && run.status === 'completed');
  if (source) {
    const temp = mkdtempSync(join(tmpdir(), 'mpvfx-review-summary-'));
    try {
      gh(['run', 'download', String(source.id), '--repo', repo, '--name', 'quality-summary', '--dir', temp]);
      const files = readdirSync(temp);
      const file = join(temp, 'summary.json');
      if (files.length !== 1 || files[0] !== 'summary.json' || lstatSync(file).isSymbolicLink() || lstatSync(file).size > 64 * 1024) throw new Error('Invalid summary');
      const data = JSON.parse(readFileSync(file, 'utf8'));
      if (data.schema !== 1 || data.commit !== source.commit || !/^[a-f0-9]{64}$/.test(data.fingerprint)) throw new Error('Invalid summary');
      const checks = data.checks.map(({ id, status }) => {
        if (!['automation-privacy', 'publication', 'attribution', 'diagnostics-regressions', 'typecheck', 'build'].includes(id) || !['passed', 'failed', 'error'].includes(status)) throw new Error('Invalid check');
        return { id, status };
      });
      const advisories = data.advisories.map(({ id, severity }) => {
        if (!/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(id) || !['info', 'low', 'moderate', 'high', 'critical'].includes(severity)) throw new Error('Invalid advisory');
        return { id, severity };
      });
      audit = { checks, advisories, dependencyAudit: data.dependencyAudit === 'complete' ? 'complete' : 'unavailable', dependencyAuditPassed: data.dependencyAuditPassed === true };
    } catch { audit = { available: false }; }
    finally { rmSync(temp, { recursive: true, force: true }); }
  }
  // Ignore changing run IDs/timings. Identical failures and public advisories
  // on the same source revision should not trigger repeated investigations.
  const fingerprint = createHash('sha256').update(JSON.stringify({ runs: runs.map(({ workflow, commit, status, conclusion }) => ({ workflow, commit, status, conclusion })), audit })).digest('hex');
  const stateFile = join(stateDir, 'seen.json');
  const seen = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')).fingerprint : null;
  const ackIndex = process.argv.indexOf('--ack');
  if (ackIndex !== -1) {
    if (process.argv[ackIndex + 1] !== fingerprint) throw new Error('Results changed; review again');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(stateFile, JSON.stringify({ fingerprint }));
  }
  console.log(JSON.stringify({ schema: 1, changed: seen !== fingerprint, fingerprint, runs, audit, next: 'Read docs/CONTINUOUS_IMPROVEMENT.md; do not rerun known failures or accept visual baselines automatically.' }, null, 2));
} catch { console.error('Review inbox unavailable. Do not substitute raw logs or private data.'); process.exitCode = 1; }
