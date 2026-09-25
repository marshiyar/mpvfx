#pragma once

#include <array>
#include <cstdint>
#include <span>
#include <stdexcept>
#include <string>
#include <vector>

// Parameter tracks with per-segment easing: the model editors such as mpvfx
// store. A segment [k, k+1] is shaped entirely by key k's outgoing
// interpolation (Hold, Linear, or a normalised cubic-bezier timing curve like
// CSS `cubic-bezier(x1, y1, x2, y2)`); all components of a multi-component
// value share that timing. Frames are integers in the track's own frame rate.
namespace vkf::anim {

enum class ValueType : std::uint8_t { Number = 1, Vec2 = 2, Rgba = 4 };

constexpr int componentCount(ValueType t) { return static_cast<int>(t); }

enum class Segment : std::uint8_t { Hold, Linear, CubicBezier };

struct CubicTiming {
    double x1 = 0.0, y1 = 0.0, x2 = 1.0, y2 = 1.0;
};

struct TrackKey {
    std::int64_t frame = 0;
    std::array<double, 4> value{};  // first componentCount(type) entries are used
    Segment outgoing = Segment::Linear;
    CubicTiming timing;             // used when outgoing == CubicBezier
};

// Why a track was rejected. Codes are stable identifiers shared with callers.
enum class TrackError : std::uint8_t {
    EmptyTrack,
    InvalidKeyframeFrame,
    DuplicateKeyframeFrame,
    InvalidValue,
    InvalidInterpolation,
};

const char* trackErrorCode(TrackError e);

class TrackValidationError : public std::invalid_argument {
public:
    TrackValidationError(TrackError code, const std::string& message)
        : std::invalid_argument(message), code_(code)
    {
    }
    TrackError code() const { return code_; }

private:
    TrackError code_;
};

// Immutable, validated track. Keys are sorted by frame.
class Track {
public:
    // Validates (non-empty, integer frames >= 0 and unique, finite values,
    // RGBA components in [0, 1], cubic x1/x2 in [0, 1]) and sorts the keys.
    // Throws TrackValidationError.
    Track(ValueType type, std::vector<TrackKey> keys);

    ValueType type() const { return type_; }
    std::span<const TrackKey> keys() const { return keys_; }

    // Value at `frame` (fractional frames allowed, for motion blur). Constant
    // before the first and after the last key. Writes componentCount(type())
    // values to `out`.
    void evaluate(double frame, double* out) const;

private:
    ValueType type_;
    std::vector<TrackKey> keys_;
};

// Eased progress in [0, 1] (may overshoot for cubic y) for a linear progress
// in [0, 1] under the given segment interpolation.
double easeProgress(Segment segment, const CubicTiming& timing, double linear);

}  // namespace vkf::anim
