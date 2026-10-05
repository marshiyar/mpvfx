#include "vkf/render/RenderPlan.h"

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace vkf::render {

namespace {

Int4 toInt4(const RectI& r) { return {r.x1, r.y1, r.x2, r.y2}; }

}  // namespace

int supersampleCount(std::span<const Affine> dstToSrc)
{
    double stretch = 1.0;
    for (const Affine& m : dstToSrc) stretch = std::max(stretch, maxSingularValue(m));
    // Tolerance so an exact 2x reduction asks for 2, not 3, samples.
    const double n = std::ceil(stretch - 1e-6);
    return static_cast<int>(std::clamp(n, 1.0, static_cast<double>(kMaxSupersample)));
}

RenderPlan makePlan(const PlanInputs& in)
{
    const int count = static_cast<int>(in.dstToSrc.size());
    if (count > motion::kMaxMotionSamples) throw std::invalid_argument("vkf::render::makePlan: too many samples");
    if (in.totalSamples < count || in.totalSamples < 1)
        throw std::invalid_argument("vkf::render::makePlan: invalid totalSamples");

    const bool high = in.quality == motion::Quality::High;
    const int n = high ? supersampleCount(in.dstToSrc) : 1;

    RenderPlan plan{};
    plan.srcRect = toInt4(in.srcBounds);
    plan.window = toInt4(in.window);
    plan.counts = {count, n, static_cast<std::int32_t>(high ? Filter::Bicubic : Filter::Bilinear),
                   in.sourcePremultiplied ? 0 : kFlagUnpremultipliedSource};
    plan.params = {static_cast<float>(std::clamp(in.opacity, 0.0, 1.0)),
                   static_cast<float>(std::clamp(in.antiFlicker, 0.0, 1.0)),
                   static_cast<float>(in.antiFlickerStep),
                   static_cast<float>(in.totalSamples) * static_cast<float>(n * n)};
    for (int k = 0; k < count; ++k) {
        const Affine& m = in.dstToSrc[static_cast<std::size_t>(k)];
        plan.matrices[2 * k] = {static_cast<float>(m.a), static_cast<float>(m.b), static_cast<float>(m.tx), 0.f};
        plan.matrices[2 * k + 1] = {static_cast<float>(m.c), static_cast<float>(m.d), static_cast<float>(m.ty), 0.f};
    }
    return plan;
}

Rect sourceFootprint(std::span<const Affine> dstToSrc, const Rect& dstRect, motion::Quality quality,
                     double antiFlicker, double antiFlickerStep)
{
    if (dstRect.empty()) return {};
    // Supersamples stay inside each destination pixel; anti-flicker taps reach
    // one step above and below.
    const double dy = antiFlicker > 0.0 ? std::abs(antiFlickerStep) : 0.0;
    const Rect reach{dstRect.x1, dstRect.y1 - dy, dstRect.x2, dstRect.y2 + dy};
    // Bilinear reads texels within 1 pixel of the sample point, bicubic within 2.
    const double radius = quality == motion::Quality::High ? 2.0 : 1.0;
    Rect out{};
    for (const Affine& m : dstToSrc) {
        const Rect r = transformBounds(m, reach);
        out = unite(out, Rect{r.x1 - radius, r.y1 - radius, r.x2 + radius, r.y2 + radius});
    }
    return out;
}

}  // namespace vkf::render
