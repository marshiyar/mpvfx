# Releasing MpVFX

The release version comes from `studio/package.json`.

Run `npm --prefix studio run release:check` to check publication boundaries and packaged notices.
Repository policy documents, `.editorconfig`, `docs/ARCHITECTURE.md`, and the E2E fixture
provenance document are optional. Removing them does not block this check. Root
`THIRD_PARTY_NOTICES.md` and `PRIVACY.md` are synchronized only when present;
`notices:update` maintains the packaged resources without recreating those root documents.

## GitHub Actions

Run **Build GitHub Release** manually from the Actions page. The workflow creates the matching tag
and GitHub Release after all platform builds succeed.

Alternatively, push the matching tag:

```bash
git tag -a v0.0.1 -m "MpVFX v0.0.1"
git push origin v0.0.1
```

The workflow publishes:

- macOS Apple Silicon and Intel DMGs
- Windows installer files
- Linux DEB and RPM packages
- SHA-256 checksums
- FFmpeg corresponding source

These builds are unsigned, so macOS and Windows may display an unverified-developer warning.
