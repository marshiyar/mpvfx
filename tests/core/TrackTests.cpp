#include <gtest/gtest.h>

#include <cmath>

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
