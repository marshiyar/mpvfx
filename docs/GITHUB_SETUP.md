# GitHub repository settings

The source tree can be published without uploading installers. After creating the GitHub
repository, apply these settings before inviting contributors or accepting changes.

For a fresh local clone, activate the tracked privacy/release hooks once:

```bash
git config core.hooksPath .githooks
```

The hooks run the publication-boundary and attribution checks before commits and pushes. GitHub CI
runs the same checks and remains the enforcement fallback for contributors who have not enabled
local hooks.

## Repository

- The repository name must be exactly `mpvfx`.
- Use `main` as the default branch.
- Select Apache License 2.0 when GitHub asks for the repository license. The tracked `LICENSE` file
  is authoritative; `NOTICE` and `THIRD_PARTY_NOTICES.md` preserve separately licensed material.
- Enable Issues only if maintainers can triage them, and keep blank issues disabled.
- Enable private vulnerability reporting before directing reporters to `SECURITY.md`.
- Enable Dependabot alerts, dependency graph, secret scanning, and push protection where the
  repository plan supports them.
- Leave Releases empty until every binary gate in `RELEASING.md` is complete.

Do not add a remote or push until the owner and visibility have been deliberately selected. When
those decisions are final, create the GitHub repository as `mpvfx`, then connect this working tree
using the real owner in place of `OWNER`:

```bash
git remote add origin git@github.com:OWNER/mpvfx.git
git push -u origin main
```

## Rules for `main`

Create a branch ruleset that:

- requires pull requests and at least one approving review;
- dismisses stale approvals when code changes;
- requires conversation resolution;
- blocks force pushes and branch deletion;
- requires branches to be up to date;
- requires the repository, test, compile, CodeQL, and relevant desktop matrix checks;
- does not allow administrators to bypass the rules casually.

The first workflow run establishes the exact check names shown in the ruleset picker. Do not make
an installer upload or release job a required check until a separately reviewed publishing
workflow exists.

## Actions and credentials

- Keep the default workflow token read-only and grant narrower write permissions per job only when
  a job genuinely needs them.
- Allow only reviewed actions; workflows in this repository pin actions to full commit hashes.
- Do not add signing certificates, notarization credentials, analytics keys, or API tokens until a
  workflow needs them. Store such values as environment-scoped GitHub secrets, require approval for
  that environment, and never expose secrets to pull requests from forks.
- Treat AI-agent conversations and session state as private local data. Run `npm run release:check`
  from `studio/` before the first push and every release; it rejects common conversation exports and
  transcript-shaped files.

## Ownership

Add `CODEOWNERS` only after the final GitHub organization or maintainer handles are known. Require
review from owners of workflows, packaging, privacy, security, and licensing files. Also replace
generic maintainer wording in policy documents with the project's durable private contact channel
once that channel exists.
