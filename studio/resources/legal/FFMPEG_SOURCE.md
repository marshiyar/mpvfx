# FFmpeg and FFprobe distribution record

MpVFX installers include the FFmpeg command-line programs `ffmpeg` and `ffprobe`. This record fixes
their provenance, configuration, checksums, license, and corresponding source for public releases.
It is part of the packaged legal resources.

## Binary provenance

- Binary producer: Shaka Project `static-ffmpeg-binaries`
- Binary release: `n8.1.2-1`
- Build-script revision: `88caac417541f3bb678fa6670cb73f2d74c7aaf9`
- FFmpeg version: `8.1.2`
- Resulting binary license: GPL version 3 or later
- Upstream release: <https://github.com/shaka-project/static-ffmpeg-binaries/releases/tag/n8.1.2-1>

The shared configuration is:

```text
--pkg-config-flags=--static --disable-ffplay --enable-libvpx --enable-libsvtav1
--enable-libx264 --enable-libx265 --enable-libmp3lame --enable-libopus
--enable-mbedtls --enable-runtime-cpudetect --enable-gpl --enable-version3 --enable-static
```

The builder adds VideoToolbox and position-independent-code options on macOS, VA-API/NVENC options
on supported Linux builds, and the MinGW target option on Windows. It does **not** use
`--enable-nonfree`. MpVFX verifies both the exact file digest and the executable's reported build
configuration during dependency installation and again while packaging. A mismatched, missing, or
nonfree binary stops the build.

| Target | Program | Release asset | SHA-256 |
| --- | --- | --- | --- |
| macOS arm64 | `ffmpeg` | `ffmpeg-osx-arm64` | `e7b9fcd97f95f333512d6e8b8ac24d9dbc08f189f36047695499bd7b57214b22` |
| macOS arm64 | `ffprobe` | `ffprobe-osx-arm64` | `ded4c698b8ff38d0bc1fd30fcc5e768dc46f58bc15a8dfd61f98615ba49cde5c` |
| macOS x64 | `ffmpeg` | `ffmpeg-osx-x64` | `62c87854d851f202fc4a29bdda0fe7b6ebcddd37b863482ce1bdc81151b03fe4` |
| macOS x64 | `ffprobe` | `ffprobe-osx-x64` | `d530823f480a3c7eb6334f18a00197d1e9f1070e86172b9aa89c4bf4022bd879` |
| Linux x64 | `ffmpeg` | `ffmpeg-linux-x64` | `9eac5b2b5076db5ff853a6fa0dcd6b8de7d0cac8481eadda6c47cd935825f1ee` |
| Linux x64 | `ffprobe` | `ffprobe-linux-x64` | `065d3c56926052a76e884c4e4b51b7d95248da9391ab7effdcca6b94ceab98cf` |
| Windows x64 | `ffmpeg` | `ffmpeg-win-x64.exe` | `4044b3924c977ad31229d504c5d5b8685f9553124fbaff6e9c99048b42830341` |
| Windows x64 | `ffprobe` | `ffprobe-win-x64.exe` | `fc37ca23d31ee08bb8f7e108edf3822f6ef3efc1a8d306bbe0b779190230710b` |

These are the hashes of the audited upstream bytes. Packaging checks the executable hash,
architecture, version, and configuration before creating each installer. GitHub Releases also
include a checksum for every downloadable file.

The npm packages `ffmpeg-static` and `@ffprobe-installer/ffprobe` remain path-selection wrappers in
the JavaScript dependency graph. Their downloaded executables are replaced during `postinstall` by
the exact audited Shaka assets above; they are not the binaries shipped by MpVFX.

The audited macOS programs declare macOS 15.0 as their minimum operating-system version. The MpVFX
application bundle declares the same minimum so the installer does not claim compatibility it
cannot provide.

## Corresponding source

Every tag-created GitHub release attaches
`ffmpeg-corresponding-source-n8.1.2-1.tar.gz`. The release workflow creates it with
`scripts/collect-ffmpeg-corresponding-source.mjs`, which downloads and SHA-256-verifies the exact
source inputs below. The archive includes these source archives, the complete Shaka build scripts
and patch, both manifests, this record, a checksum file, and the GPL text.

| Component | Version or revision | Source-archive SHA-256 |
| --- | --- | --- |
| FFmpeg | `8.1.2` / `38b88335f99e76ed89ff3c93f877fdefce736c13` | `464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c` |
| libvpx | `1.16.0` / `1024874c5919305883187e2953de8fcb4c3d7fa6` | `17b46c6a0104ee39e27bb7bc41c9c1cd0f5be67f77e0225b9d7b69cfa01fd2fc` |
| SVT-AV1 | `4.1.0` / `c04f951541ad600e0d9c10836f2ab7b9bc69816d` | `53c466fe5c4dbd3fa35f40369aa3984d876d548794bf2f7de306945bdb5f51be` |
| x264 | `0480cb05fa188d37ae87e8f4fd8f1aea3711f7ee` | `d0967a1348c85dfde363bb52610403be898171493100561efa0dd05d5fd1ae50` |
| x265 | `4.2` / `e444744c03978c1fb4e037168967020cf2648427` | `0a3d41f6b4e2fe5a49d783d6631bd1a49c44cdf999074a3ff09e2cb71ac8ed33` |
| LAME | `3.100` | `ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e` |
| Opus | `1.6.1` / `22244de5a79bd1d6d623c32e72bf1954b56235be` | `3267aa969b2b26542417f57819a5bc25d5079355300307dd2dddc7c704aed418` |
| Mbed TLS | `3.4.1` / `72718dd87e087215ce9155a826ee5a66cfbe9631` | `c6eeacf906d313d5ed2844efd2f98b2298b70d04ba8cc891a24dcb1e566bd29b` |
| Shaka build scripts | `n8.1.2-1` / `88caac417541f3bb678fa6670cb73f2d74c7aaf9` | `6796e84d42ed147458351dc57364b66dc568c1d7808566536efd662ff24241f1` |

`scripts/ffmpeg-source-manifest.json` is the machine-readable authority for the source URLs,
revisions, filenames, and checksums. The Shaka builder archive contains the platform build matrix,
dependency scripts, FFmpeg configure invocation, and Linux patch used to produce both programs.

## Redistribution terms

MpVFX-owned source remains available under Apache License 2.0. The separately executed FFmpeg
programs retain their GPL terms, which govern copying and distribution of those programs. The full
GPL text is included in each app and source archive. Keep the installer, its matching corresponding-
source archive, `THIRD_PARTY_NOTICES.md`, and release checksums available together.

Codec availability and an open-source license do not by themselves resolve every patent, export,
or local-law question in every country. A distributor remains responsible for the jurisdictions
and uses it serves.
