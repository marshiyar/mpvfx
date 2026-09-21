import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDispatches, releaseKey } from './dispatch.mjs';
const release = { tag_name: 'v0.0.2', assets: [{ id: 1, name: 'MpVFX-0.0.2-Setup.exe', size: 42, updated_at: '2026-09-21T00:00:00Z' }] };
const input = () => ({ now: new Date('2026-09-21T15:00:00Z'), head: 'a'.repeat(40), harness: 'b'.repeat(40), release, sourceRuns: [], visualRuns: [] });
test('dispatches bounded source and visual checks for a new revision', () => {
  assert.equal(planDispatches(input()).length, 2);
});
test('does not repeat identical failed visual work or duplicate the daily audit', () => {
  const first = planDispatches(input());
  const prior = first.map((item) => ({ display_title: item.title, status: 'completed', conclusion: 'failure', event: 'workflow_dispatch' }));
  assert.deepEqual(planDispatches({ ...input(), sourceRuns: [prior[0]], visualRuns: [prior[1]] }), []);
});
test('new days run inexpensive source checks, while new assets invalidate visual evidence', () => {
  const data = input(), first = planDispatches(data);
  const prior = first.map((item) => ({ display_title: item.title, status: 'completed', conclusion: 'success', event: 'workflow_dispatch' }));
  assert.equal(planDispatches({ ...data, now: new Date('2026-09-22T15:00:00Z'), sourceRuns: [prior[0]], visualRuns: [prior[1]] }).length, 1);
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
