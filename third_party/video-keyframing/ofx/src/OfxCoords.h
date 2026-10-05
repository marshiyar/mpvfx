#pragma once

#include <optional>

#include "vkf/core/Math.h"
#include "vkf/motion/MotionParams.h"

// The single place where OpenFX coordinates meet core coordinates. Kept free
// of OFX types so it can be unit tested without a host.
//
//   OFX canonical: full-resolution, pixel-aspect corrected (square) units,
//                  y up, origin wherever the host puts it.
//   OFX pixel:     image pixels at the current render scale, y up.
//   core:          sequence pixels (not aspect corrected), y down, origin at
//                  the top-left of the project frame (see MotionParams).
//
// In OFX the host has already placed the source in the project frame, so clip
// space and sequence space are both the project frame.
namespace vkf::ofx {

struct ProjectFrame {
    Vec2 offset;         // canonical origin of the project (bottom-left)
    Vec2 size;           // canonical size of the project
    double par = 1.0;    // project pixel aspect ratio
};

struct PixelSpace {
    Vec2 renderScale{1.0, 1.0};
    double par = 1.0;    // pixel aspect ratio of the image
};

Affine canonicalToCore(const ProjectFrame& f);
Affine coreToCanonical(const ProjectFrame& f);
Affine pixelToCanonical(const PixelSpace& s);
Affine canonicalToPixel(const PixelSpace& s);

// Converts parameter values as the host stores them (canonical Position and
// Anchor Point) into core MotionParams. Other fields are copied unchanged.
motion::MotionParams toCore(const motion::MotionParams& canonicalValues, const ProjectFrame& f);

// Forward transform in canonical space: source canonical -> output canonical.
Affine canonicalTransform(const motion::MotionParams& core, const ProjectFrame& f);

// Output pixel -> source pixel mapping used for rendering. nullopt when the
// transform is singular (Scale 0): that motion sample contributes nothing.
std::optional<Affine> dstPixelToSrcPixel(const motion::MotionParams& core, const ProjectFrame& f,
                                         const PixelSpace& dst, const PixelSpace& src);

}  // namespace vkf::ofx
