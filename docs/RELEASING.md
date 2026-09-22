# Releasing MpVFX

The release version comes from `studio/package.json`.

Run `npm --prefix studio run release:check` to check publication boundaries and packaged notices.
Repository policy documents, `.editorconfig`, `docs/ARCHITECTURE.md`, and the E2E fixture
provenance document are optional. Removing them does not block this check. Root
`THIRD_PARTY_NOTICES.md` and `PRIVACY.md` are synchronized only when present;
`notices:update` maintains the packaged resources without recreating those root documents.

## GitHub Actions

Run **Build GitHub Release** manually from the Actions page. The workflow creates the matching tag
and GitHub Release after all platform builds and native diagnostic checks succeed.
Run it against the tested release branch so the tag points at that exact commit.
Before dispatch, synchronize `studio/package.json` and `studio/package-lock.json`,
run `notices:update`, and add `docs/releases/v<version>.md` for the release notes.

Alternatively, push the matching tag:

```bash
git tag -a v0.0.3 -m "MpVFX v0.0.3"
git push origin v0.0.3
```

The workflow publishes:

- macOS Apple Silicon and Intel DMGs
- Windows installer files
- Linux DEB and RPM packages
- SHA-256 checksums
- FFmpeg corresponding source

These builds are unsigned, so macOS and Windows may display an unverified-developer warning.

Every release checks the source publication boundary and actual packaged archive plus extra
resources for credentials, logs, reports, and unexpected local files. The native checks run
the bundled app on both Mac architectures, Windows x64, and Linux x64. Test output stays
outside `out/make`, which is the only installer artifact directory uploaded by the workflow.
Signing keys and notarization Keychain profiles are never copied into the repository or CI.
