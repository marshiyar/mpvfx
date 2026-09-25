#include "vkf/anim/Track.h"

#include <algorithm>
#include <stdexcept>
#include <cmath>
#include <limits>

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
// x(t) is monotonic). Newton with a bisection fallback.
double timingParameterAtX(const CubicTiming& c, double progress)
{
    if (progress <= 0.0) return 0.0;
    if (progress >= 1.0) return 1.0;
    double t = progress;
    for (int i = 0; i < 8; ++i) {
        const double diff = cubicCoordinate(t, c.x1, c.x2) - progress;
        if (std::abs(diff) < 1e-12) return t;
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
    return 0.5 * (lo + hi);
}

double cubicTiming(const CubicTiming& c, double progress)
{
    return cubicCoordinate(timingParameterAtX(c, progress), c.y1, c.y2);
}

// Check every interior extremum of the normalised slice's timing curve.
// Staying in [0, 1] means motion stays on the retained spatial subcurve.
bool timingStaysOnSubcurve(const CubicTiming& c)
{
    const double a = 3.0 * c.y1 - 3.0 * c.y2 + 1.0;
    const double b = 2.0 * (c.y2 - 2.0 * c.y1);
    const double d = c.y1;
    auto inside = [&](double t) {
        if (t <= 0.0 || t >= 1.0) return true;
        const double y = cubicCoordinate(t, c.y1, c.y2);
        return y >= 0.0 && y <= 1.0;
    };
    // y'(t) / 3 = a*t*t + b*t + d.
    if (a == 0.0) return b == 0.0 || inside(-d / b);
    const double discriminant = b * b - 4.0 * a * d;
    if (discriminant < 0.0) return true;
    const double q = -0.5 * (b + std::copysign(std::sqrt(discriminant), b));
    return q == 0.0 || (inside(q / a) && inside(d / q));
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
        case TrackError::InvalidPath: return "invalid-path";
    }
    return "invalid-track";
}

namespace {

struct Bezier2 {
    Vec2 p0, p1, p2, p3;
};

// De Casteljau: the part of `b` between curve parameters t0 <= t1.
Bezier2 subCurve(const Bezier2& b, double t0, double t1)
{
    auto mix = [](Vec2 a, Vec2 c, double t) { return a + (c - a) * t; };
    auto split = [&](const Bezier2& c, double t, bool keepLeft) {
        const Vec2 a = mix(c.p0, c.p1, t), bb = mix(c.p1, c.p2, t), cc = mix(c.p2, c.p3, t);
        const Vec2 d = mix(a, bb, t), e = mix(bb, cc, t), f = mix(d, e, t);
        return keepLeft ? Bezier2{c.p0, a, d, f} : Bezier2{f, e, cc, c.p3};
    };
    const Bezier2 left = split(b, t1, true);
    return t1 > 0.0 ? split(left, t0 / t1, false) : Bezier2{b.p0, b.p0, b.p0, b.p0};
}

// Timing curve restricted to linear progress [a, b], renormalised to (0,0)-(1,1).
// Returns false when the slice has no progress change (a returning curve).
bool sliceTiming(const CubicTiming& c, double a, double b, CubicTiming& out)
{
    const Bezier2 curve{{0, 0}, {c.x1, c.y1}, {c.x2, c.y2}, {1, 1}};
    const Bezier2 part = subCurve(curve, timingParameterAtX(c, a), timingParameterAtX(c, b));
    const double dx = part.p3.x - part.p0.x;
    const double dy = part.p3.y - part.p0.y;
    if (std::abs(dy) < 1e-12 || dx <= 0.0) return false;
    auto nx = [&](double x) { return std::clamp((x - part.p0.x) / dx, 0.0, 1.0); };
    out = {nx(part.p1.x), (part.p1.y - part.p0.y) / dy, nx(part.p2.x), (part.p2.y - part.p0.y) / dy};
    return true;
}

}  // namespace

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
        const PathSegment& path = k.path;
        if (path.shape != PathShape::Line) {
            if (type != ValueType::Vec2) fail(TrackError::InvalidPath, at + " has a motion path on a non-2D value");
            if (path.shape == PathShape::Curve && !std::isfinite(path.curviness))
                fail(TrackError::InvalidPath, at + " path curviness must be finite");
            if (path.shape == PathShape::Bezier &&
                !(std::isfinite(path.cp1.x) && std::isfinite(path.cp1.y) && std::isfinite(path.cp2.x) &&
                  std::isfinite(path.cp2.y)))
                fail(TrackError::InvalidPath, at + " path control points must be finite");
            if (path.shape != PathShape::Curve && path.shape != PathShape::Bezier)
                fail(TrackError::InvalidPath, at + " has an unknown path shape");
        }
    }
    std::stable_sort(keys_.begin(), keys_.end(), [](const TrackKey& a, const TrackKey& b) { return a.frame < b.frame; });
    for (std::size_t i = 1; i < keys_.size(); ++i)
        if (keys_[i].frame == keys_[i - 1].frame)
            fail(TrackError::DuplicateKeyframeFrame, "Duplicate keyframe frame " + std::to_string(keys_[i].frame));

    // Build per-segment paths only when some segment is curved, so straight
    // tracks keep the exact component-wise interpolation.
    const std::size_t segments = keys_.size() - 1;
    bool curved = false;
    for (std::size_t i = 0; i < segments; ++i) curved = curved || keys_[i].path.shape != PathShape::Line;
    if (!curved) return;
    // Catmull-Rom tangents with the end points repeated: m_k = (P[k+1] - P[k-1]) / 2.
    auto tangent = [&](std::size_t k) {
        const std::size_t prev = k == 0 ? 0 : k - 1;
        const std::size_t next = std::min(k + 1, keys_.size() - 1);
        return (keyPoint(next) - keyPoint(prev)) * 0.5;
    };
    paths_.reserve(segments);
    for (std::size_t i = 0; i < segments; ++i) {
        const Vec2 a = keyPoint(i), b = keyPoint(i + 1);
        const PathSegment& path = keys_[i].path;
        switch (path.shape) {
            case PathShape::Line: paths_.emplace_back(a, a + (b - a) / 3.0, a + (b - a) * (2.0 / 3.0), b); break;
            case PathShape::Curve: {
                const double c = path.curviness / 3.0;
                paths_.emplace_back(a, a + tangent(i) * c, b - tangent(i + 1) * c, b);
                break;
            }
            case PathShape::Bezier: paths_.emplace_back(a, path.cp1, path.cp2, b); break;
        }
    }
}

int Track::segmentAt(double frame) const
{
    const int n = static_cast<int>(keys_.size());
    if (!(frame >= static_cast<double>(keys_.front().frame))) return -1;
    if (frame >= static_cast<double>(keys_.back().frame)) return n - 1;
    const auto it = std::upper_bound(keys_.begin(), keys_.end(), frame,
                                     [](double f, const TrackKey& k) { return f < static_cast<double>(k.frame); });
    return static_cast<int>(it - keys_.begin()) - 1;
}

double Track::distanceInSegment(int i, double frame) const
{
    const TrackKey& a = keys_[static_cast<std::size_t>(i)];
    const TrackKey& b = keys_[static_cast<std::size_t>(i) + 1];
    const double linear = (frame - static_cast<double>(a.frame)) / static_cast<double>(b.frame - a.frame);
    return easeProgress(a.outgoing, a.timing, linear) * paths_[static_cast<std::size_t>(i)].length();
}

double Track::tangentAngle(double frame) const
{
    if (type_ != ValueType::Vec2 || keys_.size() < 2 || std::isnan(frame)) return NAN;
    const int n = static_cast<int>(keys_.size());
    auto moving = [&](int i) { return keys_[static_cast<std::size_t>(i)].outgoing != Segment::Hold; };
    // Direction of segment i at arc length s (clamped to the segment).
    auto direction = [&](int i, double s) -> Vec2 {
        if (!paths_.empty()) return paths_[static_cast<std::size_t>(i)].tangentAtDistance(s);
        const Vec2 d = keyPoint(static_cast<std::size_t>(i) + 1) - keyPoint(static_cast<std::size_t>(i));
        const double l = vkf::length(d);
        return l > 1e-12 ? d / l : Vec2{};
    };
    auto angle = [](Vec2 d) { return std::atan2(d.y, d.x); };
    auto isZero = [](Vec2 d) { return d.x == 0.0 && d.y == 0.0; };

    const int i = segmentAt(frame);
    if (i >= 0 && i < n - 1 && moving(i)) {
        const double s = paths_.empty() ? 0.0 : distanceInSegment(i, frame);
        const Vec2 d = direction(i, s);
        if (!isZero(d)) return angle(d);
    }
    // Held, stationary, or outside the keys: the nearest preceding motion.
    for (int j = std::min(i, n - 2); j >= 0; --j) {
        if (!moving(j)) continue;
        const Vec2 d = direction(j, std::numeric_limits<double>::infinity());
        if (!isZero(d)) return angle(d);
    }
    for (int j = std::max(i, 0); j < n - 1; ++j) {
        if (!moving(j)) continue;
        const Vec2 d = direction(j, 0.0);
        if (!isZero(d)) return angle(d);
    }
    return NAN;
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
    const std::size_t segment = static_cast<std::size_t>(it - keys_.begin()) - 1;
    if (!paths_.empty() && a.outgoing != Segment::Hold && a.path.shape != PathShape::Line) {
        const Vec2 p = paths_[segment].pointAtDistance(distanceInSegment(static_cast<int>(segment), frame));
        out[0] = p.x;
        out[1] = p.y;
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

namespace vkf::anim {

std::vector<SlicedKey> Track::slice(std::int64_t fromFrame, std::int64_t untilFrameExclusive) const
{
    if (untilFrameExclusive <= fromFrame) throw std::invalid_argument("Track::slice needs a non-empty frame range");
    const int n = componentCount(type_);
    auto authoredAt = [&](std::int64_t frame) -> const TrackKey* {
        const auto it = std::lower_bound(keys_.begin(), keys_.end(), frame,
                                         [](const TrackKey& k, std::int64_t f) { return k.frame < f; });
        return it != keys_.end() && it->frame == frame ? &*it : nullptr;
    };
    auto sampleAt = [&](std::int64_t frame, bool forceGenerated) {
        SlicedKey out;
        out.sourceFrame = frame;
        const TrackKey* authored = forceGenerated ? nullptr : authoredAt(frame);
        if (authored) {
            out.key = *authored;
        } else {
            out.generated = true;
            out.key.frame = frame;
            evaluate(static_cast<double>(frame), out.key.value.data());
            if (type_ == ValueType::Rgba)
                for (double& channel : out.key.value) channel = std::clamp(channel, 0.0, 1.0);
            for (int c = n; c < 4; ++c) out.key.value[static_cast<std::size_t>(c)] = 0.0;
            out.key.outgoing = Segment::Hold;
        }
        out.key.frame = frame - fromFrame;
        return out;
    };

    std::vector<std::int64_t> frames{fromFrame};
    for (const TrackKey& k : keys_)
        if (k.frame > fromFrame && k.frame < untilFrameExclusive) frames.push_back(k.frame);
    // Keep the final visible sample if the range cuts an animated segment.
    const std::int64_t lastVisible = untilFrameExclusive - 1;
    if (lastVisible > frames.back() && keys_.back().frame > lastVisible) frames.push_back(lastVisible);

    std::vector<SlicedKey> out;
    out.reserve(frames.size());
    for (std::int64_t f : frames) out.push_back(sampleAt(f, false));

    std::vector<SlicedKey> extra;
    for (std::size_t i = 0; i + 1 < frames.size(); ++i) {
        const std::int64_t start = frames[i], end = frames[i + 1];
        TrackKey& key = out[i].key;
        key.path = PathSegment{};
        // Original segment containing [start, end].
        const int left = segmentAt(static_cast<double>(start));
        if (left < 0 || left >= static_cast<int>(keys_.size()) - 1) {
            key.outgoing = Segment::Hold;
            continue;
        }
        const TrackKey& a = keys_[static_cast<std::size_t>(left)];
        const TrackKey& b = keys_[static_cast<std::size_t>(left) + 1];
        const double span = static_cast<double>(b.frame - a.frame);
        const double pa = static_cast<double>(start - a.frame) / span;
        const double pb = static_cast<double>(end - a.frame) / span;

        bool exact = true;
        key.outgoing = a.outgoing;
        if (a.outgoing == Segment::CubicBezier) exact = sliceTiming(a.timing, pa, pb, key.timing);

        const bool curved = !paths_.empty() && a.outgoing != Segment::Hold && a.path.shape != PathShape::Line;
        if (exact && curved) {
            const CubicPath& path = paths_[static_cast<std::size_t>(left)];
            const double d0 = easeProgress(a.outgoing, a.timing, pa) * path.length();
            const double d1 = easeProgress(a.outgoing, a.timing, pb) * path.length();
            if (d0 < 0.0 || d1 > path.length() || d1 < d0 ||
                (a.outgoing == Segment::CubicBezier && !timingStaysOnSubcurve(key.timing))) {
                exact = false;  // eased overshoot leaves the retained curve: keep samples
            } else {
                const Bezier2 whole{path.p0(), path.p1(), path.p2(), path.p3()};
                const Bezier2 part = subCurve(whole, path.parameterAt(d0), path.parameterAt(d1));
                key.path.shape = PathShape::Bezier;
                key.path.cp1 = part.p1;
                key.path.cp2 = part.p2;
            }
        }
        if (!exact) {
            // Bound the combined output before allocating per-frame samples.
            constexpr std::size_t maxKeys = 100000000;
            const auto additional = static_cast<std::uint64_t>(end) - static_cast<std::uint64_t>(start) - 1;
            if (out.size() > maxKeys || extra.size() > maxKeys - out.size() ||
                additional > maxKeys - out.size() - extra.size())
                throw std::length_error("Track::slice exceeds the 100000000-key fallback limit");
            key.outgoing = Segment::Linear;
            key.path = PathSegment{};
            for (std::int64_t f = start + 1; f < end; ++f) {
                SlicedKey sample = sampleAt(f, true);
                sample.key.outgoing = Segment::Linear;
                extra.push_back(sample);
            }
        }
    }
    // The last key has no following segment: no easing or path.
    out.back().key.outgoing = Segment::Hold;
    out.back().key.timing = CubicTiming{};
    out.back().key.path = PathSegment{};
    out.insert(out.end(), extra.begin(), extra.end());
    std::sort(out.begin(), out.end(), [](const SlicedKey& x, const SlicedKey& y) { return x.key.frame < y.key.frame; });
    return out;
}

}  // namespace vkf::anim
