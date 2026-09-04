# Changelog

All notable MpVFX changes will be recorded here. Versions follow semantic versioning where
practical during the pre-release period.

## [Unreleased]

- Licensed MpVFX-owned source and documentation under Apache License 2.0.
- Reserved `mpvfx` as the exact GitHub repository name without creating or pushing a remote.
- Prepared source, policy documents, attribution records, and GitHub automation for publication.
- Disabled inherited analytics configuration in default builds.
- Separated local user projects and third-party QA research data from application source.
- Kept ordinary installer jobs validation-only and added a separate approval-gated release path.
- Pinned background-removal model downloads by SHA-256 and documented remote-asset provenance.
- Embedded and package-verified the project license, notices, and required third-party legal files.
- Replaced FFmpeg and FFprobe downloads with exact redistributable Shaka GPLv3 builds, enforced
  their hashes/configuration at install and package time, and automated corresponding-source bundles.
- Added native Apple signing/notarization, Windows Authenticode signing, release checksums, and
  tag-created GitHub Release artifacts for all supported desktop targets.

## [0.8.20] - 2026-09-03

- Added the standalone MpVFX desktop application and cross-platform packaging configuration.
- Added media-first timeline editing, effects, color controls, captions, and export.
