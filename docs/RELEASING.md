# Releasing MpVFX

The release version comes from `studio/package.json`.

## GitHub Actions

Run **Build GitHub Release** manually from the Actions page. The workflow creates the matching tag
and GitHub Release after all platform builds succeed.

Alternatively, push the matching tag:

```bash
git tag -a v0.8.21 -m "MpVFX v0.8.21"
git push origin v0.8.21
```

The workflow publishes:

- macOS Apple Silicon and Intel DMGs
- Windows installer files
- Linux DEB and RPM packages
- SHA-256 checksums
- FFmpeg corresponding source

These builds are unsigned, so macOS and Windows may display an unverified-developer warning.
