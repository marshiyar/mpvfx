# Releasing MpVFX

## Source publication

Before pushing source:

1. Use Node.js 22.23.2 and run `npm ci` in `studio/`.
2. Run `npm test`, `npm run typecheck`, `npm run build`, and `npm run release:check`.
3. Confirm `git status --ignored` contains no user projects, media, recovery data, secrets, or build
   output among files to be committed.
4. Review `NOTICE`, `THIRD_PARTY_NOTICES.md`, the QA attribution manifest, and dependency changes.
5. Review `PRIVACY.md` whenever a network destination or collected field changes.
6. Apply and verify the repository settings in `docs/GITHUB_SETUP.md` before accepting changes.

## What produces downloadable applications

`.github/workflows/desktop.yml` remains an unsigned validation workflow and never uploads its
output. Official downloads are created only by `.github/workflows/release.yml` after a version tag
is pushed. That workflow:

1. requires `vX.Y.Z` to match `studio/package.json`;
2. reruns publication checks, tests, typechecking, and compilation from the tagged commit;
3. waits for approval through the protected `release` GitHub environment;
4. builds on native macOS arm64, macOS x64, Windows x64, and Linux x64 runners;
5. signs and notarizes the macOS app and DMG, and Authenticode-signs the Windows app and installer;
6. re-verifies the pinned FFmpeg and FFprobe executables inside every app package;
7. attaches the exact FFmpeg corresponding-source archive; and
8. generates `SHA256SUMS` and publishes all artifacts in one GitHub Release.

Expected downloads include two macOS DMGs, a Windows Squirrel Setup executable and package files,
Linux DEB/RPM packages, `ffmpeg-corresponding-source-n8.1.2-1.tar.gz`, and `SHA256SUMS`.

## Media runtime gate

The former nonredistributable FFmpeg executable has been removed from the shipping path. Every
install now replaces both npm-downloaded media executables with SHA-256-pinned FFmpeg 8.1.2 and
FFprobe 8.1.2 programs from Shaka release `n8.1.2-1`. They use GPL/version-3 configuration and do
not use `--enable-nonfree`. Installation, pre-package, and post-package checks reject changed
hashes, wrong architectures, wrong versions, or forbidden configuration.

Exact binary hashes, configuration, source revisions, and source-archive hashes are maintained in
`docs/FFMPEG_DISTRIBUTION.md`. Public releases automatically attach all corresponding source and
build scripts. The audited macOS binaries require macOS 15.0, so the app declares macOS 15.0 as its
minimum version.

FFmpeg and FFprobe remain GPL-covered separate programs. Keep their GPL text, notices,
corresponding-source archive, and release checksums available with every installer distribution.

The background-removal model is downloaded only when a user asks for that feature; it is not
bundled into an installer. Do not bundle it or represent its redistribution/commercial rights as
settled unless the review in `docs/REMOTE_ASSETS.md` is completed.

## One-time release setup

Create the protected `release` environment and configure its reviewers and signing secrets exactly
as described in `docs/GITHUB_SETUP.md`. Code cannot create Apple Developer ID or Windows code-
signing credentials. Without those owner-supplied credentials, the workflow fails closed and no
GitHub Release is created.

Before the first public release, manually test install, launch, media import, preview, export,
uninstall, and clean-machine behavior for each target. Repeat the relevant platform checks when a
packaging, runtime, native dependency, or signing change is made.

## Publishing a release

Update the package version and changelog in a reviewed commit, then create and push the matching
tag. Use an annotated tag so the release point is explicit:

```bash
git status --short
git tag -a vX.Y.Z -m "MpVFX vX.Y.Z"
git push origin vX.Y.Z
```

Approve the `release` environment deployment only after checking the tag and commit. Do not upload
locally built artifacts to the release: the workflow's native, signed, checksummed outputs are the
release artifacts.
