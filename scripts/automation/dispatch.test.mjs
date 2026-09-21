import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch, planDispatches, releaseKey } from './dispatch.mjs';
const release = { tag_name: 'v0.0.2', assets: [{ id: 1, name: 'MpVFX-0.0.2-Setup.exe', size: 42, updated_at: '2026-09-21T00:00:00Z' }] };
const input = () => ({ now: new Date('2026-09-21T15:00:00Z'), head: 'a'.repeat(40), harness: 'b'.repeat(40), release, sourceRuns: [], visualRuns: [] });
test('suggests bounded source and visual checks for a new revision', () => {
  assert.equal(planDispatches(input()).length, 2);
});
test('does not repeat identical failed visual work or duplicate the daily audit', () => {
  const first = planDispatches(input());
  const prior = first.map((item) => ({ display_title: item.title, status: 'completed', conclusion: 'failure', event: 'workflow_dispatch' }));
  assert.deepEqual(planDispatches({ ...input(), sourceRuns: [prior[0]], visualRuns: [prior[1]] }), []);
});
test('an idle day suggests no repeated checks; changed assets invalidate visual evidence', () => {
  const data = input(), first = planDispatches(data);
  const prior = first.map((item) => ({ display_title: item.title, status: 'completed', conclusion: 'success', event: 'workflow_dispatch' }));
  assert.equal(planDispatches({ ...data, now: new Date('2026-09-22T15:00:00Z'), sourceRuns: [prior[0]], visualRuns: [prior[1]] }).length, 0);
  assert.notEqual(releaseKey(release, data.harness), releaseKey({ ...release, assets: [{ ...release.assets[0], size: 43 }] }, data.harness));
});
test('rejects untrusted ref strings and malformed fingerprints', () => {
  assert.throws(() => planDispatches({ ...input(), head: 'not-a-commit' }));
  assert.throws(() => releaseKey({ ...release, tag_name: 'v0.0.2; arbitrary' }, input().harness));
});
test('reuses an audit already triggered by a push on the same day', () => {
  const data = input();
  const sourceRuns = [{ event: 'push', head_sha: data.head, created_at: '2026-09-21T10:00:00Z', conclusion: 'failure' }];
  const next = planDispatches({ ...data, sourceRuns });
  assert.equal(next.length, 1);
  assert.equal(next[0].workflow, 'visual-release.yml');
});
test('the planner cannot spend Actions minutes, even if a caller asks it to dispatch', async () => {
  const methods = [];
  const paths = ['.github/workflows/visual-release.yml', 'studio/tests/e2e/visual-release.mjs', 'studio/tests/e2e/windows-desktop-watch.ps1', 'studio/package-lock.json', 'scripts/automation/privacy.mjs'];
  const fetcher = async (url, options) => {
    methods.push(options.method);
    const data = url.includes('/git/trees/') ? { tree: paths.map((path) => ({ path, sha: 'b'.repeat(40) })) }
      : url.includes('/commits/') ? { sha: 'a'.repeat(40) }
      : url.includes('/releases/') ? release : { workflow_runs: [] };
    return { ok: true, status: options.method === 'POST' ? 204 : 200, json: async () => data };
  };
  await dispatch({ token: 'synthetic-test-value', fetcher, dryRun: false });
  assert.ok(methods.every((method) => method === 'GET'));
});
