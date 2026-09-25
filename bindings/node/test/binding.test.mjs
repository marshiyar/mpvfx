// Contract tests for the Node-API module. Run: VKF_NODE_MODULE=<path> node --test
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const engine = createRequire(import.meta.url)(process.env.VKF_NODE_MODULE);

const linear = { type: "linear" };
const hold = { type: "hold" };
const ease = { type: "cubic-bezier", controlPoints: { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 } };

test("exposes a versioned API", () => {
  assert.equal(engine.apiVersion, 1);
  assert.match(engine.version, /^\d+\.\d+\.\d+$/);
});

test("evaluates number tracks", () => {
  const t = engine.compileTrack({
    valueType: "number",
    keyframes: [{ frame: 10, value: 1, outgoing: linear }, { frame: 20, value: 5, outgoing: hold }],
  });
  assert.equal(engine.evaluateTrack(t, 0), 1);
  assert.equal(engine.evaluateTrack(t, 15), 3);
  assert.equal(engine.evaluateTrack(t, 25), 5);
});

test("evaluates cubic timing like CSS ease", () => {
  const t = engine.compileTrack({
    valueType: "number",
    keyframes: [{ frame: 0, value: 0, outgoing: ease }, { frame: 100, value: 1, outgoing: linear }],
  });
  assert.ok(Math.abs(engine.evaluateTrack(t, 50) - 0.802403387584857) < 1e-12);
});

test("returns structured vec2 and rgba values", () => {
  const v = engine.compileTrack({
    valueType: "vec2",
    keyframes: [{ frame: 0, value: { x: 0, y: 10 }, outgoing: linear }, { frame: 4, value: { x: 8, y: 30 }, outgoing: linear }],
  });
  assert.deepEqual(engine.evaluateTrack(v, 2), { x: 4, y: 20 });
  const c = engine.compileTrack({
    valueType: "rgba",
    keyframes: [{ frame: 0, value: { red: 0, green: 0, blue: 0, alpha: 1 }, outgoing: linear },
      { frame: 2, value: { red: 1, green: 0.5, blue: 0, alpha: 1 }, outgoing: linear }],
  });
  assert.deepEqual(engine.evaluateTrack(c, 1), { red: 0.5, green: 0.25, blue: 0, alpha: 1 });
});

test("samples consecutive frames into a Float64Array", () => {
  const v = engine.compileTrack({
    valueType: "vec2",
    keyframes: [{ frame: 0, value: { x: 0, y: 0 }, outgoing: linear }, { frame: 2, value: { x: 2, y: 4 }, outgoing: linear }],
  });
  const s = engine.sampleTrack(v, 0, 4);
  assert.ok(s instanceof Float64Array);
  assert.deepEqual([...s], [0, 0, 1, 2, 2, 4, 2, 4]);
});

test("rejects invalid tracks with stable codes", () => {
  const code = (track) => {
    try {
      engine.compileTrack(track);
    } catch (error) {
      return error.code;
    }
    return "none";
  };
  assert.equal(code({ valueType: "number", keyframes: [] }), "empty-track");
  assert.equal(code({ valueType: "number", keyframes: [{ frame: 1.5, value: 0, outgoing: linear }] }), "invalid-keyframe-frame");
  assert.equal(code({ valueType: "number", keyframes: [{ frame: -1, value: 0, outgoing: linear }] }), "invalid-keyframe-frame");
  assert.equal(code({ valueType: "number", keyframes: [{ frame: 1, value: 0, outgoing: linear }, { frame: 1, value: 1, outgoing: linear }] }), "duplicate-keyframe-frame");
  assert.equal(code({ valueType: "number", keyframes: [{ frame: 1, value: "x", outgoing: linear }] }), "invalid-value");
  assert.equal(code({ valueType: "rgba", keyframes: [{ frame: 0, value: { red: 2, green: 0, blue: 0, alpha: 1 }, outgoing: linear }] }), "invalid-value");
  assert.equal(code({ valueType: "number", keyframes: [{ frame: 0, value: 0, outgoing: { type: "cubic-bezier", controlPoints: { x1: 2, y1: 0, x2: 1, y2: 1 } } }] }), "invalid-interpolation");
  assert.equal(code({ valueType: "number", keyframes: [{ frame: 0, value: 0, outgoing: { type: "bounce" } }] }), "invalid-interpolation");
  assert.throws(() => engine.evaluateTrack({}, 0), { code: "invalid-argument" });
});

test("curved vec2 paths, tangent angles and path validation", () => {
  const t = engine.compileTrack({
    valueType: "vec2",
    keyframes: [
      { frame: 0, value: { x: 0, y: 0 }, outgoing: linear,
        outgoingPath: { type: "bezier", cp1: { x: 0, y: 100 }, cp2: { x: 100, y: 100 } } },
      { frame: 10, value: { x: 100, y: 0 }, outgoing: linear },
    ],
  });
  assert.deepEqual(engine.evaluateTrack(t, 10), { x: 100, y: 0 });
  assert.ok(engine.evaluateTrack(t, 5).y > 50); // bulges along the handles
  assert.ok(Math.abs(engine.trackTangentAngle(t, 0) - Math.PI / 2) < 1e-9);
  const angles = engine.sampleTrackTangentAngle(t, 0, 11);
  assert.equal(angles.length, 11);
  assert.ok(Math.abs(angles[10] + Math.PI / 2) < 1e-9);
  const still = engine.compileTrack({ valueType: "vec2", keyframes: [{ frame: 0, value: { x: 1, y: 1 }, outgoing: linear }] });
  assert.ok(Number.isNaN(engine.trackTangentAngle(still, 0)));
  assert.throws(() => engine.compileTrack({ valueType: "number",
    keyframes: [{ frame: 0, value: 1, outgoing: linear, outgoingPath: { type: "curve", curviness: 1 } }] }), { code: "invalid-path" });
  assert.throws(() => engine.compileTrack({ valueType: "vec2",
    keyframes: [{ frame: 0, value: { x: 0, y: 0 }, outgoing: linear, outgoingPath: { type: "spiral" } }] }), { code: "invalid-path" });
});

test("slices tracks for trims and splits, evaluating like the original", () => {
  const t = engine.compileTrack({
    valueType: "vec2",
    keyframes: [
      { frame: 0, value: { x: 0, y: 0 }, outgoing: ease, outgoingPath: { type: "curve", curviness: 1 } },
      { frame: 20, value: { x: 200, y: 150 }, outgoing: linear },
      { frame: 40, value: { x: 300, y: 0 }, outgoing: linear },
    ],
  });
  const keys = engine.sliceTrack(t, 7, 30);
  assert.equal(keys[0].frame, 0);
  assert.equal(keys[0].sourceFrame, 7);
  assert.equal(keys[0].generated, true);
  assert.equal(keys[0].outgoingPath.type, "bezier");
  assert.ok(keys.some((k) => k.sourceFrame === 20 && !k.generated && k.frame === 13));
  const rebased = engine.compileTrack({ valueType: "vec2", keyframes: keys });
  for (let f = 0; f < 23; f++) {
    const a = engine.evaluateTrack(t, 7 + f);
    const b = engine.evaluateTrack(rebased, f);
    assert.ok(Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6, `frame ${f}`);
  }
  assert.throws(() => engine.sliceTrack(t, 5, 5), { code: "invalid-argument" });
});

test("sliceTrack rejects frame magnitudes above the compileTrack limit", () => {
  const t = engine.compileTrack({ valueType: "number", keyframes: [{ frame: 0, value: 1, outgoing: linear }] });
  for (const [from, until] of [[0, 1e20], [-1e20, 1], [0, 9e15 + 1], [-9e15 - 1, 0]]) {
    assert.throws(() => engine.sliceTrack(t, from, until), { code: "invalid-argument" });
  }
  for (const [from, until] of [[-9e15, 0], [0, 9e15]]) {
    assert.equal(engine.sliceTrack(t, from, until)[0].value, 1);
  }
});
