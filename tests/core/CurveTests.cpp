#include <gtest/gtest.h>

#include <cmath>
#include <limits>
#include <vector>

#include "vkf/anim/Curve.h"

using namespace vkf;
using namespace vkf::anim;

namespace {

Keyframe1D key(double seconds, double value, Interp in = Interp::Linear, Interp out = Interp::Linear)
{
    Keyframe1D k;
    k.time = Time(static_cast<std::int64_t>(std::llround(seconds * 1000)), 1000);
    k.value = value;
    k.inInterp = in;
    k.outInterp = out;
    return k;
}

Keyframe2D key2(double seconds, Vec2 value, Spatial spatial = Spatial::Linear)
{
    Keyframe2D k;
    k.time = Time(static_cast<std::int64_t>(std::llround(seconds * 1000)), 1000);
    k.value = value;
    k.spatial = spatial;
    return k;
}

double derivative(const Curve1D& c, double t, double h = 1e-6)
{
    return (c.evaluate(t + h) - c.evaluate(t - h)) / (2.0 * h);
}

}  // namespace

TEST(Curve1D, EmptyReturnsDefault)
{
    Curve1D c(42.0);
    EXPECT_FALSE(c.isAnimated());
    EXPECT_EQ(c.evaluate(-5.0), 42.0);
    EXPECT_EQ(c.evaluate(5.0), 42.0);
}

TEST(Curve1D, SingleKeyIsConstant)
{
    Curve1D c;
    c.setKey(key(1.0, 7.0));
    EXPECT_EQ(c.evaluate(0.0), 7.0);
    EXPECT_EQ(c.evaluate(1.0), 7.0);
    EXPECT_EQ(c.evaluate(9.0), 7.0);
}

TEST(Curve1D, LinearAndClampedOutsideRange)
{
    Curve1D c;
    c.setKey(key(2.0, 20.0));
    c.setKey(key(0.0, 0.0));  // out of order on purpose
    ASSERT_EQ(c.keys().size(), 2u);
    EXPECT_EQ(c.keys()[0].value, 0.0);
    EXPECT_DOUBLE_EQ(c.evaluate(0.5), 5.0);
    EXPECT_DOUBLE_EQ(c.evaluate(1.0), 10.0);
    EXPECT_EQ(c.evaluate(-1.0), 0.0);
    EXPECT_EQ(c.evaluate(3.0), 20.0);
    EXPECT_EQ(c.evaluate(2.0), 20.0);
}

TEST(Curve1D, SetKeyReplacesAndRemoveKeyWorks)
{
    Curve1D c;
    c.setKey(key(0.0, 0.0));
    c.setKey(key(1.0, 10.0));
    c.setKey(key(1.0, 30.0));
    ASSERT_EQ(c.keys().size(), 2u);
    EXPECT_DOUBLE_EQ(c.evaluate(0.5), 15.0);
    EXPECT_TRUE(c.removeKey(Time(1, 1)));
    EXPECT_FALSE(c.removeKey(Time(1, 1)));
    EXPECT_EQ(c.evaluate(0.5), 0.0);
}

TEST(Curve1D, HoldOutAndHoldIn)
{
    Curve1D out;
    out.setKey(key(0.0, 1.0, Interp::Linear, Interp::Hold));
    out.setKey(key(1.0, 5.0));
    EXPECT_EQ(out.evaluate(0.999), 1.0);
    EXPECT_EQ(out.evaluate(1.0), 5.0);

    Curve1D in;
    in.setKey(key(0.0, 1.0));
    in.setKey(key(1.0, 5.0, Interp::Hold, Interp::Linear));
    EXPECT_EQ(in.evaluate(0.5), 1.0);
    EXPECT_EQ(in.evaluate(1.0), 5.0);
}

TEST(Curve1D, BezierWithLinearHandlesIsLinear)
{
    Curve1D c;
    Keyframe1D a = key(0.0, 0.0, Interp::Linear, Interp::Bezier);
    Keyframe1D b = key(2.0, 10.0, Interp::Bezier, Interp::Linear);
    a.outEase = {5.0, 1.0 / 3.0};
    b.inEase = {5.0, 1.0 / 3.0};
    c.setKey(a);
    c.setKey(b);
    for (double t : {0.1, 0.5, 1.0, 1.7, 1.99}) EXPECT_NEAR(c.evaluate(t), 5.0 * t, 1e-9) << t;
}

TEST(Curve1D, EaseInOutIsSymmetricAndSlowAtEnds)
{
    Curve1D c;
    Keyframe1D a = key(0.0, 0.0);
    Keyframe1D b = key(1.0, 100.0);
    easeOut(a);
    easeIn(b);
    c.setKey(a);
    c.setKey(b);
    EXPECT_NEAR(c.evaluate(0.5), 50.0, 1e-9);
    EXPECT_NEAR(c.evaluate(0.25) + c.evaluate(0.75), 100.0, 1e-9);
    EXPECT_LT(c.evaluate(0.1), 10.0);  // slower than linear at the start
    EXPECT_NEAR(derivative(c, 1e-4, 1e-5), 0.0, 1.0);
    for (double t = 0.0; t < 1.0; t += 0.01) EXPECT_LE(c.evaluate(t), c.evaluate(t + 0.01) + 1e-12);
}

TEST(Curve1D, AutoBezierUsesNeighbourSlope)
{
    Curve1D c;
    c.setKey(key(0.0, 0.0, Interp::AutoBezier, Interp::AutoBezier));
    c.setKey(key(1.0, 10.0, Interp::AutoBezier, Interp::AutoBezier));
    c.setKey(key(3.0, 0.0, Interp::AutoBezier, Interp::AutoBezier));
    // Centred slope at the middle key: (0 - 0) / 3 = 0, from both sides.
    EXPECT_NEAR(derivative(c, 1.0 - 1e-4, 1e-5), 0.0, 1e-2);
    EXPECT_NEAR(derivative(c, 1.0 + 1e-4, 1e-5), 0.0, 1e-2);
    EXPECT_NEAR(c.evaluate(1.0), 10.0, 1e-12);
}

TEST(Curve1D, ContinuousBezierHasMatchingSpeeds)
{
    Curve1D c;
    Keyframe1D mid = key(1.0, 10.0, Interp::ContinuousBezier, Interp::ContinuousBezier);
    mid.outEase = {3.0, 0.5};
    mid.inEase = {-99.0, 0.25};  // in speed ignored: shared with out
    c.setKey(key(0.0, 0.0));
    c.setKey(mid);
    c.setKey(key(2.0, 12.0));
    EXPECT_NEAR(derivative(c, 1.0 - 1e-4, 1e-5), 3.0, 1e-2);
    EXPECT_NEAR(derivative(c, 1.0 + 1e-4, 1e-5), 3.0, 1e-2);
}

TEST(Curve1D, ExtremeInfluenceStaysWellDefined)
{
    Curve1D c;
    Keyframe1D a = key(0.0, 0.0, Interp::Linear, Interp::Bezier);
    Keyframe1D b = key(1.0, 1.0, Interp::Bezier, Interp::Linear);
    a.outEase = {0.0, 5.0};   // clamped to 1
    b.inEase = {0.0, -1.0};   // clamped to 0
    c.setKey(a);
    c.setKey(b);
    double prev = 0.0;
    for (double t = 0.0; t <= 1.0; t += 0.001) {
        const double v = c.evaluate(t);
        ASSERT_TRUE(std::isfinite(v));
        EXPECT_GE(v, prev - 1e-9);
        prev = v;
    }
    EXPECT_NEAR(c.evaluate(1.0), 1.0, 1e-12);
}

TEST(Curve2D, LinearPathMidpoint)
{
    Curve2D c;
    c.setKey(key2(0.0, {0, 0}));
    c.setKey(key2(1.0, {100, 50}));
    const Vec2 m = c.evaluate(0.5);
    EXPECT_NEAR(m.x, 50.0, 1e-9);
    EXPECT_NEAR(m.y, 25.0, 1e-9);
    EXPECT_NEAR(c.segmentLength(0), std::hypot(100.0, 50.0), 1e-9);
}

TEST(Curve2D, EmptyAndSingle)
{
    Curve2D c({3, 4});
    EXPECT_EQ(c.evaluate(1.0), (Vec2{3, 4}));
    c.setKey(key2(1.0, {7, 8}));
    EXPECT_EQ(c.evaluate(0.0), (Vec2{7, 8}));
    EXPECT_EQ(c.evaluate(5.0), (Vec2{7, 8}));
}

TEST(Curve2D, AutoBezierPassesThroughKeys)
{
    Curve2D c;
    c.setKey(key2(0.0, {0, 0}, Spatial::AutoBezier));
    c.setKey(key2(1.0, {100, 100}, Spatial::AutoBezier));
    c.setKey(key2(2.0, {200, 0}, Spatial::AutoBezier));
    for (double t : {0.0, 1.0, 2.0}) {
        const Vec2 p = c.evaluate(t);
        const Vec2 k = c.keys()[static_cast<std::size_t>(t)].value;
        EXPECT_NEAR(p.x, k.x, 1e-9);
        EXPECT_NEAR(p.y, k.y, 1e-9);
    }
    // Curved, so longer than the straight chords.
    EXPECT_GT(c.segmentLength(0), std::hypot(100.0, 100.0));
}

TEST(Curve2D, LinearTemporalMeansConstantSpeedAlongCurvedPath)
{
    Curve2D c;
    Keyframe2D a = key2(0.0, {0, 0}, Spatial::Bezier);
    Keyframe2D b = key2(1.0, {100, 0}, Spatial::Bezier);
    a.outTangent = {0, 120};
    b.inTangent = {0, 120};
    c.setKey(a);
    c.setKey(b);
    const int steps = 50;
    const double expected = c.segmentLength(0) / steps;
    Vec2 prev = c.evaluate(0.0);
    for (int i = 1; i <= steps; ++i) {
        const Vec2 p = c.evaluate(static_cast<double>(i) / steps);
        EXPECT_NEAR(length(p - prev), expected, expected * 2e-3) << i;
        prev = p;
    }
}

TEST(Curve2D, EasingChangesSpeedNotPath)
{
    Curve2D linear, eased;
    Keyframe2D a = key2(0.0, {0, 0}, Spatial::Bezier);
    Keyframe2D b = key2(1.0, {100, 0}, Spatial::Bezier);
    a.outTangent = {30, 80};
    b.inTangent = {-30, 80};
    linear.setKey(a);
    linear.setKey(b);
    easeOut(a);
    easeIn(b);
    eased.setKey(a);
    eased.setKey(b);

    std::vector<Vec2> path;
    for (int i = 0; i <= 4000; ++i) path.push_back(linear.evaluate(i / 4000.0));
    for (double t : {0.1, 0.3, 0.5, 0.8}) {
        const Vec2 p = eased.evaluate(t);
        double best = std::numeric_limits<double>::max();
        for (const Vec2& q : path) best = std::min(best, length(p - q));
        EXPECT_LT(best, 0.1) << t;
    }
    // Ease out: covers less distance early than the linear version.
    EXPECT_LT(length(eased.evaluate(0.1)), length(linear.evaluate(0.1)));
}

TEST(Curve2D, Hold)
{
    Curve2D c;
    Keyframe2D a = key2(0.0, {0, 0});
    a.outInterp = Interp::Hold;
    c.setKey(a);
    c.setKey(key2(1.0, {10, 10}));
    EXPECT_EQ(c.evaluate(0.5), (Vec2{0, 0}));
    EXPECT_EQ(c.evaluate(1.0), (Vec2{10, 10}));
}
