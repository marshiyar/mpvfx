#pragma once

#include <cstdint>

#include "vkf/core/Math.h"
#include "vkf/core/Time.h"

namespace vkf::anim {

// Temporal interpolation of one side of a keyframe (Premiere / After Effects
// semantics). EaseIn / EaseOut are presets: see easeIn() / easeOut().
enum class Interp : std::uint8_t {
    Linear,
    Bezier,            // user speed + influence per side
    AutoBezier,        // speed derived from neighbours, influence 1/3
    ContinuousBezier,  // user speed shared by both sides (outEase.speed)
    Hold,              // value jumps; no interpolation across this side
};

// Bezier handle of one side: speed in value units per second, influence as a
// fraction of the segment duration (0..1).
struct Ease {
    double speed = 0.0;
    double influence = 1.0 / 3.0;
};

// Shape of a 2D value's path through space between keyframes.
enum class Spatial : std::uint8_t {
    Linear,      // straight lines
    Bezier,      // user tangents (inTangent / outTangent)
    AutoBezier,  // smooth path through neighbouring keys
};

struct Keyframe1D {
    Time time;
    double value = 0.0;
    Interp inInterp = Interp::Linear;
    Interp outInterp = Interp::Linear;
    Ease inEase;
    Ease outEase;
};

struct Keyframe2D {
    Time time;
    Vec2 value;
    Interp inInterp = Interp::Linear;
    Interp outInterp = Interp::Linear;
    Ease inEase;   // speed along the path, pixels per second
    Ease outEase;
    Spatial spatial = Spatial::AutoBezier;
    Vec2 inTangent;   // path handle offsets relative to value (Spatial::Bezier)
    Vec2 outTangent;
};

// Presets matching Premiere's "Ease In" / "Ease Out" keyframe commands.
template <class K>
void easeIn(K& k)
{
    k.inInterp = Interp::Bezier;
    k.inEase = {0.0, 1.0 / 3.0};
}

template <class K>
void easeOut(K& k)
{
    k.outInterp = Interp::Bezier;
    k.outEase = {0.0, 1.0 / 3.0};
}

}  // namespace vkf::anim
