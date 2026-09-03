# Architecture

MpVFX is a media-first desktop editor with four main boundaries:

1. `studio/src/` contains the React editor, timeline, preview controls, inspector, and local UI state.
2. `studio/desktop/` contains the Electron lifecycle, window policy, platform paths, and packaged
   runtime setup.
3. `studio/studio.http-service.ts` and `studio/vite.*` provide the loopback project, preview, import,
   and export service.
4. Internal third-party rendering packages adapt project state to preview and export. Their package
   names and persistence details are implementation contracts, not MpVFX product terminology.

The desktop shell serves the editor over a loopback-only HTTP origin. User projects and mutable
media live in the platform application-data directory. The installed application is treated as
read-only. Development fixtures are not a production project store.

Generated output (`dist/`, `desktop-dist/`, `out/`), dependencies, caches, local projects, and
recovery directories are excluded from source control. The QA corpus is test provenance and lives
under `third_party/`, outside the application bundle.

