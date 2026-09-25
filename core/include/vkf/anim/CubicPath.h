#pragma once

#include <vector>

#include "vkf/core/Math.h"

namespace vkf::anim {

// A cubic Bezier segment in 2D with an arc-length table, so motion along it
// can be parameterised by distance (constant speed) rather than by the curve
// parameter.
class CubicPath {
public:
    CubicPath() = default;
    CubicPath(Vec2 p0, Vec2 p1, Vec2 p2, Vec2 p3);

    Vec2 point(double u) const;
    Vec2 derivative(double u) const;
    double length() const { return cumulative_.empty() ? 0.0 : cumulative_.back(); }
    // Curve parameter at arc length s, for 0 <= s <= length().
    double parameterAt(double s) const;

    // Point at arc length s. Outside [0, length()] the path continues in a
    // straight line along its end tangent, so eased overshoot stays smooth.
    Vec2 pointAtDistance(double s) const;
    // Unit tangent at arc length s (clamped to the ends); {0, 0} if the path
    // has no direction anywhere.
    Vec2 tangentAtDistance(double s) const;

    Vec2 p0() const { return p0_; }
    Vec2 p3() const { return p3_; }

private:
    Vec2 endTangent(bool atStart) const;

    Vec2 p0_, p1_, p2_, p3_;
    std::vector<double> cumulative_;  // arc length at u = j / kLutSize
};

}  // namespace vkf::anim
