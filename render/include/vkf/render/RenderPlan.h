#pragma once

#include <cstddef>
#include <cstdint>
#include <span>

#include "vkf/core/Math.h"
#include "vkf/motion/MotionSchema.h"

// Everything a backend needs to render one Motion frame. RenderPlan is a
// plain struct uploaded byte-for-byte to GPU backends; its layout is mirrored
// in render/shaders/motion.metal and render/shaders/motion.comp. All sampling
// decisions (filter, supersample count, footprint) are made here, once, so
// every backend produces the same image.
namespace vkf::render {

struct alignas(16) Int4 {
    std::int32_t x = 0, y = 0, z = 0, w = 0;
};

struct alignas(16) Float4 {
    float x = 0.f, y = 0.f, z = 0.f, w = 0.f;
};

enum class Filter : std::int32_t { Bilinear = 0, Bicubic = 1 };

enum PlanFlags : std::int32_t {
    kFlagUnpremultipliedSource = 1 << 0,  // premultiply on fetch, unpremultiply on store
};

inline constexpr int kMaxSupersample = 8;

struct RenderPlan {
    Int4 srcRect;    // x1, y1, x2, y2: source texels that exist; others read as 0
    Int4 window;     // x1, y1, x2, y2: destination pixels to write
    Int4 srcLayout;  // GPU only: bounds origin x, origin y, row stride (floats), base offset (floats)
    Int4 dstLayout;  // GPU only: same for the destination buffer
    Int4 counts;     // matrix count, supersample n, filter, flags
    Float4 params;   // opacity (0..1), anti-flicker (0..1), anti-flicker step (dst px), sample divisor
    // Destination-pixel -> source-pixel affine per motion sample:
    // matrices[2k] = (a, b, tx, 0), matrices[2k+1] = (c, d, ty, 0).
    Float4 matrices[2 * motion::kMaxMotionSamples];

    int matrixCount() const { return counts.x; }
    int supersample() const { return counts.y; }
    Filter filter() const { return static_cast<Filter>(counts.z); }
    bool unpremultipliedSource() const { return (counts.w & kFlagUnpremultipliedSource) != 0; }
};

static_assert(offsetof(RenderPlan, srcRect) == 0);
static_assert(offsetof(RenderPlan, window) == 16);
static_assert(offsetof(RenderPlan, srcLayout) == 32);
static_assert(offsetof(RenderPlan, dstLayout) == 48);
static_assert(offsetof(RenderPlan, counts) == 64);
static_assert(offsetof(RenderPlan, params) == 80);
static_assert(offsetof(RenderPlan, matrices) == 96);
static_assert(sizeof(RenderPlan) == 96 + 32 * motion::kMaxMotionSamples);

struct PlanInputs {
    // Invertible destination->source matrices, one per motion sample.
    std::span<const Affine> dstToSrc;
    // Total motion samples including singular (invisible) ones; >= dstToSrc.size().
    int totalSamples = 1;
    double opacity = 1.0;           // 0..1
    double antiFlicker = 0.0;       // 0..1
    double antiFlickerStep = 1.0;   // destination pixels per full-resolution pixel (vertical)
    motion::Quality quality = motion::Quality::High;
    bool sourcePremultiplied = true;
    RectI srcBounds;
    RectI window;
};

// Throws std::invalid_argument for more than kMaxMotionSamples matrices or
// totalSamples < dstToSrc.size().
RenderPlan makePlan(const PlanInputs& in);

// Supersample count used for High quality: how many source pixels one
// destination pixel covers along its longest axis, clamped to [1, 8].
int supersampleCount(std::span<const Affine> dstToSrc);

// Source region read when rendering `dstRect` (the region of interest):
// destination footprint mapped to source space plus the filter radius.
Rect sourceFootprint(std::span<const Affine> dstToSrc, const Rect& dstRect, motion::Quality quality,
                     double antiFlicker, double antiFlickerStep);

}  // namespace vkf::render
