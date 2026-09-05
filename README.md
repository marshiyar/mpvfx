# MpVFX

MpVFX is a desktop nonlinear video editor for macOS, Windows, and Linux.

It supports video, image, and audio imports; multitrack editing; trimming and splitting; effects;
color adjustments; captions; live preview; and export.

## Development

MpVFX uses Node.js 22.23.2 and npm.

```bash
cd studio
npm ci
npm run desktop:dev
```

Run the checks with:

```bash
cd studio
npm test
npm run typecheck
npm run build
```

Build an installer for the current platform with:

```bash
cd studio
npm run desktop:make
```

## Releases

The **Build GitHub Release** workflow builds macOS, Windows, and Linux installers, adds checksums,
and attaches them to the version in GitHub Releases. Run it manually from Actions or push a tag
that matches `studio/package.json`, such as `v0.8.21`.

The current installers are unsigned. Operating systems may display an unverified-developer warning.

## License

MpVFX source is licensed under [Apache-2.0](LICENSE). Third-party components retain their own
licenses; required attribution is in [NOTICE](NOTICE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
