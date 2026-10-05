#pragma once

#include <array>

#include "vkf/anim/Curve.h"
#include "vkf/motion/MotionParams.h"

namespace vkf::motion {

// Keyframe storage for the Motion effect when our own engine owns the
// timeline (inside OFX hosts the host stores keyframes instead). One curve per
// schema entry; non-animatable parameters are stored as plain values.
class AnimatedMotion {
public:
    AnimatedMotion(FrameSize sequence, FrameSize clip);

    // Throws std::invalid_argument for a kind mismatch or non-animatable id.
    anim::Curve1D& curve(ParamId id);
    const anim::Curve1D& curve(ParamId id) const;
    anim::Curve2D& curve2D(ParamId id);
    const anim::Curve2D& curve2D(ParamId id) const;

    // Static (non-animated) values: Quality, Motion Blur and its settings.
    void setStatic(ParamId id, double value);

    MotionParams evaluate(double seconds) const;

private:
    std::array<anim::Curve1D, static_cast<std::size_t>(ParamId::Count)> scalars_;
    std::array<anim::Curve2D, static_cast<std::size_t>(ParamId::Count)> points_;
    MotionParams statics_;
};

}  // namespace vkf::motion
