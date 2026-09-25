#include "vkf/anim/Track.h"

#include <algorithm>
#include <cmath>

namespace vkf::anim {

namespace {

double cubicCoordinate(double t, double first, double second)
{
    const double inv = 1.0 - t;
    return 3.0 * inv * inv * t * first + 3.0 * inv * t * t * second + t * t * t;
}

double cubicDerivative(double t, double first, double second)
{
    const double inv = 1.0 - t;
    return 3.0 * inv * inv * first + 6.0 * inv * t * (second - first) + 3.0 * t * t * (1.0 - second);
}

// Solve x(t) = progress on the normalised timing curve (x1, x2 in [0, 1], so
// x(t) is monotonic), then return y(t). Newton with a bisection fallback.
double cubicTiming(const CubicTiming& c, double progress)
{
    if (progress <= 0.0) return 0.0;
    if (progress >= 1.0) return 1.0;
    double t = progress;
    for (int i = 0; i < 8; ++i) {
        const double diff = cubicCoordinate(t, c.x1, c.x2) - progress;
        if (std::abs(diff) < 1e-12) return cubicCoordinate(t, c.y1, c.y2);
        const double d = cubicDerivative(t, c.x1, c.x2);
        if (std::abs(d) < 1e-9) break;
        const double next = t - diff / d;
        if (next < 0.0 || next > 1.0) break;
        t = next;
    }
    double lo = 0.0, hi = 1.0;
    for (int i = 0; i < 64; ++i) {
        t = 0.5 * (lo + hi);
        if (cubicCoordinate(t, c.x1, c.x2) < progress)
            lo = t;
        else
            hi = t;
    }
    return cubicCoordinate(0.5 * (lo + hi), c.y1, c.y2);
}

const char* componentName(ValueType type, int c)
{
    static const char* const vec[] = {"x", "y"};
    static const char* const rgba[] = {"red", "green", "blue", "alpha"};
    if (type == ValueType::Number) return "value";
    return type == ValueType::Vec2 ? vec[c] : rgba[c];
}

[[noreturn]] void fail(TrackError code, const std::string& message) { throw TrackValidationError(code, message); }

}  // namespace

const char* trackErrorCode(TrackError e)
{
    switch (e) {
        case TrackError::EmptyTrack: return "empty-track";
        case TrackError::InvalidKeyframeFrame: return "invalid-keyframe-frame";
        case TrackError::DuplicateKeyframeFrame: return "duplicate-keyframe-frame";
        case TrackError::InvalidValue: return "invalid-value";
        case TrackError::InvalidInterpolation: return "invalid-interpolation";
    }
    return "invalid-track";
}

double easeProgress(Segment segment, const CubicTiming& timing, double linear)
{
    switch (segment) {
        case Segment::Hold: return 0.0;
        case Segment::Linear: return linear;
        case Segment::CubicBezier: return cubicTiming(timing, linear);
    }
    return linear;
}

Track::Track(ValueType type, std::vector<TrackKey> keys) : type_(type), keys_(std::move(keys))
{
    if (type != ValueType::Number && type != ValueType::Vec2 && type != ValueType::Rgba)
        fail(TrackError::InvalidValue, "Unknown track value type");
    if (keys_.empty()) fail(TrackError::EmptyTrack, "Track must contain at least one keyframe");
    const int n = componentCount(type);
    for (const TrackKey& k : keys_) {
        const std::string at = "Keyframe at frame " + std::to_string(k.frame);
        if (k.frame < 0) fail(TrackError::InvalidKeyframeFrame, at + " must not be negative");
        for (int c = 0; c < n; ++c) {
            const double v = k.value[static_cast<std::size_t>(c)];
            const std::string channel = componentName(type, c);
            if (!std::isfinite(v)) fail(TrackError::InvalidValue, at + " " + channel + " must be finite");
            if (type == ValueType::Rgba && (v < 0.0 || v > 1.0))
                fail(TrackError::InvalidValue, at + " " + channel + " must be between 0 and 1");
        }
        if (k.outgoing == Segment::CubicBezier) {
            const CubicTiming& t = k.timing;
            if (!std::isfinite(t.x1) || !std::isfinite(t.y1) || !std::isfinite(t.x2) || !std::isfinite(t.y2))
                fail(TrackError::InvalidInterpolation, at + " cubic-bezier points must be finite");
            if (t.x1 < 0.0 || t.x1 > 1.0 || t.x2 < 0.0 || t.x2 > 1.0)
                fail(TrackError::InvalidInterpolation, at + " cubic-bezier x1 and x2 must be between 0 and 1");
        } else if (k.outgoing != Segment::Hold && k.outgoing != Segment::Linear) {
            fail(TrackError::InvalidInterpolation, at + " has an unknown interpolation");
        }
    }
    std::stable_sort(keys_.begin(), keys_.end(), [](const TrackKey& a, const TrackKey& b) { return a.frame < b.frame; });
    for (std::size_t i = 1; i < keys_.size(); ++i)
        if (keys_[i].frame == keys_[i - 1].frame)
            fail(TrackError::DuplicateKeyframeFrame, "Duplicate keyframe frame " + std::to_string(keys_[i].frame));
}

void Track::evaluate(double frame, double* out) const
{
    const int n = componentCount(type_);
    auto copy = [&](const TrackKey& k) {
        for (int c = 0; c < n; ++c) out[c] = k.value[static_cast<std::size_t>(c)];
    };
    const TrackKey& first = keys_.front();
    const TrackKey& last = keys_.back();
    if (!(frame > static_cast<double>(first.frame))) {  // also catches NaN
        copy(first);
        return;
    }
    if (frame >= static_cast<double>(last.frame)) {
        copy(last);
        return;
    }
    // Last key with key.frame <= frame.
    const auto it = std::upper_bound(keys_.begin(), keys_.end(), frame,
                                     [](double f, const TrackKey& k) { return f < static_cast<double>(k.frame); });
    const TrackKey& a = *(it - 1);
    const TrackKey& b = *it;
    if (frame == static_cast<double>(a.frame)) {
        copy(a);
        return;
    }
    const double linear = (frame - static_cast<double>(a.frame)) / static_cast<double>(b.frame - a.frame);
    const double p = easeProgress(a.outgoing, a.timing, linear);
    for (int c = 0; c < n; ++c) {
        const double s = a.value[static_cast<std::size_t>(c)];
        const double e = b.value[static_cast<std::size_t>(c)];
        out[c] = s + (e - s) * p;
    }
}

}  // namespace vkf::anim
