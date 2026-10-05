# Video Keyframing: Motion effect

This MpVFX-owned engine source is licensed under Apache License 2.0; see [LICENSE](LICENSE).

A keyframeable 2D transform that behaves like Premiere Pro's **Motion** effect
(Position, Scale, Rotation, Anchor Point, Anti-flicker Filter) plus Opacity and
motion blur. It's built as a host-independent C++20 engine with thin host
adapters. The first adapter is an **OpenFX 1.5.1** plugin, which runs in
DaVinci Resolve, Nuke, Natron, Fusion, Vegas and other OFX hosts.

Design record: [`docs/superpowers/specs/2026-09-25-motion-effect-design.md`](docs/superpowers/specs/2026-09-25-motion-effect-design.md)

## Architecture

```
core/     no dependencies
  anim/     exact rational time, keyframes, temporal interpolation
            (Linear, Bezier, Auto/Continuous Bezier, Hold, Ease In/Out),
            spatial paths with arc-length (constant speed) motion
  motion/   MotionSchema: the single source of truth for every parameter
            (key, unit, default, range); Premiere transform math
render/   RenderPlan: one struct holding every sampling decision, shared
          byte-for-byte by all backends
            CPU (multi-threaded reference) | Metal | Vulkan
ofx/      OpenFX adapter: parameters generated from MotionSchema, the host
          owns keyframes, OfxCoords is the only coordinate conversion
tests/    unit, GPU parity, sanitizer and Natron end-to-end tests
tools/    vkf_bench (UHD benchmark per backend)
```

Rules that keep the UI and the renderer in agreement:

- Parameters are defined once (`core/include/vkf/motion/MotionSchema.h`). The
  plugin's parameter UI, defaults, ranges and value reading are all generated
  from that table, and a compile-time check rejects an inconsistent table.
- There is one coordinate conversion (`ofx/src/OfxCoords.cpp`) between host
  space and core space, and it's unit-tested.
- There is one sampling algorithm. `render/src/CpuRenderer.cpp` is the
  reference, and the Metal and Vulkan kernels mirror it. Parity tests require
  every backend to match within 1e-4.

## Build

Requirements: CMake 3.25 or newer, a C++20 compiler, Ninja. Optional: the Vulkan
SDK and `glslc` (Vulkan backend), and Natron (end-to-end test). OpenFX and
GoogleTest are downloaded as pinned, SHA-256-verified release tarballs.

```sh
cmake --preset release-macos      # or: release (Linux/Windows)
cmake --build --preset release-macos
ctest --preset release-macos
```

Presets: `dev` (Debug), `release`, `asan` (AddressSanitizer + UBSan), each
with a `-macos` variant that finds Homebrew's Vulkan. For offline builds, pass
`-DFETCHCONTENT_SOURCE_DIR_OPENFX=...` and `-DFETCHCONTENT_SOURCE_DIR_GOOGLETEST=...`.

The plugin bundle is written to `build/<preset>/ofx/VKFMotion.ofx.bundle`. On
macOS it's a universal binary (arm64 + x86_64) with an ad-hoc signature. Set
`-DVKF_CODESIGN_IDENTITY="Developer ID Application: ..."` for distribution.

## Install

```sh
cmake --install build/release-macos    # macOS: /Library/OFX/Plugins (may need sudo)
```

Or point a host at the build folder with `OFX_PLUGIN_PATH=<build>/ofx`. The
effect appears as **Transform > Motion**. Set keyframes with the host's own
keyframe tools. Position and Anchor Point use the host's canonical coordinates
(y up), as OFX hosts expect.

Before shipping, change `VKF_OFX_PLUGIN_ID` (default
`org.videokeyframing.Motion`) to your own reverse-DNS identifier. Hosts store
this ID in saved projects, so it must never change after release.

## Performance (M4 Max, UHD float RGBA, ms)

| Scenario | CPU | Metal | Vulkan (MoltenVK) |
|---|---|---|---|
| Draft, rotate + scale | 9.1 | 5.8 | 5.7 |
| High (bicubic) | 46.4 | 7.1 | 6.8 |
| High, shrink to 40% (supersampled) | 45.3 | 6.8 | 6.5 |
| High, motion blur 8 samples | 369.5 | 22.6 | 20.7 |

GPU figures include copying the frame to and from the GPU (the standalone
engine path). Inside an OFX host that renders on the GPU there is no copy.
Reproduce with `build/<preset>/vkf_bench`.

## Verification status

| Area | Status |
|---|---|
| Core animation and transform math | Unit tested (exact and analytic checks) |
| CPU renderer | Unit tested: formats, tiling, threading, negative row bytes, premultiplication |
| Metal, Vulkan | Parity with CPU on 40 randomized cases each, plus the host-queue Metal path |
| Memory / UB | Unit and GPU suites clean under ASan + UBSan |
| OFX plugin in Natron 2.6 | End-to-end: loads, parameters, host keyframes, motion blur, anti-flicker, Draft/High. Bit-exact against the engine |
| OFX Metal path in DaVinci Resolve | **Not yet run in Resolve** (Resolve isn't installed on the build machine). The kernel and host-queue encoding are tested; only Resolve's handoff is unverified |

Known limitations and next steps:

- **CUDA backend:** not built (needs an NVIDIA GPU and the CUDA toolkit). It
  slots in beside Metal using the same `RenderPlan`.
- **On-screen handles** (OFX overlay interact) for dragging Position, Anchor and
  Rotation in the viewer are not implemented yet.
- **Natron 2.6 on macOS 27** corrupts the G, B and A channels when *writing*
  images, even with no third-party plugin involved. The end-to-end test detects
  this with a canary image and compares only the channels the host writes
  correctly (R on this machine). On a healthy host it compares all four.
- In OFX hosts the host interpolates keyframes, so its curve editor defines
  easing there. The Premiere-style interpolation in `core/anim` is used when
  our own engine owns the timeline.
