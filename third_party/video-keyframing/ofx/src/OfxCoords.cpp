#include "OfxCoords.h"

#include "vkf/motion/Transform.h"

namespace vkf::ofx {

Affine canonicalToCore(const ProjectFrame& f)
{
    // x_core = (X - offset.x) / par ;  y_core = (offset.y + size.y) - Y
    return {1.0 / f.par, 0.0, -f.offset.x / f.par, 0.0, -1.0, f.offset.y + f.size.y};
}

Affine coreToCanonical(const ProjectFrame& f)
{
    return {f.par, 0.0, f.offset.x, 0.0, -1.0, f.offset.y + f.size.y};
}

Affine pixelToCanonical(const PixelSpace& s)
{
    return Affine::scale(s.par / s.renderScale.x, 1.0 / s.renderScale.y);
}

Affine canonicalToPixel(const PixelSpace& s)
{
    return Affine::scale(s.renderScale.x / s.par, s.renderScale.y);
}

motion::MotionParams toCore(const motion::MotionParams& canonicalValues, const ProjectFrame& f)
{
    motion::MotionParams p = canonicalValues;
    const Affine m = canonicalToCore(f);
    p.position = m.apply(canonicalValues.position);
    p.anchorPoint = m.apply(canonicalValues.anchorPoint);
    return p;
}

Affine canonicalTransform(const motion::MotionParams& core, const ProjectFrame& f)
{
    return coreToCanonical(f) * motion::clipToSequence(core, f.par, f.par) * canonicalToCore(f);
}

std::optional<Affine> dstPixelToSrcPixel(const motion::MotionParams& core, const ProjectFrame& f,
                                         const PixelSpace& dst, const PixelSpace& src)
{
    const std::optional<Affine> inv = canonicalTransform(core, f).inverse();
    if (!inv) return std::nullopt;
    return canonicalToPixel(src) * *inv * pixelToCanonical(dst);
}

}  // namespace vkf::ofx
