# MpVFX

MpVFX is a local desktop video editor. It combines a timeline and canvas editor with media libraries, keyframes, effects, and video export. The desktop application is built with Electron, React, TypeScript, native C++ modules, and FFmpeg.

## Using an installed app

Open MpVFX and create or open a library from the left sidebar. A library can contain events and projects; imported media can be copied into the library or linked to an original file. The editor also supports standalone projects. Application data, including standalone projects, renders, cache, and sessions, lives under Electron's platform-specific MpVFX user-data directory. A library created at a chosen location remains separate from that directory.

The application packages its media binaries and native modules. Users of an installed build do not need the development toolchain below. The **Publish…** action has additional, optional Python and account setup; see [Crosspost/README.md](Crosspost/README.md). Opening the publisher does not upload a file; real uploads have not been verified by this project.

Current macOS builds are ad hoc signed and unnotarized, so macOS may quarantine a downloaded app. For a build you trust, after moving it to Applications, remove that quarantine attribute with:

```sh
xattr -dr com.apple.quarantine /Applications/MpVFX.app
```

This does not notarize the app. Do not run the command on an app whose origin you have not verified.

## Build from source

### Prerequisites

- Node.js **24.x**, with its Node-API headers. The repository selects Node 24 through `studio/.configurations/.nvmrc`; desktop packaging rejects other major versions.
- CMake **3.25 or newer** and a C++20 toolchain. On macOS, install Xcode command line tools and a macOS SDK. Linux needs SQLite development files discoverable by CMake; Windows needs the SQLite vcpkg package and its CMake toolchain file. The native library uses system SQLite on macOS.
- The included `third_party/video-keyframing` engine source. For engine development against another checkout, optionally set `VKF_ENGINE_DIR` to its absolute path.
- Network access for the first `npm ci`: the postinstall step downloads checksum-verified redistributable FFmpeg and FFprobe binaries and applies local dependency patches.

From the repository root:

```sh
cd studio
nvm use 24                       # or select Node 24.x with your version manager
npm ci
npm run build
npm run dev
```

If your Node installation does not provide headers at its usual `include/node` location, set `NODE_API_INCLUDE_DIR` to the directory containing `node_api.h` before building. `npm run build` runs typechecking, builds the keyframe engine and native library, prepares frame runtime and publisher resources, then compiles the renderer and desktop code. `npm run dev` runs that build again before starting Electron; it is not a hot reload command.

On Windows, use a Node 24 installation and install `sqlite3:x64-windows` with vcpkg before the same npm commands:

```powershell
cd studio
$env:CMAKE_TOOLCHAIN_FILE = "$env:VCPKG_INSTALLATION_ROOT\scripts\buildsystems\vcpkg.cmake"
& "$env:VCPKG_INSTALLATION_ROOT\vcpkg.exe" install sqlite3:x64-windows
npm ci
npm run build
npm run dev
```

### Checks and packaging

Run these from `studio/`:

```sh
npm test                 # Vitest suites, including the isolated desktop runtime suite
npm run typecheck
npm run check:architecture
npm run check            # architecture, typecheck, tests, and desktop build
npm run desktop:package  # unpacked local application
npm run desktop:make     # local installer/distribution formats
```

Both packaging commands rebuild first and check the Node version and installed media binaries. Electron Forge writes local package and maker output under `studio/out/`. Platform-specific maker scripts are `desktop:make:mac:arm64`, `desktop:make:windows`, and `desktop:make:linux`; run them on a host with the required platform toolchain. `npm run release:check` runs release readiness and third-party notice checks. A local package is not a signed, notarized, or published release.

## How the repository is organized

| Path | Responsibility |
| --- | --- |
| `studio/src/` | React editor, timeline, canvas, inspector, and media UI |
| `studio/desktop/` | Electron lifecycle, local protocol, preload bridge, and OS integration |
| `studio/runtime/` | Project and library services, media import, preview, and export |
| `studio/shared/` | Contracts used across the editor, desktop, and runtime |
| `studio/native/vkf/` | Build wrapper for the separate C++ keyframe engine's Node module |
| `studio/native/library/` | C++/SQLite library catalog Node module |
| `scripts/` | Build, verification, dependency patch, and release scripts |
| `Crosspost/` | Optional Python publishing GUI and setup instructions |

Electron loads the native keyframe module before starting the editor runtime. The library module owns catalog operations; the local runtime coordinates project files, imports, and exports. The renderer communicates with desktop services through the Electron preload bridge. The editor does not open a network listener for this local runtime.

The library catalog owns library, event, asset, and export identities. Editing content still uses each project's native timeline document and compatibility resources; a catalog-only revision history and automatic retention cleanup are not implemented. See [library implementation status](studio/design/library-implementation-status.md) for delivered behavior and limits. The [library architecture document](studio/design/library-import-export-architecture.md) describes a broader target design, including work that is not yet implemented.

## License

See [LICENSE](LICENSE) and the notices in `studio/legal/` and `third_party/licenses/`.
