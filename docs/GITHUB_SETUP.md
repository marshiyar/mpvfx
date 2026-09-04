# GitHub repository settings

After creating the repository, apply these settings before inviting contributors or publishing an
application release.

For a fresh local clone, activate the tracked privacy/release hooks once:

```bash
git config core.hooksPath .githooks
```

The hooks run publication-boundary and attribution checks before commits and pushes. GitHub CI runs
the same checks for contributors who have not enabled local hooks.

## Repository

- The repository name must be exactly `mpvfx`.
- Use `main` as the default branch.
- The tracked `LICENSE` is the authoritative Apache License 2.0 grant for MpVFX-owned source.
  `NOTICE`, `THIRD_PARTY_NOTICES.md`, and `third_party/` preserve other terms.
- Enable private vulnerability reporting, Dependabot alerts, dependency graph, secret scanning,
  and push protection where the repository plan supports them.
- Allow GitHub Actions to request write access for the release job. The workflows default to read-
  only; only the final tag publisher requests `contents: write`.

If a remote is not configured, connect the checkout using the real owner in place of `OWNER`:

```bash
git remote add origin git@github.com:OWNER/mpvfx.git
git push -u origin main
```

## Rules for `main` and release tags

Create a branch ruleset for `main` that requires pull requests, an approving review, resolved
conversations, an up-to-date branch, and the repository/test/compile/CodeQL/desktop checks. Block
force pushes and branch deletion, and do not allow casual administrator bypass.

Create a tag ruleset for `v*` that blocks tag deletion and non-fast-forward updates. Restrict tag
creation to release maintainers. A tag starts publication, so it must identify an already reviewed
commit whose package version and changelog are final.

## Protected release environment

Create an Actions environment named exactly `release`:

- add required reviewers and prevent self-review when the repository plan supports it;
- restrict deployments to tags matching `v*`;
- store every signing value below as an environment secret, never a repository file;
- do not expose this environment to pull-request workflows.

Required macOS secrets:

- `MACOS_CERTIFICATE` — base64-encoded Developer ID Application `.p12`
- `MACOS_CERTIFICATE_PASSWORD` — password protecting that `.p12`
- `MACOS_KEYCHAIN_PASSWORD` — random, release-only temporary-keychain password
- `MACOS_SIGNING_IDENTITY` — full `Developer ID Application: Name (TEAMID)` identity
- `APPLE_ID` — Apple Developer account used for notarization
- `APPLE_APP_SPECIFIC_PASSWORD` — app-specific password, not the Apple ID password
- `APPLE_TEAM_ID` — Apple Developer team identifier

Required Windows secrets:

- `WINDOWS_CERTIFICATE` — base64-encoded Authenticode `.pfx`
- `WINDOWS_CERTIFICATE_PASSWORD` — password protecting that `.pfx`

Encode the certificate files locally, copy the single-line output into GitHub, then securely remove
any temporary text copy. On macOS:

```bash
base64 -i DeveloperIDApplication.p12 | tr -d '\n'
```

On Windows PowerShell:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('MpVFX-signing.pfx'))
```

The workflow reconstructs certificates only in each runner's temporary directory, imports the
Apple certificate into a temporary keychain, and removes temporary signing material even after a
failed build. It fails before publication if a required secret, signature, notarization ticket,
installer, source archive, or checksum is missing.

## Actions and private data

- Workflows pin third-party actions to full commit hashes.
- Never commit signing certificates, populated `.env` files, API tokens, AI-agent conversations,
  or session state.
- Run `npm run release:check` from `studio/` before each push and release. It rejects common secret,
  conversation-export, personal-media, and local-project patterns.
- Add `CODEOWNERS` only after durable maintainer handles are known; include workflows, packaging,
  privacy, security, and licensing paths.
