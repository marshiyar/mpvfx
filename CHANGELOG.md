# Changelog

All notable MpVFX changes will be recorded here. Versions follow semantic versioning where
practical during the pre-release period.

## [Unreleased]

## [0.0.3] - 2026-09-21

- Preserved complete native animation curves and audio envelopes across split and trim,
  including keys outside the visible clip range and their interpolation.
- Added independent clip copy, cut, paste and duplicate commands, native-keyframe clipboard
  commands, timeline Select All/Delete All behavior, and atomic persistence and undo.
- Fixed Windows keyframe saves and Linux PNG-sequence MOV exports.
- Reduced idle thumbnail memory pressure and retained the local diagnostics, crash recovery,
  redacted reports and packaging privacy checks introduced in v0.0.2.
- Integrated Vite 8 with the compatible React plugin, upgraded Electron to 44.4.2, and
  added development/production playback checks for dependency updates.
- Kept deliberately removed repository documents and optional fixtures out of release gates;
  packaged attribution and privacy resources remain checked.

## [0.0.2] - 2026-09-20

- Added local diagnostic timelines for editor actions, errors, exports, helper processes,
  GPU state, memory, CPU use, and stalls on macOS, Windows, and Linux.
- Added local native crash recording, recovery evidence after interrupted sessions, and a
  **Diagnostics → Save report** control. Reports omit native memory dumps and redact private data.
- Prevented Windows console windows from Chromium, FFmpeg, FFprobe, GPU detection, and
  render-quality helpers during export.
- Added native export, crash, restart, and report checks for every released platform.
- Kept crash recovery responsive on macOS, corrected durable log flushing on Windows,
  and repaired Linux's lossless PNG-to-ProRes streaming input.
- Restricted installer contents to runtime files and added credential and private-file
  checks before repository publication and installer release.

- Removed the external-agent WebMCP tools and selection-context publishing. Retained local
  selection refresh, video editing, playback, and interface animations.

## [0.0.1] - 2026-09-04

- Added macOS, Windows, and Linux builds to the GitHub Release workflow.
- Added release checksums and the FFmpeg corresponding-source archive.
- Pinned corresponding-source inputs to stable archives for repeatable release builds.
- Kept local projects, recovery data, and personal media outside the repository.
- Added Apache-2.0 licensing and required third-party attribution.

- Added the standalone MpVFX desktop application and cross-platform packaging configuration.
- Added media-first timeline editing, effects, color controls, captions, and export.
