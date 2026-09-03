# MpVFX

Cross-platform Electron nonlinear video editor with import, multitrack timeline editing, live
preview, captions, effects, audio controls, and export. MpVFX runs as a self-contained desktop app;
users do not need Bun, a browser tab, a monorepo checkout, or HTML knowledge.

## What it does

The studio is a React application with:

- **Visual timeline** — drag, resize, and arrange elements on tracks
- **Media library** — import video, audio, images, and fonts
- **Live preview** — see changes in real time as you edit
- **Inspector** — adjust selected clips and visual elements
- **Export** — render finished videos from the editor

## Run the desktop app

This checkout runs independently with npm. The desktop command builds the renderer and launches the
embedded Electron application and loopback editor service:

```bash
cd studio
npm install
npm run desktop:dev
```

Mutable projects, renders, sessions, and caches live in Electron's platform-specific application
data directory. They are not written into the installed application or `fixtures/`.
Background removal uses the packaged ONNX runtime and downloads its model into that cache on first
use; subsequent runs reuse the local model.

The browser-hosted Vite path remains available for focused frontend development:

```bash
npm run dev
npm run build
npm run typecheck  # Type-check
```

For the Vite development path only, use projects from another directory with:

```bash
MPVFX_PROJECTS_DIR=/path/to/projects npm run dev
```

## Package installers

Packaging is pinned to Node 22 LTS (`.nvmrc`) because it is the tested Electron Forge toolchain.
Run packaging on the target operating system so the correct Electron, FFmpeg, FFprobe, and Chromium
binaries are included:

```bash
npm run desktop:package       # unpacked app for the current platform
npm run desktop:make          # native installer for the current platform
```

Dedicated `desktop:make:mac:arm64`, `desktop:make:mac:x64`, `desktop:make:windows`, and
`desktop:make:linux` scripts are available for validation jobs. These installers are unsigned and
the currently bundled FFmpeg build is not redistributable. Do not publish an installer until every
gate in [`docs/RELEASING.md`](../docs/RELEASING.md) is complete.

## Privacy configuration

Official builds have no analytics endpoint or key and therefore send no analytics. A distributor
that intentionally operates its own service can start from `.env.example`; it must also publish an
appropriate privacy notice and consent controls. Never commit a populated `.env` file.

## Tech stack

- Electron, React 19, and Zustand
- Tailwind CSS (styling)
- Vite and tsup (build tooling only)
- Bundled FFmpeg, FFprobe, and Chromium headless shell (media/export runtime)
- Phosphor Icons

Third-party playback and render dependencies are internal implementation details. MpVFX application
development and startup use npm only.
