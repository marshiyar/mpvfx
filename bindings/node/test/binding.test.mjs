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
