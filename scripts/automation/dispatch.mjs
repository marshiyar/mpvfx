/** Runs on the default branch; dispatches only fixed checks on our development branch. */
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repository = 'marshiyar/mpvfx';
const branch = 'patches-windows';
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
export function releaseKey(release, harness) {
  if (!/^v\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(release?.tag_name ?? '') || !/^[a-f0-9]{40}$/.test(harness)) throw new Error('Invalid release identity');
  const assets = release.assets.map(({ id, name, size, updated_at, digest: assetDigest }) => ({ id, name, size, updated_at, digest: assetDigest ?? null })).sort((a, b) => a.id - b.id);
  return digest({ tag: release.tag_name, harness, assets });
}
export function planDispatches({ now, head, harness, release, sourceRuns, visualRuns }) {
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error('Invalid revision');
  const sourceKey = `${now.toISOString().slice(0, 10)}-${head.slice(0, 12)}`;
  const visualKey = releaseKey(release, harness);
  const candidates = [
    { workflow: 'quality-cycle.yml', title: `Quality audit ${sourceKey}`, inputs: { audit_key: sourceKey }, runs: sourceRuns },
    { workflow: 'visual-release.yml', title: `Visual release ${release.tag_name} ${visualKey}`, inputs: { release_tag: release.tag_name, audit_key: visualKey }, runs: visualRuns },
  ];
  // A failed completed run is still evidence. Do not spend four more machines
  // rediscovering it. Manual reruns remain available after infrastructure faults.
  return candidates.filter(({ workflow, title, runs }) => !runs.some((run) => {
    const sameDailyPush = workflow === 'quality-cycle.yml' && run.event === 'push' && run.head_sha === head && run.created_at?.slice(0, 10) === now.toISOString().slice(0, 10);
    return (run.display_title === title || sameDailyPush) && run.conclusion !== 'cancelled';
  })).map(({ runs, ...item }) => item);
}

export async function dispatch({ token = process.env.GH_TOKEN, fetcher = fetch, dryRun = false } = {}) {
  if (!token) throw new Error('GitHub authentication unavailable');
  const api = async (path, body) => {
    const response = await fetcher(`https://api.github.com/repos/${repository}/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub request failed (${response.status})`);
    return response.status === 204 ? null : response.json();
  };
  const [commit, release, source, visual] = await Promise.all([
    api(`commits/${branch}`), api('releases/latest'),
    api(`actions/workflows/quality-cycle.yml/runs?branch=${branch}&per_page=100`),
    api(`actions/workflows/visual-release.yml/runs?branch=${branch}&per_page=100`),
  ]);
  const tree = await api(`git/trees/${commit.sha}?recursive=1`);
  if (tree.truncated) throw new Error('Incomplete harness identity');
  const harnessPaths = ['.github/workflows/visual-release.yml', 'studio/tests/e2e/visual-release.mjs', 'studio/tests/e2e/windows-desktop-watch.ps1', 'studio/package-lock.json', 'scripts/automation/privacy.mjs'];
  const harnessEntries = tree.tree.filter(({ path }) => harnessPaths.includes(path)).map(({ path, sha }) => ({ path, sha })).sort((a, b) => a.path.localeCompare(b.path));
  if (harnessEntries.length !== harnessPaths.length) throw new Error('Incomplete harness');
  const harness = createHash('sha1').update(JSON.stringify(harnessEntries)).digest('hex');
  const plan = planDispatches({ now: new Date(), head: commit.sha, harness, release, sourceRuns: source.workflow_runs, visualRuns: visual.workflow_runs });
  for (const item of plan) {
    if (!dryRun) await api(`actions/workflows/${item.workflow}/dispatches`, { ref: branch, inputs: item.inputs });
  }
  return { schema: 1, branch, revision: commit.sha, dryRun, dispatches: plan };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await dispatch({ dryRun: process.argv.includes('--dry-run') });
    console.log(JSON.stringify(result, null, 2));
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Deterministic scheduler: ${result.dispatches.length} check groups queued for ${branch}. Unchanged release evidence is reused. No AI calls, releases or source edits.\n`);
  } catch { console.error('Quality scheduler failed; no credentials or response body are logged.'); process.exitCode = 1; }
}
