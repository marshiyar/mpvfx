#pragma once

#include <span>

#include "vkf/anim/Keyframe.h"

// Scalar temporal interpolation shared by 1D curves and by the arc-length
// parameter of 2D paths. Internal to core/anim; use Curve1D / Curve2D.
namespace vkf::anim::detail {

struct TemporalKey {
    double t = 0.0;  // seconds
    double v = 0.0;
    Interp inInterp = Interp::Linear;
    Interp outInterp = Interp::Linear;
    Ease inEase;
    Ease outEase;
};

// Index i of the segment [keys[i], keys[i+1]] containing t, or -1 before the
// first key, or keys.size()-1 at/after the last key. Keys must be sorted.
int findSegment(std::span<const TemporalKey> keys, double t);

// Value of segment i (0 <= i < size-1) at time t, t clamped into the segment.
// Returns keys[i].v for held segments.
double evaluateSegment(std::span<const TemporalKey> keys, int i, double t);

// Whether segment i holds its start value.
bool isHold(std::span<const TemporalKey> keys, int i);

// Full evaluation: constant outside the key range.
double evaluate(std::span<const TemporalKey> keys, double t);

}  // namespace vkf::anim::detail
