# Motion Effect Engine: Design

Date: 2026-09-25
Status: approved (brainstorming session), implemented (v0.1.0)

## Goal

A keyframeable 2D transform effect that behaves like Premiere Pro's built-in
**Motion** effect (plus Opacity), built as a host-independent C++ engine with
thin host adapters. OpenFX is the first adapter. The engine is designed so an
Adobe (AE/Premiere SDK) adapter or our own editor can be added later as
siblings, without changing the core.

Guiding principle: **the UI and the backend never disagree.** Every parameter,
unit, coordinate convention and interpolation rule has exactly one definition,
and every layer derives from it.

## Scope

In scope (v1):

- `core/anim`: keyframes, temporal interpolation, spatial (path) interpolation.
- `core/motion`: parameter schema (single source of truth), Premiere transform
  math, geometry helpers (RoD/RoI).
- `render/`: backend-independent render plan; CPU reference renderer
  (multi-threaded); Metal backend; Vulkan backend.
- `ofx/`: OpenFX 1.5.1 plugin adapter (Support library), CPU and host-Metal
  render paths, bundle packaging.
- Tests: unit tests, GPU-vs-CPU parity tests, Natron end-to-end tests.

Out of scope for v1 (the design leaves room for them):

- CUDA backend: cannot be compiled or verified without an NVIDIA GPU and
  toolkit. It slots in next to Metal behind the same render plan.
- OpenCL backend: added only if an OpenCL-only host needs it.
- On-screen overlay handles (OFX interact).
- OFX transform concatenation (`getTransform`).
- Adobe adapter, standalone editor, timeline, media I/O, serialization.

## Architecture

```
core/anim     rational time, keyframes, temporal + spatial interpolation
core/motion   MotionSchema (param table), MotionParams, transform math, geometry
render/       RenderPlan (POD shared by all backends), CPU renderer,
              metal/ (MSL compute), vulkan/ (GLSL -> SPIR-V compute)
ofx/          OFX plugin: describes params from MotionSchema, reads values at
              time t, converts coordinates in one place, picks a backend
tests/        GoogleTest unit + parity tests, Natron integration script
```

Dependency rule: `core` depends on nothing; `render` depends on `core`;
adapters depend on both. Renderers never see keyframes, only evaluated matrices.

## Single sources of truth

| Concern | Owner |
|---|---|
| Parameter IDs, labels, types, units, defaults, ranges | `core/motion/MotionSchema.h` |
| Transform order and math | `core/motion/Transform.h` |
| Interpolation | `core/anim` (in OFX hosts the host interpolates; we only read) |
| Sampling algorithm and its constants | `render/RenderPlan.h` + one kernel spec below |
| Coordinate conversion host to core | one function per adapter (`ofx/OfxCoords.h`) |

## Parameters

| ID | Label | Type | Unit | Default | Range |
|---|---|---|---|---|---|
| `position` | Position | 2D | sequence pixels | frame center | unbounded |
| `scale` | Scale | double | percent | 100 | 0 .. 10000 (display 0..600) |
| `rotation` | Rotation | double | degrees, clockwise on screen | 0 | unbounded |
| `anchorPoint` | Anchor Point | 2D | clip pixels | clip center | unbounded |
| `antiFlicker` | Anti-flicker Filter | double | 0..1 | 0 | 0 .. 1 |
| `opacity` | Opacity | double | percent | 100 | 0 .. 100 |
| `quality` | Quality | choice | Draft / High | High | |
| `motionBlur` | Motion Blur | bool | | off | |
| `shutterAngle` | Shutter Angle | double | degrees | 180 | 0 .. 720 |
| `shutterPhase` | Shutter Phase | double | degrees | -90 | -360 .. 360 |
| `motionBlurSamples` | Samples | int | count | 8 | 1 .. 64 |

IDs are permanent. New parameters get new IDs; old IDs are never reused.

## Transform math

Core coordinate space ("Premiere space"): pixel units, origin at the top-left
of the frame, y down. Rotation is clockwise on screen. Pixel aspect ratio (PAR)
is honoured by doing the rotation and scale in square (display) units.

Mapping from clip pixels to sequence pixels:

```
M = Sx(1/seqPAR) * T(pos.x*seqPAR, pos.y) * R(theta) * S(scale/100)
    * T(-anchor.x*clipPAR, -anchor.y) * Sx(clipPAR)
R(theta) = [cos -sin; sin cos]   (y-down => positive theta is clockwise)
```

The renderer receives the inverse (destination pixel to source pixel).

## Keyframe model (core/anim)

- `Time`: exact rational seconds (int64 num/den, normalized). Evaluation takes
  a `double` so motion blur can sample between frames.
- Keyframe: time, value, in/out temporal interpolation, in/out ease
  `{speed (units/s), influence (0.001..1)}`, and for 2D values optional
  spatial in/out tangents.
- Temporal types: `Linear`, `Bezier`, `AutoBezier`, `ContinuousBezier`,
  `Hold`. `EaseIn` / `EaseOut` are presets (Bezier, speed 0, influence 1/3 on
  that side).
- Segment rule (k0 -> k1): if k0.out or k1.in is Hold, the value holds at
  k0 until k1 (After Effects semantics for incoming Hold). If k0.out and
  k1.in are both Linear, linear. Otherwise a cubic Bezier in (time, value):
  `P0=(t0,v0)`, `P1=(t0+i0*dt, v0+s0*i0*dt)`, `P2=(t1-i1*dt, v1-s1*i1*dt)`,
  `P3=(t1,v1)`. A Linear side uses the segment slope with influence 1/3.
  AutoBezier speed = `(v[k+1]-v[k-1])/(t[k+1]-t[k-1])` (one-sided at the
  ends), influence 1/3. ContinuousBezier: in speed = out speed (user value).
  Time is solved for the curve parameter with Newton iterations plus
  bisection fallback. Influences are clamped to [0, 1], which keeps P1.x and
  P2.x inside the segment, so x(u) is monotonic.
- Before the first key or after the last: constant. No keys: the schema
  default.
- 2D spatial (Position, Anchor): the path between keys is a cubic Bezier with
  tangents (`Linear` = zero tangents, `AutoBezier` = Catmull-Rom style
  `(p[k+1]-p[k-1])/6`). Temporal interpolation drives *distance along the
  path* (arc length), so easing changes speed, not path shape.

## Render plan and sampling (identical in every backend)

`RenderPlan` is a plain struct uploaded unchanged to GPU backends
(std430/Metal-compatible layout). It holds up to 64 destination-to-source
affine matrices (one per motion-blur sample), opacity, anti-flicker,
filter, supersample count, source/destination bounds and premultiplied state.

For destination pixel (x, y) with continuous center `p = (x+0.5, y+0.5)`:

```
acc = 0
for m in matrices:                  (motion-blur samples, equal weight)
  for dy, w in AF taps:             ({0:1} or {-1:f/4, 0:1-f/2, +1:f/4})
    for i, j in n x n supersamples: (offset ((i+0.5)/n - 0.5, (j+0.5)/n - 0.5))
      acc += w * sample(src, m * (p + (ox, dy + oy)))
out = acc / (count(matrices) * n*n) * opacity
```

- `sample` = bilinear (Draft) or Catmull-Rom bicubic (High), texel centers at
  +0.5, texels outside the source bounds are transparent zero. Sample points
  more than 3 pixels outside the source return zero without fetching.
- Supersample count `n` (High only) is derived from the affine Jacobian
  (constant per matrix): `n = clamp(ceil(max singular value of dst->src
  linear part), 1, 8)`. Computed once on the CPU, used by every backend.
- Unpremultiplied sources are premultiplied at fetch and unpremultiplied at
  the end (output keeps the input's premultiplication state).
- Alpha is clamped to [0, 1]. Integer formats round and clamp on store.
- A singular matrix (scale 0) renders transparent.
- GPU backends accept float RGBA. The CPU backend accepts 8-bit, 16-bit and
  float, with 1, 3 or 4 channels.

Parity requirement: Metal and Vulkan output must match CPU output within
`1e-4` absolute per channel (float RGBA) on randomized parameter tests.
Unpremultiplied outputs are compared after re-premultiplying (dividing by a
tiny alpha amplifies rounding). Metal compiles the embedded MSL at runtime
with safe (non-fast) math; Vulkan uses SPIR-V compiled at build time.

## OpenFX adapter

- OpenFX 1.5.1 Support library, fetched by CMake (overridable for offline
  builds). Contexts: Filter, General. Tiles, multi-resolution, fully
  thread-safe, no host frame threading, no temporal clip access.
- Parameters are declared by iterating `MotionSchema`. 2D params are
  `XYAbsolute`, `kOfxParamCoordinatesNormalised` default (0.5, 0.5).
- OFX coordinates are canonical (y up). `ofx/OfxCoords` is the single place
  that converts: destination pixel -> canonical -> core sequence space ->
  inverse motion -> core clip space -> canonical -> source pixel. In OFX,
  clip space = sequence space = the project frame (the host has already
  placed the source), so the default transform is the identity.
- Position and Anchor Point are shown in the host's canonical coordinates
  (y up), as OFX hosts expect for `XYAbsolute` parameters (this keeps host
  features such as proxy scaling and on-screen point handles correct). The
  core still works in Premiere space; only the adapter converts.
- OFX time is in frames, so motion-blur sample times are in frames.
- The host's draft-render request forces Draft quality.
- Keyframes are owned and interpolated by the host. Motion-blur samples are
  read with `getValueAtTime` at `t + phase/360 + (k+0.5)/N * angle/360`.
- `isIdentity` when the combined matrix is the identity (within 1e-9),
  opacity is 100%, and anti-flicker and motion blur are inactive.
- RoD = union of the transformed source RoD (grown by the filter radius)
  across motion samples, plus one pixel vertically when anti-flicker is on.
  RoI = `render::sourceFootprint` of the render window (same code the
  renderers' sampling is derived from).
- Output premultiplication follows the source; opaque RGBA becomes
  premultiplied because transforming reveals transparent areas.
- Metal: declared when built on macOS. Host Metal buffers go through the same
  encode path as the tested standalone Metal backend.

## Testing

- Unit: time, interpolation (analytic values), spatial arc length, schema
  consistency, transform math, geometry, CPU renderer invariants (tiling
  equals full render, threaded equals single-threaded, formats, negative
  row bytes, premultiplication).
- Parity: Metal vs CPU, Vulkan (MoltenVK) vs CPU; skipped when no device.
- End-to-end: NatronRenderer loads the bundle via `OFX_PLUGIN_PATH`, renders
  static, keyframed (linear keys), motion-blurred, anti-flicker, Draft and
  High cases to uncompressed float EXR. Two checks are engine-independent
  (identity is bit-exact; a +100/+100 shift moves pixels exactly). The rest
  are compared against the engine, fed with keyframe values and shutter
  times computed independently in Python. A canary constant written without
  the plugin detects channels the host writes incorrectly (Natron 2.6 on
  macOS 27 corrupts G, B and A on write); only reliable channels are
  compared, with a warning.
- Sanitizers: the unit and GPU suites run clean under ASan + UBSan
  (`asan` preset).
