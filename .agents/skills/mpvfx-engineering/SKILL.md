---
name: mpvfx-engineering
description: Guide mpVFX code changes, pull requests, regression acceptance, cleanup, and release preparation. Use when planning, implementing, reviewing, or validating work in the mpVFX repository.
---

# mpVFX engineering

1. Inspect the current branch, worktree, repository instructions, and affected runtime paths before editing. Verify the existing Git author identity before committing; preserve other contributors' authorship.
2. Define one coherent purpose and a reviewable boundary for each PR. Keep diffs bounded and describe the changed behavior and evidence briefly. Reassess scope as it grows; put independently reviewable work in separate branches and PRs without waiting for a warning. When delegating, give writers disjoint files or worktrees and use one integrator.
3. If the user says to pause or warns that scope is dangerous, stop the affected implementation or finalization. Inspect the actual diff, propose smaller pieces, and wait for agreed direction on that scope.
4. For product changes, compare packaged builds from recorded, immutable baseline and candidate commits. Exercise the relevant editing actions, persistence, and visual states on supported platforms with disposable projects; retain screenshots, action results, build SHAs, and failures. Diagnose any failed comparison before acceptance; preserve the failure even if its cause is the harness or baseline. Prove the gate detects a known regression or an isolated deliberate fault. Passing source tests, compilation, or a screenshot alone does not establish product acceptance. State which platform behavior remains untested.
5. Before extracting modules, audit callers, state ownership, serialization, bridge permissions, build inputs, and platform paths; agree on the boundary first. Keep the resulting source navigable for teammates.
6. Before removing code, tests, instructions, or generated output, trace direct and dynamic references plus runtime, build, and platform entry points. Preserve original projects and active evidence. Delete only confirmed obsolete material in focused commits.
7. Commit coherent checkpoints under the verified author identity. Record commit or artifact references for handoff; use ordinary branch and commit references rather than release-triggering tags for progress markers.
8. Keep PRs open for user review. Merge or enable auto-merge only after the user reviews that PR and explicitly approves it; do not infer approval from an earlier generic merge request. Treat tags and release workflows as publication actions requiring their own authorization.
