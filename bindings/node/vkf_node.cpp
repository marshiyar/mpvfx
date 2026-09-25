// Node-API binding for the engine (ABI-stable: the same binary loads in Node
// and in Electron). JavaScript surface, apiVersion 1:
//
//   apiVersion: number, version: string
//   compileTrack(track) -> CompiledTrack
//       track = { valueType: "number" | "vec2" | "rgba",
//                 keyframes: [{ frame: integer >= 0,
//                               value: number | {x, y} | {red, green, blue, alpha},
//                               outgoing: { type: "hold" | "linear" }
//                                       | { type: "cubic-bezier", controlPoints: {x1, y1, x2, y2} },
//                               outgoingPath?: { type: "line" }            (vec2 only: motion path
//                                            | { type: "curve", curviness }   to the next key)
//                                            | { type: "bezier", cp1: {x, y}, cp2: {x, y} } }] }
//       Throws an Error whose `code` is one of: empty-track,
//       invalid-keyframe-frame, duplicate-keyframe-frame, invalid-value,
//       invalid-interpolation, invalid-path.
//   evaluateTrack(compiled, frame) -> number | {x, y} | {red, green, blue, alpha}
//   sampleTrack(compiled, firstFrame, count) -> Float64Array (count * components)
//   trackTangentAngle(compiled, frame) -> radians (NaN when the track never moves)
//   sliceTrack(compiled, fromFrame, untilFrameExclusive)
//       -> [{ frame, value, outgoing, outgoingPath?, sourceFrame, generated }]
//       Keys of the track restricted to the range and rebased to frame 0
//       (clip trims / splits); evaluates exactly like the original.
//   sampleTrackTangentAngle(compiled, firstFrame, count) -> Float64Array
#define NAPI_VERSION 8
#include <node_api.h>

#include <cmath>
#include <memory>
#include <string>
#include <vector>

#include "vkf/anim/Track.h"

#ifndef VKF_VERSION_STRING
#define VKF_VERSION_STRING "0.0.0"
#endif

namespace {

using vkf::anim::Segment;
using vkf::anim::Track;
using vkf::anim::TrackKey;
using vkf::anim::ValueType;

constexpr int kApiVersion = 1;

// Thrown inside the binding and converted to a JavaScript Error at the boundary.
struct JsError {
    std::string code;
    std::string message;
};

[[noreturn]] void raise(const char* code, std::string message) { throw JsError{code, std::move(message)}; }

void check(napi_env env, napi_status status)
{
    if (status == napi_ok) return;
    const napi_extended_error_info* info = nullptr;
    napi_get_last_error_info(env, &info);
    raise("engine-internal", info && info->error_message ? info->error_message : "Node-API call failed");
}

napi_value property(napi_env env, napi_value object, const char* name)
{
    napi_value v;
    check(env, napi_get_named_property(env, object, name, &v));
    return v;
}

napi_valuetype typeOf(napi_env env, napi_value v)
{
    napi_valuetype t;
    check(env, napi_typeof(env, v, &t));
    return t;
}

bool isObject(napi_env env, napi_value v) { return typeOf(env, v) == napi_object; }

// Non-numbers read as NaN so validation reports them as invalid values.
double numberOrNaN(napi_env env, napi_value v)
{
    if (typeOf(env, v) != napi_number) return NAN;
    double d;
    check(env, napi_get_value_double(env, v, &d));
    return d;
}

std::string string(napi_env env, napi_value v)
{
    if (typeOf(env, v) != napi_string) return {};
    size_t len = 0;
    check(env, napi_get_value_string_utf8(env, v, nullptr, 0, &len));
    std::string s(len, '\0');
    check(env, napi_get_value_string_utf8(env, v, s.data(), len + 1, &len));
    return s;
}

ValueType parseValueType(const std::string& s)
{
    if (s == "number") return ValueType::Number;
    if (s == "vec2") return ValueType::Vec2;
    if (s == "rgba") return ValueType::Rgba;
    raise("invalid-value", "Unknown track valueType \"" + s + "\"");
}

TrackKey parseKey(napi_env env, napi_value k, ValueType type)
{
    if (!isObject(env, k)) raise("invalid-value", "Keyframe must be an object");
    TrackKey key;
    const double frame = numberOrNaN(env, property(env, k, "frame"));
    if (!std::isfinite(frame) || std::floor(frame) != frame || std::abs(frame) > 9.0e15)
        raise("invalid-keyframe-frame", "Keyframe frame must be an integer project frame");
    key.frame = static_cast<std::int64_t>(frame);

    const napi_value value = property(env, k, "value");
    if (type == ValueType::Number) {
        key.value[0] = numberOrNaN(env, value);
    } else if (!isObject(env, value)) {
        raise("invalid-value", "Keyframe at frame " + std::to_string(key.frame) + " value must be an object");
    } else if (type == ValueType::Vec2) {
        key.value[0] = numberOrNaN(env, property(env, value, "x"));
        key.value[1] = numberOrNaN(env, property(env, value, "y"));
    } else {
        key.value[0] = numberOrNaN(env, property(env, value, "red"));
        key.value[1] = numberOrNaN(env, property(env, value, "green"));
        key.value[2] = numberOrNaN(env, property(env, value, "blue"));
        key.value[3] = numberOrNaN(env, property(env, value, "alpha"));
    }

    const napi_value outgoing = property(env, k, "outgoing");
    if (!isObject(env, outgoing)) raise("invalid-interpolation", "Keyframe outgoing interpolation is missing");
    const std::string kind = string(env, property(env, outgoing, "type"));
    if (kind == "hold") {
        key.outgoing = Segment::Hold;
    } else if (kind == "linear") {
        key.outgoing = Segment::Linear;
    } else if (kind == "cubic-bezier") {
        const napi_value cp = property(env, outgoing, "controlPoints");
        if (!isObject(env, cp)) raise("invalid-interpolation", "cubic-bezier controlPoints are missing");
        key.outgoing = Segment::CubicBezier;
        key.timing = {numberOrNaN(env, property(env, cp, "x1")), numberOrNaN(env, property(env, cp, "y1")),
                      numberOrNaN(env, property(env, cp, "x2")), numberOrNaN(env, property(env, cp, "y2"))};
    } else {
        raise("invalid-interpolation", "Unknown interpolation \"" + kind + "\"");
    }

    bool hasPath = false;
    check(env, napi_has_named_property(env, k, "outgoingPath", &hasPath));
    const napi_value path = hasPath ? property(env, k, "outgoingPath") : nullptr;
    if (path && typeOf(env, path) != napi_undefined) {
        if (!isObject(env, path)) raise("invalid-path", "outgoingPath must be an object");
        const std::string shape = string(env, property(env, path, "type"));
        auto point = [&](const char* name) -> vkf::Vec2 {
            const napi_value p = property(env, path, name);
            if (!isObject(env, p)) return {NAN, NAN};
            return {numberOrNaN(env, property(env, p, "x")), numberOrNaN(env, property(env, p, "y"))};
        };
        if (shape == "line") {
            key.path.shape = vkf::anim::PathShape::Line;
        } else if (shape == "curve") {
            key.path.shape = vkf::anim::PathShape::Curve;
            key.path.curviness = numberOrNaN(env, property(env, path, "curviness"));
        } else if (shape == "bezier") {
            key.path.shape = vkf::anim::PathShape::Bezier;
            key.path.cp1 = point("cp1");
            key.path.cp2 = point("cp2");
        } else {
            raise("invalid-path", "Unknown path type \"" + shape + "\"");
        }
    }
    return key;
}

void finalizeTrack(napi_env, void* data, void*) { delete static_cast<Track*>(data); }

const Track& unwrapTrack(napi_env env, napi_value v)
{
    napi_valuetype t = typeOf(env, v);
    void* data = nullptr;
    if (t != napi_external || napi_get_value_external(env, v, &data) != napi_ok || data == nullptr)
        raise("invalid-argument", "Expected a compiled track from compileTrack()");
    return *static_cast<Track*>(data);
}

napi_value makeNumber(napi_env env, double d)
{
    napi_value v;
    check(env, napi_create_double(env, d, &v));
    return v;
}

napi_value makeValue(napi_env env, ValueType type, const double* c)
{
    if (type == ValueType::Number) return makeNumber(env, c[0]);
    napi_value o;
    check(env, napi_create_object(env, &o));
    const char* const vec[] = {"x", "y"};
    const char* const rgba[] = {"red", "green", "blue", "alpha"};
    const int n = vkf::anim::componentCount(type);
    for (int i = 0; i < n; ++i)
        check(env, napi_set_named_property(env, o, type == ValueType::Vec2 ? vec[i] : rgba[i], makeNumber(env, c[i])));
    return o;
}

std::vector<napi_value> arguments(napi_env env, napi_callback_info info, size_t expected)
{
    size_t argc = expected;
    std::vector<napi_value> argv(expected);
    check(env, napi_get_cb_info(env, info, &argc, argv.data(), nullptr, nullptr));
    if (argc < expected) raise("invalid-argument", "Expected " + std::to_string(expected) + " arguments");
    return argv;
}

// Runs `body` and converts C++ exceptions into JavaScript errors with a code.
template <class F>
napi_value guarded(napi_env env, F&& body)
{
    try {
        return body();
    } catch (const JsError& e) {
        napi_throw_error(env, e.code.c_str(), e.message.c_str());
    } catch (const vkf::anim::TrackValidationError& e) {
        napi_throw_error(env, vkf::anim::trackErrorCode(e.code()), e.what());
    } catch (const std::exception& e) {
        napi_throw_error(env, "engine-internal", e.what());
    }
    return nullptr;
}

napi_value compileTrack(napi_env env, napi_callback_info info)
{
    return guarded(env, [&] {
        const napi_value track = arguments(env, info, 1)[0];
        if (!isObject(env, track)) raise("invalid-argument", "Expected a track object");
        const ValueType type = parseValueType(string(env, property(env, track, "valueType")));
        const napi_value keys = property(env, track, "keyframes");
        bool isArray = false;
        check(env, napi_is_array(env, keys, &isArray));
        if (!isArray) raise("empty-track", "Track keyframes must be an array");
        uint32_t count = 0;
        check(env, napi_get_array_length(env, keys, &count));
        std::vector<TrackKey> parsed;
        parsed.reserve(count);
        for (uint32_t i = 0; i < count; ++i) {
            napi_value k;
            check(env, napi_get_element(env, keys, i, &k));
            parsed.push_back(parseKey(env, k, type));
        }
        auto compiled = std::make_unique<Track>(type, std::move(parsed));
        napi_value external;
        check(env, napi_create_external(env, compiled.get(), finalizeTrack, nullptr, &external));
        compiled.release();
        return external;
    });
}

napi_value evaluateTrack(napi_env env, napi_callback_info info)
{
    return guarded(env, [&] {
        const auto argv = arguments(env, info, 2);
        const Track& track = unwrapTrack(env, argv[0]);
        const double frame = numberOrNaN(env, argv[1]);
        if (!std::isfinite(frame)) raise("invalid-argument", "Frame must be a finite number");
        double out[4];
        track.evaluate(frame, out);
        return makeValue(env, track.type(), out);
    });
}

napi_value sampleTrack(napi_env env, napi_callback_info info)
{
    return guarded(env, [&] {
        const auto argv = arguments(env, info, 3);
        const Track& track = unwrapTrack(env, argv[0]);
        const double first = numberOrNaN(env, argv[1]);
        const double count = numberOrNaN(env, argv[2]);
        if (!std::isfinite(first) || std::floor(count) != count || count < 0 || count > 1.0e8)
            raise("invalid-argument", "sampleTrack(track, firstFrame, count) needs a finite frame and count");
        const int n = vkf::anim::componentCount(track.type());
        const size_t total = static_cast<size_t>(count) * static_cast<size_t>(n);
        void* data = nullptr;
        napi_value buffer, array;
        check(env, napi_create_arraybuffer(env, total * sizeof(double), &data, &buffer));
        auto* out = static_cast<double*>(data);
        for (size_t i = 0; i < static_cast<size_t>(count); ++i)
            track.evaluate(first + static_cast<double>(i), out + i * static_cast<size_t>(n));
        check(env, napi_create_typedarray(env, napi_float64_array, total, buffer, 0, &array));
        return array;
    });
}

void setNamed(napi_env env, napi_value object, const char* name, napi_value value)
{
    check(env, napi_set_named_property(env, object, name, value));
}

napi_value makeString(napi_env env, const char* s)
{
    napi_value v;
    check(env, napi_create_string_utf8(env, s, NAPI_AUTO_LENGTH, &v));
    return v;
}

napi_value makeVec(napi_env env, vkf::Vec2 p)
{
    napi_value o;
    check(env, napi_create_object(env, &o));
    setNamed(env, o, "x", makeNumber(env, p.x));
    setNamed(env, o, "y", makeNumber(env, p.y));
    return o;
}

napi_value makeKey(napi_env env, ValueType type, const vkf::anim::SlicedKey& sliced)
{
    const TrackKey& k = sliced.key;
    napi_value o, outgoing, flag;
    check(env, napi_create_object(env, &o));
    setNamed(env, o, "frame", makeNumber(env, static_cast<double>(k.frame)));
    setNamed(env, o, "value", makeValue(env, type, k.value.data()));
    check(env, napi_create_object(env, &outgoing));
    switch (k.outgoing) {
        case Segment::Hold: setNamed(env, outgoing, "type", makeString(env, "hold")); break;
        case Segment::Linear: setNamed(env, outgoing, "type", makeString(env, "linear")); break;
        case Segment::CubicBezier: {
            napi_value cp;
            check(env, napi_create_object(env, &cp));
            setNamed(env, cp, "x1", makeNumber(env, k.timing.x1));
            setNamed(env, cp, "y1", makeNumber(env, k.timing.y1));
            setNamed(env, cp, "x2", makeNumber(env, k.timing.x2));
            setNamed(env, cp, "y2", makeNumber(env, k.timing.y2));
            setNamed(env, outgoing, "type", makeString(env, "cubic-bezier"));
            setNamed(env, outgoing, "controlPoints", cp);
            break;
        }
    }
    setNamed(env, o, "outgoing", outgoing);
    if (k.path.shape != vkf::anim::PathShape::Line) {
        napi_value path;
        check(env, napi_create_object(env, &path));
        if (k.path.shape == vkf::anim::PathShape::Curve) {
            setNamed(env, path, "type", makeString(env, "curve"));
            setNamed(env, path, "curviness", makeNumber(env, k.path.curviness));
        } else {
            setNamed(env, path, "type", makeString(env, "bezier"));
            setNamed(env, path, "cp1", makeVec(env, k.path.cp1));
            setNamed(env, path, "cp2", makeVec(env, k.path.cp2));
        }
        setNamed(env, o, "outgoingPath", path);
    }
    setNamed(env, o, "sourceFrame", makeNumber(env, static_cast<double>(sliced.sourceFrame)));
    check(env, napi_get_boolean(env, sliced.generated, &flag));
    setNamed(env, o, "generated", flag);
    return o;
}

napi_value sliceTrack(napi_env env, napi_callback_info info)
{
    return guarded(env, [&] {
        const auto argv = arguments(env, info, 3);
        const Track& track = unwrapTrack(env, argv[0]);
        const double from = numberOrNaN(env, argv[1]);
        const double until = numberOrNaN(env, argv[2]);
        if (!std::isfinite(from) || !std::isfinite(until) || std::floor(from) != from || std::floor(until) != until ||
            until <= from)
            raise("invalid-argument", "sliceTrack(track, fromFrame, untilFrameExclusive) needs an integer range");
        const auto sliced = track.slice(static_cast<std::int64_t>(from), static_cast<std::int64_t>(until));
        napi_value array;
        check(env, napi_create_array_with_length(env, sliced.size(), &array));
        for (size_t i = 0; i < sliced.size(); ++i)
            check(env, napi_set_element(env, array, static_cast<uint32_t>(i), makeKey(env, track.type(), sliced[i])));
        return array;
    });
}

napi_value trackTangentAngle(napi_env env, napi_callback_info info)
{
    return guarded(env, [&] {
        const auto argv = arguments(env, info, 2);
        const Track& track = unwrapTrack(env, argv[0]);
        const double frame = numberOrNaN(env, argv[1]);
        if (!std::isfinite(frame)) raise("invalid-argument", "Frame must be a finite number");
        return makeNumber(env, track.tangentAngle(frame));
    });
}

napi_value sampleTrackTangentAngle(napi_env env, napi_callback_info info)
{
    return guarded(env, [&] {
        const auto argv = arguments(env, info, 3);
        const Track& track = unwrapTrack(env, argv[0]);
        const double first = numberOrNaN(env, argv[1]);
        const double count = numberOrNaN(env, argv[2]);
        if (!std::isfinite(first) || std::floor(count) != count || count < 0 || count > 1.0e8)
            raise("invalid-argument", "sampleTrackTangentAngle(track, firstFrame, count) needs a finite frame and count");
        void* data = nullptr;
        napi_value buffer, array;
        const size_t n = static_cast<size_t>(count);
        check(env, napi_create_arraybuffer(env, n * sizeof(double), &data, &buffer));
        auto* out = static_cast<double*>(data);
        for (size_t i = 0; i < n; ++i) out[i] = track.tangentAngle(first + static_cast<double>(i));
        check(env, napi_create_typedarray(env, napi_float64_array, n, buffer, 0, &array));
        return array;
    });
}

napi_value init(napi_env env, napi_value exports)
{
    napi_value apiVersion, version;
    napi_create_int32(env, kApiVersion, &apiVersion);
    napi_create_string_utf8(env, VKF_VERSION_STRING, NAPI_AUTO_LENGTH, &version);
    const napi_property_descriptor props[] = {
        {"apiVersion", nullptr, nullptr, nullptr, nullptr, apiVersion, napi_enumerable, nullptr},
        {"version", nullptr, nullptr, nullptr, nullptr, version, napi_enumerable, nullptr},
        {"compileTrack", nullptr, compileTrack, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
        {"evaluateTrack", nullptr, evaluateTrack, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
        {"sampleTrack", nullptr, sampleTrack, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
        {"trackTangentAngle", nullptr, trackTangentAngle, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
        {"sliceTrack", nullptr, sliceTrack, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
        {"sampleTrackTangentAngle", nullptr, sampleTrackTangentAngle, nullptr, nullptr, nullptr, napi_enumerable, nullptr},
    };
    napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
    return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
