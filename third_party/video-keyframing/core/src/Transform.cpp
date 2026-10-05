#include "vkf/motion/Transform.h"

#include <algorithm>
#include <numbers>

namespace vkf::motion {

Affine clipToSequence(const MotionParams& p, double sequencePar, double clipPar)
{
    const double s = p.scale / 100.0;
    const double theta = p.rotation * std::numbers::pi / 180.0;
    return Affine::scale(1.0 / sequencePar, 1.0) *
           Affine::translate(p.position.x * sequencePar, p.position.y) * Affine::rotate(theta) *
           Affine::scale(s, s) * Affine::translate(-p.anchorPoint.x * clipPar, -p.anchorPoint.y) *
           Affine::scale(clipPar, 1.0);
}

std::vector<double> motionSampleTimes(const MotionParams& p, double frameTime, double frameDuration)
{
    if (!p.motionBlur || p.shutterAngle <= 0.0 || frameDuration <= 0.0) return {frameTime};
    const int n = std::clamp(p.motionBlurSamples, 1, kMaxMotionSamples);
    const double open = frameTime + frameDuration * p.shutterPhase / 360.0;
    const double span = frameDuration * p.shutterAngle / 360.0;
    std::vector<double> times(static_cast<std::size_t>(n));
    for (int k = 0; k < n; ++k) times[static_cast<std::size_t>(k)] = open + span * (k + 0.5) / n;
    return times;
}

}  // namespace vkf::motion
