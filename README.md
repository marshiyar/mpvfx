# MpVFX

MpVFX is a desktop nonlinear video editor for arranging video, images, audio, captions, effects,
and color treatments on a multitrack timeline. It is built with Electron, React, and a local media
rendering service.
## Features

- Media-first multitrack timeline with stable empty-track layout
- Video, image, and audio imports with thumbnails and waveforms
- Clip-level effect and color strips
- Live preview, trimming, splitting, captions, and export
- Native installers for macOS, Windows, and Linux
- Local project storage with recovery data kept outside published source

## Development

Requirements:

- Node.js 22.23.2 (pinned in `studio/.nvmrc`)
- npm and the native packaging tools for your platform
- macOS 15.0 or later when running the packaged Mac application

```bash
cd studio
npm ci
npm run desktop:dev
```

Useful checks:

```bash
cd studio
npm test
npm run typecheck
npm run build
npm run release:check
```

See [studio/README.md](studio/README.md) for editor-specific development and packaging commands.
Official downloadable installers are created from reviewed version tags through the protected,
signed release process in [docs/RELEASING.md](docs/RELEASING.md).

## Repository layout

- `studio/` — application, desktop shell, tests, and build configuration
- `third_party/` — separately licensed source material and license records
- `docs/` — architecture, data provenance, and release process
- `.github/` — CI, security scanning, dependency updates, and contribution templates

Local projects under `studio/fixtures/MpVFX/`, `studio/fixtures/my-video/`, and
`studio/fixtures/storyboard-sample/` are deliberately ignored. They are not part of the product
source and must not be committed.

## Privacy and security

Official builds have analytics disabled unless a distributor explicitly supplies its own telemetry
endpoint and key. Project media stays local except for network actions initiated by the user, such
as downloading a background-removal model or an online font. Details are in [PRIVACY.md](PRIVACY.md).

Please report vulnerabilities according to [SECURITY.md](SECURITY.md).
Repository administrators should apply the protections in
[docs/GITHUB_SETUP.md](docs/GITHUB_SETUP.md) immediately after creating the GitHub repository.

## Licensing and attribution

MpVFX-owned source and documentation are licensed under the Apache License, Version 2.0. Third-party
material retains its own licenses and is not relicensed by the repository's Apache-2.0 license. Read
[LICENSE](LICENSE), [NOTICE](NOTICE), and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) before
redistributing any part of the repository.

The QA research corpus is separately documented and attributed under
[`third_party/stackexchange-video-qa/`](third_party/stackexchange-video-qa/).
