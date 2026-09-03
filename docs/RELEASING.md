# Releasing MpVFX

## Source publication

Before pushing the source repository:

1. Run `npm ci` in `studio/` from Node.js 22.23.2.
2. Run `npm test`, `npm run typecheck`, `npm run build`, and `npm run release:check`.
3. Confirm `git status --ignored` contains no user projects, media, recovery data, secrets, or build
   output among files to be committed.
4. Review `NOTICE`, `THIRD_PARTY_NOTICES.md`, the QA attribution manifest, and dependency changes.
5. Review `PRIVACY.md` whenever a network destination or collected field changes.
6. Tag only a reviewed commit whose changelog and package version agree.
7. Apply and verify the repository settings in `docs/GITHUB_SETUP.md` before accepting changes.

## Binary release gate

The current GitHub desktop workflow validates installer creation on macOS arm64, macOS x64,
Windows x64, and Linux x64, but deliberately does not upload or publish its output.

Do not publicly distribute an installer until all of these are complete:

- Replace or independently rebuild any FFmpeg binary whose configuration contains
  `--enable-nonfree`; such a binary is not redistributable.
- Record exact FFmpeg/FFprobe source, build flags, checksums, license text, and corresponding-source
  location for every platform.
- Resolve or replace the remotely downloaded model as required by `docs/REMOTE_ASSETS.md` before
  bundling it or representing its commercial/redistribution rights as settled.
- Verify all packaged native binaries match their target architecture.
- Configure Apple Developer ID signing and notarization for macOS.
- Configure Authenticode signing for Windows.
- Review Linux package metadata and runtime-library dependencies.
- Bundle `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.md`, Electron/Chromium notices, and all required
  third-party license texts.
- Test installation, launch, import, preview, export, update/removal, and clean-machine behavior on
  every target.
- Add a separate, approval-gated release workflow that publishes checksummed artifacts and release
  notes. Do not turn the validation workflow into a publisher.

Unsigned packages may be used privately for development, but they are not official releases.
