# Packaged editor regression gate

`npm --prefix studio run test:packaged-interface-compare` runs the packaged app from the current checkout and a separately built, pinned v0.0.7 checkout on the same runner. Set `MPVFX_BASELINE_ROOT` to that checkout and `MPVFX_UI_EVIDENCE_DIR` to a writable artifact directory. Both apps use disposable libraries and profiles.

The comparison creates a library, imports a generated video, adds and selects a clip, checks its visible preview border and Remove silence action, plays and pauses, exercises undo and redo, and reopens the saved project. Each app saves a 1600×1000 screenshot and measured layout. The runner saves a pixel diff and `comparison.json`, and fails if required controls are missing, layout moves more than four pixels, or more than two percent of pixels differ. The longer `library-workflow.mjs` mode continues to exercise export and shared media separately.

The Linux source suite sets the bundled FFmpeg path and installs the Chrome version pinned by Puppeteer before exercising audio FX rendering. This browser is a test prerequisite; the packaged editor comparison launches the built Electron application itself.

Desktop builds and releases run this on macOS, Windows, and Linux. Linux uses Xvfb. An app that cannot launch or capture a screenshot fails that platform's gate; a source test result is insufficient. Inspect the retained `v007-ui-evidence-*` or `ui-evidence-*` workflow artifacts before accepting a release. These CI runs do not establish how the GUI behaves on a user's Mac.

On the current hosted Ubuntu runner, the pinned v0.0.7 package aborts before opening because Electron requires its SUID sandbox helper to be owned by root with mode 4755. The gate records that startup failure and remains red until a runner can launch the package under the project's security constraints.

On the current hosted Windows runner, the pinned v0.0.7 package opens, but its first library creation fails with `EPERM: operation not permitted, fsync` on the temporary `Library.json` file. The gate records the failure and remains red; this workflow does not alter the v0.0.7 application to mask it.
