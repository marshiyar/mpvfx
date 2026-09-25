#include <gtest/gtest.h>

#include <cmath>
#include <string>
#include <tuple>

#include "vkf/anim/Track.h"

using namespace vkf::anim;

namespace {

TrackKey key(std::int64_t frame, double v, Segment s = Segment::Linear, CubicTiming t = {})
{
    TrackKey k;
    k.frame = frame;
    k.value = {v, 0, 0, 0};
    k.outgoing = s;
    k.timing = t;
    return k;
}

double at(const Track& t, double frame)
{
    double out[4];
    t.evaluate(frame, out);
    return out[0];
}

}  // namespace

TEST(Track, ConstantOutsideRangeAndExactAtKeys)
{
    const Track t(ValueType::Number, {key(20, 5.0), key(10, 1.0)});  // unsorted input
    EXPECT_EQ(t.keys()[0].frame, 10);
    EXPECT_EQ(at(t, 0), 1.0);
    EXPECT_EQ(at(t, 10), 1.0);
    EXPECT_EQ(at(t, 15), 3.0);
    EXPECT_EQ(at(t, 20), 5.0);
    EXPECT_EQ(at(t, 99), 5.0);
}

TEST(Track, HoldUsesStartValueUntilNextKey)
{
    const Track t(ValueType::Number, {key(0, 1.0, Segment::Hold), key(10, 9.0)});
    EXPECT_EQ(at(t, 9.999), 1.0);
    EXPECT_EQ(at(t, 10), 9.0);
}

TEST(Track, CubicTimingMatchesCssEase)
{
    // CSS "ease" = cubic-bezier(0.25, 0.1, 0.25, 1); at 50% time it is ~0.8024.
    const Track t(ValueType::Number, {key(0, 0.0, Segment::CubicBezier, {0.25, 0.1, 0.25, 1.0}), key(100, 1.0)});
    EXPECT_NEAR(at(t, 50), 0.802403387584857, 1e-12);
    // Linear control points reproduce linear.
    const Track lin(ValueType::Number, {key(0, 0.0, Segment::CubicBezier, {0.0, 0.0, 1.0, 1.0}), key(10, 10.0)});
    for (int f = 0; f <= 10; ++f) EXPECT_NEAR(at(lin, f), f, 1e-9);
}

TEST(Track, OvershootingTimingIsNotClamped)
{
    const Track t(ValueType::Number, {key(0, 0.0, Segment::CubicBezier, {0.3, 1.8, 0.7, 1.8}), key(10, 1.0)});
    EXPECT_GT(at(t, 5), 1.0);
}

TEST(Track, MultiComponentValuesShareTiming)
{
    TrackKey a = key(0, 0.0, Segment::CubicBezier, {0.42, 0.0, 0.58, 1.0});
    a.value = {0.0, 10.0, 0, 0};
    TrackKey b = key(10, 0.0);
    b.value = {100.0, 30.0, 0, 0};
    const Track t(ValueType::Vec2, {a, b});
    double out[2];
    t.evaluate(3, out);
    const double p = easeProgress(Segment::CubicBezier, {0.42, 0.0, 0.58, 1.0}, 0.3);
    EXPECT_NEAR(out[0], 100.0 * p, 1e-12);
    EXPECT_NEAR(out[1], 10.0 + 20.0 * p, 1e-12);
}

TEST(Track, FractionalFramesInterpolate)
{
    const Track t(ValueType::Number, {key(0, 0.0), key(4, 8.0)});
    EXPECT_DOUBLE_EQ(at(t, 0.5), 1.0);
}

TEST(Track, ValidationErrors)
{
    auto code = [](auto&& build) {
        try {
            build();
        } catch (const TrackValidationError& e) {
            return std::string(trackErrorCode(e.code()));
        }
        return std::string("none");
    };
    EXPECT_EQ(code([] { Track(ValueType::Number, {}); }), "empty-track");
    EXPECT_EQ(code([] { Track(ValueType::Number, {key(-1, 0)}); }), "invalid-keyframe-frame");
    EXPECT_EQ(code([] { Track(ValueType::Number, {key(1, 0), key(1, 2)}); }), "duplicate-keyframe-frame");
    EXPECT_EQ(code([] { Track(ValueType::Number, {key(1, NAN)}); }), "invalid-value");
    EXPECT_EQ(code([] {
                  TrackKey k = key(0, 0);
                  k.value = {0.5, 0.5, 1.5, 1.0};
                  Track(ValueType::Rgba, {k});
              }),
              "invalid-value");
    EXPECT_EQ(code([] { Track(ValueType::Number, {key(0, 0, Segment::CubicBezier, {1.2, 0, 0.5, 1})}); }),
              "invalid-interpolation");
    EXPECT_EQ(code([] { Track(ValueType::Number, {key(0, 0, Segment::CubicBezier, {0.2, NAN, 0.5, 1})}); }),
              "invalid-interpolation");
}

namespace {

TrackKey point(std::int64_t frame, double x, double y, PathShape shape = PathShape::Line, double curviness = 1.0)
{
    TrackKey k;
    k.frame = frame;
    k.value = {x, y, 0, 0};
    k.path.shape = shape;
    k.path.curviness = curviness;
    return k;
}

vkf::Vec2 pos(const Track& t, double frame)
{
    double out[2];
    t.evaluate(frame, out);
    return {out[0], out[1]};
}

}  // namespace

TEST(TrackPath, ZeroCurvinessIsTheStraightLine)
{
    const Track flat(ValueType::Vec2, {point(0, 0, 0, PathShape::Curve, 0.0), point(10, 100, 50, PathShape::Curve, 0.0),
                                       point(20, 100, 150)});
    for (double f : {2.5, 5.0, 13.0}) {
        const vkf::Vec2 p = pos(flat, f);
        const vkf::Vec2 expected = f <= 10 ? vkf::Vec2{10.0 * f, 5.0 * f} : vkf::Vec2{100.0, 50.0 + 10.0 * (f - 10)};
        EXPECT_NEAR(p.x, expected.x, 1e-6) << f;
        EXPECT_NEAR(p.y, expected.y, 1e-6) << f;
    }
}

TEST(TrackPath, CurveHitsEveryKeyAtItsFrameAndBulgesOffTheChord)
{
    const Track arc(ValueType::Vec2, {point(0, 0, 0, PathShape::Curve), point(10, 100, 100, PathShape::Curve),
                                      point(20, 200, 0)});
    for (auto [f, x, y] : {std::tuple{0, 0.0, 0.0}, {10, 100.0, 100.0}, {20, 200.0, 0.0}}) {
        const vkf::Vec2 p = pos(arc, f);
        EXPECT_NEAR(p.x, x, 1e-9);
        EXPECT_NEAR(p.y, y, 1e-9);
    }
    // Halfway in time is halfway along the curved first segment, which lies
    // off the straight chord y = x.
    const vkf::Vec2 mid = pos(arc, 5);
    EXPECT_GT(std::abs(mid.y - mid.x), 1.0);
}

TEST(TrackPath, LinearTimingMovesAtConstantSpeedAlongTheCurve)
{
    TrackKey a = point(0, 0, 0, PathShape::Bezier);
    a.path.cp1 = {0, 120};
    a.path.cp2 = {100, 120};
    const Track t(ValueType::Vec2, {a, point(50, 100, 0)});
    vkf::Vec2 prev = pos(t, 0);
    double first = -1.0;
    for (int f = 1; f <= 50; ++f) {
        const vkf::Vec2 p = pos(t, f);
        const double step = vkf::length(p - prev);
        if (first < 0) first = step;
        EXPECT_NEAR(step, first, first * 2e-3) << f;
        prev = p;
    }
}

TEST(TrackPath, OvershootContinuesAlongTheEndTangent)
{
    TrackKey a = point(0, 0, 0, PathShape::Curve);
    a.outgoing = Segment::CubicBezier;
    a.timing = {0.3, 1.6, 0.6, 1.4};  // overshoots past the end
    const Track t(ValueType::Vec2, {a, point(10, 100, 0), point(20, 100, 100)});
    double out[2];
    bool overshot = false;
    for (double f = 0; f < 10; f += 0.25) {
        t.evaluate(f, out);
        overshot = overshot || out[0] > 100.0;
        EXPECT_TRUE(std::isfinite(out[0]) && std::isfinite(out[1]));
    }
    EXPECT_TRUE(overshot);
}

TEST(TrackPath, TangentAngleFollowsMotionAndHoldsWhenStill)
{
    TrackKey held = point(10, 100, 0);
    held.outgoing = Segment::Hold;
    const Track t(ValueType::Vec2, {point(0, 0, 0), held, point(20, 100, 100)});
    EXPECT_NEAR(t.tangentAngle(5), 0.0, 1e-12);                  // moving right
    EXPECT_NEAR(t.tangentAngle(15), 0.0, 1e-12);                 // held: keeps last direction
    EXPECT_NEAR(t.tangentAngle(-3), 0.0, 1e-12);                 // before any key: first motion
    const Track down(ValueType::Vec2, {point(0, 0, 0), point(10, 0, 50)});
    EXPECT_NEAR(down.tangentAngle(5), std::acos(0.0), 1e-12);   // +y (down on screen) = +90 deg
    EXPECT_NEAR(down.tangentAngle(99), std::acos(0.0), 1e-12);  // after the end: last motion
    EXPECT_TRUE(std::isnan(Track(ValueType::Vec2, {point(0, 5, 5)}).tangentAngle(0)));
    EXPECT_TRUE(std::isnan(Track(ValueType::Number, {key(0, 1), key(5, 2)}).tangentAngle(2)));
}

TEST(TrackPath, CurvedTangentIsTheCurveDirection)
{
    TrackKey a = point(0, 0, 0, PathShape::Bezier);
    a.path.cp1 = {0, 100};
    a.path.cp2 = {100, 100};
    const Track t(ValueType::Vec2, {a, point(10, 100, 0)});
    EXPECT_NEAR(t.tangentAngle(0), std::acos(0.0), 1e-9);  // starts heading straight down (+y)
    EXPECT_NEAR(t.tangentAngle(10), -std::acos(0.0), 1e-9);  // ends heading up (-y)
}

TEST(TrackPath, PathValidation)
{
    auto code = [](auto&& build) {
        try {
            build();
        } catch (const TrackValidationError& e) {
            return std::string(trackErrorCode(e.code()));
        }
        return std::string("none");
    };
    EXPECT_EQ(code([] {
                  TrackKey k = key(0, 1);
                  k.path.shape = PathShape::Curve;
                  Track(ValueType::Number, {k, key(5, 2)});
              }),
              "invalid-path");
    EXPECT_EQ(code([] { Track(ValueType::Vec2, {point(0, 0, 0, PathShape::Curve, NAN), point(5, 1, 1)}); }),
              "invalid-path");
    EXPECT_EQ(code([] {
                  TrackKey k = point(0, 0, 0, PathShape::Bezier);
                  k.path.cp1 = {INFINITY, 0};
                  Track(ValueType::Vec2, {k, point(5, 1, 1)});
              }),
              "invalid-path");
}
