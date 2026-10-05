#!/usr/bin/env python3
"""End-to-end test of the OFX plugin inside Natron.

1. Builds a Natron scene: a CheckerBoard source feeding several Motion nodes
   with static values, linear keyframes, motion blur, anti-flicker, Draft and
   High quality. Natron renders each through the plugin to float EXR.
2. Natron writes uncompressed 32-bit float EXR, which this script parses
   directly (no conversion tools involved).
3. Exact checks that do not use our engine at all: default parameters
   reproduce the source bit for bit, and a +100/+100 Position shift moves
   every pixel exactly 100 right and 100 up.
4. Engine checks: for keyframed/blurred cases, this script interpolates the
   keyframes itself (linear) at every shutter sample time and hands the values
   to vkf_natron_reference, which renders with the engine and compares.
"""
import argparse
import array
import os
import struct
import shutil
import subprocess
import sys

W, H = 1920, 1080  # Natron's default project format
CENTER = (W / 2.0, H / 2.0)

# Each case: static values, linear keyframes {param: [(frame, value)]}, frames to check.
CASES = [
    {"name": "identity", "static": {}, "keys": {}, "frames": [1]},
    {"name": "shift", "static": {"position": (CENTER[0] + 100, CENTER[1] + 100)}, "keys": {}, "frames": [1]},
    {"name": "anchor_scale_rotate_hq",
     "static": {"anchorPoint": (500.0, 300.0), "scale": 37.5, "rotation": -20.0, "position": (1200.0, 700.0)},
     "keys": {}, "frames": [1]},
    {"name": "keyframed",
     "static": {},
     "keys": {"position": [(1, CENTER), (5, (1160.0, 440.0))], "scale": [(1, 100.0), (5, 50.0)],
              "rotation": [(1, 0.0), (5, 45.0)], "opacity": [(1, 100.0), (5, 60.0)]},
     "frames": [1, 2, 3, 4, 5]},
    {"name": "blur_antiflicker_draft",
     "static": {"motionBlur": True, "motionBlurSamples": 6, "antiFlicker": 0.4, "quality": 0},
     "keys": {"rotation": [(1, 0.0), (5, 30.0)], "position": [(1, (900.0, 540.0)), (5, (1100.0, 540.0))]},
     "frames": [3]},
]

CANARY = (0.2, 0.4, 0.6, 0.8)

DEFAULTS = {"position": CENTER, "anchorPoint": CENTER, "scale": 100.0, "rotation": 0.0, "opacity": 100.0,
            "antiFlicker": 0.0, "quality": 1, "motionBlur": False, "shutterAngle": 180.0, "shutterPhase": -90.0,
            "motionBlurSamples": 8}


def natron_scene(plugin_id, work):
    lines = [
        "import os, NatronEngine",
        "app = app1",
        "Linear = NatronEngine.Natron.KeyframeTypeEnum.eKeyframeTypeLinear",
        "src = app.createNode('net.sf.openfx.CheckerBoardPlugin')",
        "ws = app.createNode('fr.inria.openfx.WriteEXR')",
        "ws.connectInput(0, src)",
        f"ws.getParam('filename').setValue({os.path.join(work, 'src_###.exr')!r})",
        "def lossless(w):",
        "    w.getParam('compression').setValue(0)  # 'no'",
        "    w.getParam('dataType').setValue(1)     # '32f'",
        "lossless(ws)",
        # Canary: a known constant written without our plugin, to detect which
        # channels this Natron build writes correctly.
        "c = app.createNode('net.sf.openfx.ConstantPlugin')",
        "for i, v in enumerate(" + repr(CANARY) + "): c.getParam('color').setValue(v, i)",
        "wc = app.createNode('fr.inria.openfx.WriteEXR')",
        "wc.connectInput(0, c)",
        "lossless(wc)",
        f"wc.getParam('filename').setValue({os.path.join(work, 'canary_###.exr')!r})",
        "app.render(wc, 1, 1)",
        "app.render(ws, 1, 1)",
    ]
    for case in CASES:
        n = case["name"]
        lines += [f"m = app.createNode({plugin_id!r})", "m.connectInput(0, src)"]
        for k, v in case["static"].items():
            if isinstance(v, tuple):
                lines += [f"m.getParam({k!r}).setValue({v[0]!r}, 0)", f"m.getParam({k!r}).setValue({v[1]!r}, 1)"]
            else:
                lines += [f"m.getParam({k!r}).setValue({v!r})"]
        for k, keys in case["keys"].items():
            for frame, v in keys:
                dims = list(enumerate(v)) if isinstance(v, tuple) else [(0, v)]
                for d, dv in dims:
                    lines += [f"m.getParam({k!r}).setValueAtTime({float(dv)!r}, {frame}, {d})",
                              f"m.getParam({k!r}).setInterpolationAtTime({frame}, Linear, {d})"]
        lines += ["w = app.createNode('fr.inria.openfx.WriteEXR')", "w.connectInput(0, m)", "lossless(w)",
                  f"w.getParam('filename').setValue({os.path.join(work, n + '_###.exr')!r})",
                  f"app.render(w, {min(case['frames'])}, {max(case['frames'])})"]
    # Natron 2.6 can crash during teardown on recent macOS; every output is
    # verified from the files, so leave without running the teardown.
    lines += ["print('VKF_SCENE_DONE', flush=True)", "os._exit(0)"]
    return "\n".join(lines) + "\n"


def value_at(case, name, t):
    keys = case["keys"].get(name)
    if not keys:
        return case["static"].get(name, DEFAULTS[name])
    if t <= keys[0][0]:
        return keys[0][1]
    if t >= keys[-1][0]:
        return keys[-1][1]
    for (f0, v0), (f1, v1) in zip(keys, keys[1:]):
        if f0 <= t <= f1:
            u = (t - f0) / (f1 - f0)
            if isinstance(v0, tuple):
                return tuple(a + (b - a) * u for a, b in zip(v0, v1))
            return v0 + (v1 - v0) * u
    raise AssertionError("unreachable")


def sample_times(case, t):
    """Shutter sample times, computed independently of the C++ engine."""
    if not value_at(case, "motionBlur", t):
        return [t]
    n = value_at(case, "motionBlurSamples", t)
    angle = value_at(case, "shutterAngle", t)
    phase = value_at(case, "shutterPhase", t)
    return [t + phase / 360.0 + angle / 360.0 * (k + 0.5) / n for k in range(n)]


def read_exr_uncompressed(path):
    """Strict reader for single-part, uncompressed, 32-bit float scanline
    OpenEXR (what the scene asks Natron to write). Returns (w, h, RGBA floats)
    with rows bottom-first (OFX pixel order). A missing A channel reads as 1."""
    with open(path, "rb") as f:
        d = f.read()
    assert d[:4] == b"\x76\x2f\x31\x01", f"{path}: not OpenEXR"
    (flags,) = struct.unpack_from("<I", d, 4)
    assert flags & 0xFF == 2 and not flags & 0x1E00, f"{path}: expected single-part scanline EXR"
    pos, attrs = 8, {}
    while d[pos] != 0:
        end = d.index(b"\0", pos)
        name = d[pos:end].decode()
        end2 = d.index(b"\0", end + 1)
        (size,) = struct.unpack_from("<i", d, end2 + 1)
        attrs[name] = d[end2 + 5:end2 + 5 + size]
        pos = end2 + 5 + size
    pos += 1
    assert attrs["compression"][0] == 0, f"{path}: expected uncompressed EXR"
    chl, names, p = attrs["channels"], [], 0
    while chl[p] != 0:
        end = chl.index(b"\0", p)
        (ptype,) = struct.unpack_from("<i", chl, end + 1)
        assert ptype == 2, f"{path}: expected 32-bit float channels"
        names.append(chl[p:end].decode())
        p = end + 17
    x1, y1, x2, y2 = struct.unpack("<4i", attrs["dataWindow"])
    w, h = x2 - x1 + 1, y2 - y1 + 1
    offsets = struct.unpack_from(f"<{h}Q", d, pos)
    out = array.array("f", bytes(w * h * 16))
    order = {"R": 0, "G": 1, "B": 2, "A": 3}
    if "A" not in names:
        out[3::4] = array.array("f", [1.0]) * (w * h)
    for off in offsets:
        y, size = struct.unpack_from("<ii", d, off)
        assert size == w * 4 * len(names), f"{path}: unexpected scanline size"
        plane = array.array("f")
        plane.frombytes(d[off + 8:off + 8 + size])
        row = y2 - y  # EXR y grows downward
        for ci, n in enumerate(names):
            if n in order:
                out[row * w * 4 + order[n]:(row + 1) * w * 4:4] = plane[ci * w:(ci + 1) * w]
    return w, h, out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--natron", required=True)
    ap.add_argument("--bundle-parent", required=True)
    ap.add_argument("--plugin-id", required=True)
    ap.add_argument("--reference", required=True)
    ap.add_argument("--work", required=True)
    args = ap.parse_args()

    shutil.rmtree(args.work, ignore_errors=True)
    os.makedirs(args.work)
    scene = os.path.join(args.work, "scene.py")
    with open(scene, "w") as f:
        f.write(natron_scene(args.plugin_id, args.work))

    env = dict(os.environ, OFX_PLUGIN_PATH=args.bundle_parent)
    run = subprocess.run([args.natron, "--no-settings", "--clear-openfx-cache", "-t", scene],
                         env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=240)
    if "VKF_SCENE_DONE" not in run.stdout:
        print(run.stdout[-4000:], run.stderr[-4000:], sep="\n")
        print("FAIL: Natron did not finish the scene")
        return 1

    images = {}
    def load(stem):
        """Natron's EXR -> raw RGBA file for the reference tool."""
        if stem not in images:
            width, height, pixels = read_exr_uncompressed(os.path.join(args.work, stem + ".exr"))
            assert (width, height) == (W, H), f"{stem}: unexpected size {width}x{height}"
            raw = os.path.join(args.work, stem + ".rgba")
            with open(raw, "wb") as f:
                f.write(f"VKFRGBA {width} {height}\n".encode())
                f.write(pixels.tobytes())
            images[stem] = (raw, pixels)
        return images[stem]

    failures = 0
    _, canary = load("canary_001")
    channels = [c for c in range(4) if all(v == array.array("f", [CANARY[c]])[0] for v in canary[c::4])]
    if not channels:
        print("FAIL: this Natron build writes no channel correctly (canary check)")
        return 1
    if len(channels) < 4:
        print("WARNING: this Natron build corrupts channels", [("RGBA"[c]) for c in range(4) if c not in channels],
              "when writing images (a constant written without our plugin comes back wrong);",
              "comparing only", "".join("RGBA"[c] for c in channels))
    mask = "".join("1" if c in channels else "0" for c in range(4))
    pick = lambda img: [img[i] for i in range(len(img)) if i % 4 in channels]

    src_raw, src = load("src_001")
    idx = lambda x, y: (y * W + x) * 4  # rows bottom-up, like OFX pixels
    assert all(0.0 <= src[i] <= 1.0 for i in range(len(src)) if i % 4 in channels), "source must be sane"

    # Exact checks, independent of the engine.
    _, ident = load("identity_001")
    ok = pick(ident) == pick(src)
    failures += not ok
    print(f"{'identity (exact)':28s} {'ok' if ok else 'FAIL'}")

    _, shifted = load("shift_001")
    ok = True
    for y in range(0, H - 100):
        a, b = idx(100, y + 100), idx(0, y)
        row_a, row_b = shifted[a:a + (W - 100) * 4], src[b:b + (W - 100) * 4]
        if any(row_a[i] != row_b[i] for i in range(len(row_a)) if i % 4 in channels):
            ok = False
            break
    revealed = shifted[idx(0, 500):idx(100, 500)]  # uncovered area must be empty
    ok = ok and all(revealed[i] == 0.0 for i in range(len(revealed)) if i % 4 in channels)
    failures += not ok
    print(f"{'shift +100/+100 (exact)':28s} {'ok' if ok else 'FAIL'}")

    # Engine checks.
    jobs = os.path.join(args.work, "jobs.txt")
    with open(jobs, "w") as f:
        for case in CASES:
            if case["name"] in ("identity", "shift"):
                continue
            for frame in case["frames"]:
                stem = f"{case['name']}_{frame:03d}"
                times = sample_times(case, frame)
                f.write(f"job {stem} {src_raw} {load(stem)[0]} {W} {H} {value_at(case, 'quality', frame)} "
                        f"{value_at(case, 'antiFlicker', frame)} {value_at(case, 'opacity', frame)} {len(times)}\n")
                for t in times:
                    px, py = value_at(case, "position", t)
                    ax, ay = value_at(case, "anchorPoint", t)
                    f.write(f"s {px!r} {py!r} {value_at(case, 'scale', t)!r} {value_at(case, 'rotation', t)!r} "
                            f"{ax!r} {ay!r}\n")
    ref = subprocess.run([args.reference, jobs, "2e-4", mask], capture_output=True, text=True)
    print(ref.stdout, end="")
    print(ref.stderr, end="", file=sys.stderr)
    failures += ref.returncode != 0

    print("PASS" if failures == 0 else f"FAIL ({failures})")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
