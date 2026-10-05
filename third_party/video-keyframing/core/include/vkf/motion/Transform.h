#pragma once

#include <vector>

#include "vkf/core/Math.h"
#include "vkf/motion/MotionParams.h"

namespace vkf::motion {

// Maps clip pixels to sequence pixels (both in core space: y down, origin
// top-left). Premiere order: move the anchor to the origin, scale, rotate
// clockwise, move to Position. Scale and rotation happen in square display
// units, so non-square pixel aspect ratios are honoured.
Affine clipToSequence(const MotionParams& p, double sequencePar = 1.0, double clipPar = 1.0);

// Times (in seconds) at which to evaluate parameters for motion blur of the
// frame at `frameTime`, lasting `frameDuration` seconds. Returns {frameTime}
// when motion blur is off or the shutter is closed.
std::vector<double> motionSampleTimes(const MotionParams& p, double frameTime, double frameDuration);

}  // namespace vkf::motion
