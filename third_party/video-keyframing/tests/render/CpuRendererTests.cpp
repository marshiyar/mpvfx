#include <gtest/gtest.h>

#include <array>
#include <stdexcept>
#include <vector>

#include "../support/TestImage.h"
#include "vkf/render/CpuRenderer.h"

using namespace vkf;
using namespace vkf::render;
using vkf::test::TestImage;
using motion::Quality;

namespace {

RenderPlan plan(std::vector<Affine> m, RectI src, RectI window, Quality q = Quality::High, double opacity = 1.0,
                bool premult = true, double af = 0.0, int total = 0)
{
    static std::vector<Affine> keep;  // PlanInputs holds a span
    keep = std::move(m);
    PlanInputs in;
    in.dstToSrc = keep;
    in.totalSamples = total > 0 ? total : std::max<int>(1, static_cast<int>(keep.size()));
    in.opacity = opacity;
    in.antiFlicker = af;
    in.quality = q;
    in.sourcePremultiplied = premult;
    in.srcBounds = src;
    in.window = window;
    return makePlan(in);
}

SerialExecutor serial;

}  // namespace

TEST(RenderPlan, SupersampleCount)
{
    const std::array<Affine, 1> id{Affine::identity()};
    EXPECT_EQ(supersampleCount(id), 1);
    const std::array<Affine, 1> half{Affine::scale(2, 2)};  // dst->src: shrinking by 2
    EXPECT_EQ(supersampleCount(half), 2);
    const std::array<Affine, 1> aniso{Affine::scale(1, 1.5)};
    EXPECT_EQ(supersampleCount(aniso), 2);
    const std::array<Affine, 1> tiny{Affine::scale(100, 100)};
    EXPECT_EQ(supersampleCount(tiny), kMaxSupersample);
    const std::array<Affine, 1> rot{Affine::rotate(0.7) * Affine::scale(3, 3)};
    EXPECT_EQ(supersampleCount(rot), 3);
}

TEST(RenderPlan, RejectsTooManySamples)
{
    std::vector<Affine> m(motion::kMaxMotionSamples + 1);
    PlanInputs in;
    in.dstToSrc = m;
    in.totalSamples = static_cast<int>(m.size());
    EXPECT_THROW(makePlan(in), std::invalid_argument);
    in.dstToSrc = std::span<const Affine>(m).first(2);
    in.totalSamples = 1;
    EXPECT_THROW(makePlan(in), std::invalid_argument);
}

TEST(RenderPlan, SourceFootprint)
{
    const std::array<Affine, 1> id{Affine::identity()};
    EXPECT_EQ(sourceFootprint(id, {0, 0, 10, 10}, Quality::Draft, 0.0, 1.0), (Rect{-1, -1, 11, 11}));
    EXPECT_EQ(sourceFootprint(id, {0, 0, 10, 10}, Quality::High, 0.0, 1.0), (Rect{-2, -2, 12, 12}));
    EXPECT_EQ(sourceFootprint(id, {0, 0, 10, 10}, Quality::Draft, 0.5, 2.0), (Rect{-1, -3, 11, 13}));
    const std::array<Affine, 2> two{Affine::identity(), Affine::translate(100, 0)};
    EXPECT_EQ(sourceFootprint(two, {0, 0, 10, 10}, Quality::Draft, 0.0, 1.0), (Rect{-1, -1, 111, 11}));
}

class CpuFormats : public ::testing::TestWithParam<std::tuple<PixelType, int, Quality>> {};

TEST_P(CpuFormats, IdentityIsExactCopy)
{
    const auto [type, comps, quality] = GetParam();
    const RectI r{-3, 2, 29, 19};
    TestImage src(r, type, comps), dst(r, type, comps);
    src.fillRandom(7);
    renderCpu(plan({Affine::identity()}, r, r, quality), src.view, dst.view, serial);
    EXPECT_TRUE(dst.rowsEqual(src, r));
}

TEST_P(CpuFormats, IntegerTranslationIsExact)
{
    const auto [type, comps, quality] = GetParam();
    const RectI r{0, 0, 32, 24};
    TestImage src(r, type, comps), dst(r, type, comps);
    src.fillRandom(11);
    // Output pixel (x, y) shows source pixel (x - 3, y + 2).
    renderCpu(plan({Affine::translate(-3, 2)}, r, r, quality), src.view, dst.view, serial);
    const std::size_t px = static_cast<std::size_t>(comps * bytesPerComponent(type));
    for (int y = 0; y < 22; ++y)
        for (int x = 3; x < 32; ++x)
            ASSERT_EQ(std::memcmp(dst.view.pixel(x, y), src.view.pixel(x - 3, y + 2), px), 0) << x << "," << y;
    // Uncovered area is transparent / black.
    for (int c = 0; c < comps * bytesPerComponent(type); ++c) EXPECT_EQ(dst.view.pixel(0, 0)[c], std::byte{0});
}

INSTANTIATE_TEST_SUITE_P(All, CpuFormats,
                         ::testing::Combine(::testing::Values(PixelType::U8, PixelType::U16, PixelType::F32),
                                            ::testing::Values(1, 3, 4),
                                            ::testing::Values(Quality::Draft, Quality::High)));

TEST(CpuRenderer, BilinearHalfPixelAveragesNeighbours)
{
    const RectI r{0, 0, 4, 1};
    TestImage src(r, PixelType::F32, 4), dst(r, PixelType::F32, 4);
    for (int x = 0; x < 4; ++x)
        for (int c = 0; c < 4; ++c) src.f(x, 0)[c] = static_cast<float>(x) * 0.25f;
    renderCpu(plan({Affine::translate(0.5, 0)}, r, r, Quality::Draft), src.view, dst.view, serial);
    EXPECT_FLOAT_EQ(dst.f(0, 0)[0], 0.125f);
    EXPECT_FLOAT_EQ(dst.f(2, 0)[3], 0.625f);
    EXPECT_FLOAT_EQ(dst.f(3, 0)[3], 0.375f);  // half of the last texel, half transparent
}

TEST(CpuRenderer, OpacityScalesPremultipliedPixels)
{
    const RectI r{0, 0, 8, 8};
    TestImage src(r, PixelType::F32, 4), dst(r, PixelType::F32, 4);
    src.fillRandom(3);
    renderCpu(plan({Affine::identity()}, r, r, Quality::High, 0.5), src.view, dst.view, serial);
    for (int c = 0; c < 4; ++c) EXPECT_FLOAT_EQ(dst.f(4, 5)[c], 0.5f * src.f(4, 5)[c]);
}

TEST(CpuRenderer, TilesMatchFullRenderBitForBit)
{
    const RectI src{0, 0, 64, 48};
    const RectI out{-10, -10, 90, 70};
    TestImage in(src, PixelType::F32, 4), full(out, PixelType::F32, 4), tiled(out, PixelType::F32, 4);
    in.fillRandom(5);
    const Affine m = (Affine::translate(31, 20) * Affine::rotate(0.4) * Affine::scale(0.7, 0.7) *
                      Affine::translate(-40, -30)).inverse().value();
    const Affine m2 = Affine::translate(1.3, -0.4) * m;
    renderCpu(plan({m, m2}, src, out, Quality::High, 0.8, true, 0.3), in.view, full.view, serial);
    for (int ty = out.y1; ty < out.y2; ty += 17)
        for (int tx = out.x1; tx < out.x2; tx += 23) {
            const RectI w = intersect(RectI{tx, ty, tx + 23, ty + 17}, out);
            renderCpu(plan({m, m2}, src, w, Quality::High, 0.8, true, 0.3), in.view, tiled.view, serial);
        }
    EXPECT_TRUE(full.rowsEqual(tiled, out));
}

TEST(CpuRenderer, ThreadedMatchesSerialBitForBit)
{
    const RectI r{0, 0, 97, 61};
    TestImage in(r, PixelType::F32, 4), a(r, PixelType::F32, 4), b(r, PixelType::F32, 4);
    in.fillRandom(9);
    const Affine m = (Affine::rotate(1.1) * Affine::scale(0.3, 0.3)).inverse().value();
    ThreadExecutor threads(7);
    renderCpu(plan({m}, r, r), in.view, a.view, serial);
    renderCpu(plan({m}, r, r), in.view, b.view, threads);
    EXPECT_TRUE(a.rowsEqual(b, r));
}

TEST(CpuRenderer, NegativeRowBytes)
{
    const RectI r{0, 0, 20, 15};
    TestImage topDown(r, PixelType::F32, 4), bottomUp(r, PixelType::F32, 4, true);
    topDown.fillRandom(21);
    for (int y = r.y1; y < r.y2; ++y)
        std::memcpy(bottomUp.view.pixel(0, y), topDown.view.pixel(0, y), 20 * 16);
    TestImage outA(r, PixelType::F32, 4), outB(r, PixelType::F32, 4, true);
    const Affine m = Affine::translate(0.37, -1.6) * Affine::rotate(0.2);
    renderCpu(plan({m}, r, r), topDown.view, outA.view, serial);
    renderCpu(plan({m}, r, r), bottomUp.view, outB.view, serial);
    EXPECT_TRUE(outA.rowsEqual(outB, r));
}

TEST(CpuRenderer, UnpremultipliedSourceDoesNotBleedHiddenColour)
{
    const RectI r{0, 0, 2, 1};
    TestImage src(r, PixelType::F32, 4), dst(r, PixelType::F32, 4);
    const float red[4] = {1, 0, 0, 0.5f};
    const float hiddenGreen[4] = {0, 1, 0, 0};  // straight alpha: colour invisible
    std::memcpy(src.f(0, 0), red, sizeof red);
    std::memcpy(src.f(1, 0), hiddenGreen, sizeof hiddenGreen);
    renderCpu(plan({Affine::translate(0.5, 0)}, r, r, Quality::Draft, 1.0, false), src.view, dst.view, serial);
    EXPECT_FLOAT_EQ(dst.f(0, 0)[0], 1.0f);
    EXPECT_FLOAT_EQ(dst.f(0, 0)[1], 0.0f);
    EXPECT_FLOAT_EQ(dst.f(0, 0)[3], 0.25f);
}

TEST(CpuRenderer, MotionSamplesAverage)
{
    const RectI r{0, 0, 8, 1};
    TestImage src(r, PixelType::F32, 1), dst(r, PixelType::F32, 1);
    src.f(4, 0)[0] = 1.0f;
    renderCpu(plan({Affine::identity(), Affine::translate(1, 0)}, r, r, Quality::Draft), src.view, dst.view, serial);
    EXPECT_FLOAT_EQ(dst.f(4, 0)[0], 0.5f);
    EXPECT_FLOAT_EQ(dst.f(3, 0)[0], 0.5f);
    EXPECT_FLOAT_EQ(dst.f(5, 0)[0], 0.0f);
}

TEST(CpuRenderer, SingularSamplesFadeAndAllSingularIsTransparent)
{
    const RectI r{0, 0, 4, 4};
    TestImage src(r, PixelType::F32, 1), dst(r, PixelType::F32, 1);
    src.f(1, 1)[0] = 1.0f;
    renderCpu(plan({Affine::identity()}, r, r, Quality::Draft, 1.0, true, 0.0, 4), src.view, dst.view, serial);
    EXPECT_FLOAT_EQ(dst.f(1, 1)[0], 0.25f);
    dst.f(1, 1)[0] = 9.0f;
    renderCpu(plan({}, r, r, Quality::Draft), src.view, dst.view, serial);
    EXPECT_FLOAT_EQ(dst.f(1, 1)[0], 0.0f);
}

TEST(CpuRenderer, AntiFlickerSpreadsVertically)
{
    const RectI r{0, 0, 1, 5};
    TestImage src(r, PixelType::F32, 1), dst(r, PixelType::F32, 1);
    src.f(0, 2)[0] = 1.0f;
    renderCpu(plan({Affine::identity()}, r, r, Quality::Draft, 1.0, true, 1.0), src.view, dst.view, serial);
    EXPECT_FLOAT_EQ(dst.f(0, 1)[0], 0.25f);
    EXPECT_FLOAT_EQ(dst.f(0, 2)[0], 0.5f);
    EXPECT_FLOAT_EQ(dst.f(0, 3)[0], 0.25f);
    EXPECT_FLOAT_EQ(dst.f(0, 0)[0], 0.0f);
}

TEST(CpuRenderer, RejectsInvalidInputs)
{
    const RectI r{0, 0, 4, 4};
    TestImage f(r, PixelType::F32, 4), u(r, PixelType::U8, 4), small({0, 0, 2, 2}, PixelType::F32, 4);
    EXPECT_THROW(renderCpu(plan({Affine::identity()}, r, r), f.view, u.view, serial), std::invalid_argument);
    EXPECT_THROW(renderCpu(plan({Affine::identity()}, r, r), f.view, small.view, serial), std::invalid_argument);
    EXPECT_THROW(renderCpu(plan({Affine::identity()}, {0, 0, 3, 3}, r), f.view, f.view, serial),
                 std::invalid_argument);
}
