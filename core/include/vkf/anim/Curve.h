#pragma once

#include <optional>
#include <span>
#include <vector>

#include "vkf/anim/Keyframe.h"
#include "vkf/anim/Temporal.h"

namespace vkf::anim {

// Animated scalar. Keys are kept sorted with unique times. All const member
// functions are safe to call concurrently (evaluation caches are rebuilt
// eagerly on every mutation).
class Curve1D {
public:
    explicit Curve1D(double defaultValue = 0.0) : default_(defaultValue) {}

    // Inserts, or replaces the key at the same time.
    void setKey(const Keyframe1D& key);
    bool removeKey(const Time& time);
    void clear();

    std::span<const Keyframe1D> keys() const { return keys_; }
    bool isAnimated() const { return !keys_.empty(); }
    double defaultValue() const { return default_; }
    void setDefaultValue(double v) { default_ = v; }

    double evaluate(double seconds) const;

private:
    void rebuild();

    double default_;
    std::vector<Keyframe1D> keys_;
    std::vector<detail::TemporalKey> temporal_;
};

// Animated 2D point (Position, Anchor Point). The value moves along a spatial
// path; temporal interpolation controls the distance travelled along it, so
// easing changes speed but never the path's shape.
class Curve2D {
public:
    explicit Curve2D(Vec2 defaultValue = {}) : default_(defaultValue) {}

    void setKey(const Keyframe2D& key);
    bool removeKey(const Time& time);
    void clear();

    std::span<const Keyframe2D> keys() const { return keys_; }
    bool isAnimated() const { return !keys_.empty(); }
    Vec2 defaultValue() const { return default_; }
    void setDefaultValue(Vec2 v) { default_ = v; }

    Vec2 evaluate(double seconds) const;

    // Path length of segment i (between keys i and i+1).
    double segmentLength(int i) const;

private:
    struct Segment {
        Vec2 p0, p1, p2, p3;               // cubic Bezier control points
        std::vector<double> cumulative;    // arc length at u = j / kLutSize
        double length() const { return cumulative.back(); }
        Vec2 point(double u) const;
        Vec2 derivative(double u) const;
        // Curve parameter u at arc length s (0 <= s <= length()).
        double parameterAt(double s) const;
    };

    void rebuild();

    Vec2 default_;
    std::vector<Keyframe2D> keys_;
    std::vector<Segment> segments_;
    std::vector<detail::TemporalKey> temporal_;  // v = cumulative arc length
};

}  // namespace vkf::anim
