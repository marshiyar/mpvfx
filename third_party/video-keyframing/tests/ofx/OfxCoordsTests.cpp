#include <gtest/gtest.h>

#include "OfxCoords.h"

using namespace vkf;
using namespace vkf::ofx;
using motion::MotionParams;

namespace {

void expectNear(Vec2 a, Vec2 b, double eps = 1e-9)
{
    EXPECT_NEAR(a.x, b.x, eps);
    EXPECT_NEAR(a.y, b.y, eps);
}

const ProjectFrame kHd{{0, 0}, {1920, 1080}, 1.0};

// Host-side values: Position and Anchor Point in canonical coordinates.
MotionParams hostDefaults(const ProjectFrame& f)
{
    MotionParams p;
    p.position = p.anchorPoint = f.offset + f.size * 0.5;
    return p;
}

}  // namespace

TEST(OfxCoords, CanonicalCoreRoundTripAndOrientation)
{
    const ProjectFrame f{{100, 50}, {1920, 1080}, 2.0};
    expectNear(canonicalToCore(f).apply({100, 1130}), {0, 0});        // top-left
    expectNear(canonicalToCore(f).apply({100 + 1920, 50}), {960, 1080});  // bottom-right, PAR 2
    const Affine rt = coreToCanonical(f) * canonicalToCore(f);
    EXPECT_TRUE(rt.isIdentity(1e-12));
}

TEST(OfxCoords, DefaultsAreIdentity)
{
    const MotionParams core = toCore(hostDefaults(kHd), kHd);
    EXPECT_TRUE(canonicalTransform(core, kHd).isIdentity(1e-9));
    const auto m = dstPixelToSrcPixel(core, kHd, {{0.5, 0.5}, 1.0}, {{0.5, 0.5}, 1.0});
    ASSERT_TRUE(m.has_value());
    EXPECT_TRUE(m->isIdentity(1e-9));
}

TEST(OfxCoords, PositionMovesImageInCanonicalDirections)
{
    MotionParams host = hostDefaults(kHd);
    host.position = host.position + Vec2{10, 20};  // canonical: right and up
    const Affine c = canonicalTransform(toCore(host, kHd), kHd);
    expectNear(c.apply({0, 0}), {10, 20});
}

TEST(OfxCoords, RotationIsClockwiseOnScreen)
{
    MotionParams host = hostDefaults(kHd);
    host.rotation = 90.0;
    const Affine c = canonicalTransform(toCore(host, kHd), kHd);
    // A point right of the anchor ends up below it (canonical y decreases).
    expectNear(c.apply(host.anchorPoint + Vec2{100, 0}), host.anchorPoint + Vec2{0, -100});
}

TEST(OfxCoords, ScaleAroundAnchorAtHalfRenderScale)
{
    MotionParams host = hostDefaults(kHd);
    host.scale = 200.0;
    const MotionParams core = toCore(host, kHd);
    const auto m = dstPixelToSrcPixel(core, kHd, {{0.5, 0.5}, 1.0}, {{0.5, 0.5}, 1.0});
    ASSERT_TRUE(m.has_value());
    // Output pixel at the anchor (480, 270 at half res) reads the anchor; 20
    // output pixels to the right read 10 source pixels to the right.
    expectNear(m->apply({480, 270}), {480, 270});
    expectNear(m->apply({500, 270}), {490, 270});
}

TEST(OfxCoords, SingularScaleHasNoInverse)
{
    MotionParams host = hostDefaults(kHd);
    host.scale = 0.0;
    EXPECT_FALSE(dstPixelToSrcPixel(toCore(host, kHd), kHd, {}, {}).has_value());
}

TEST(OfxCoords, AnamorphicRotationIsDoneInSquareUnits)
{
    const ProjectFrame f{{0, 0}, {1920, 1080}, 2.0};  // canonical width 1920 = 960 pixels
    MotionParams host = hostDefaults(f);
    host.rotation = 90.0;
    const Affine c = canonicalTransform(toCore(host, f), f);
    // In canonical (square) units a 90 degree rotation preserves distances.
    expectNear(c.apply(host.anchorPoint + Vec2{100, 0}), host.anchorPoint + Vec2{0, -100});
}
