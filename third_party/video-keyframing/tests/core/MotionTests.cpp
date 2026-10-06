#include <gtest/gtest.h>

#include <numeric>
#include <stdexcept>

#include "vkf/motion/AnimatedMotion.h"
#include "vkf/motion/Transform.h"

using namespace vkf;
using namespace vkf::motion;

namespace {

void expectNear(Vec2 a, Vec2 b, double eps = 1e-9)
{
    EXPECT_NEAR(a.x, b.x, eps);
    EXPECT_NEAR(a.y, b.y, eps);
}

}  // namespace

TEST(MotionSchema, AccessorsCoverEveryParameter)
{
    MotionParams p = defaultParams({1920, 1080}, {1920, 1080});
    for (const ParamSpec& s : kSchema) {
        if (s.kind == ParamKind::Double2D) {
            setVec2(p, s.id, {12.5, -3.0});
            EXPECT_EQ(getVec2(p, s.id), (Vec2{12.5, -3.0})) << s.key;
            EXPECT_THROW(setScalar(p, s.id, 1.0), std::invalid_argument) << s.key;
        } else {
            const double v = s.kind == ParamKind::Double ? (s.min + s.max) * 0.5 : s.max;
            setScalar(p, s.id, v);
            EXPECT_DOUBLE_EQ(getScalar(p, s.id), v) << s.key;
            EXPECT_THROW(setVec2(p, s.id, {}), std::invalid_argument) << s.key;
        }
    }
}

TEST(MotionSchema, DefaultsComeFromSchema)
{
    const MotionParams p = defaultParams({1920, 1080}, {1280, 720});
    EXPECT_EQ(p.position, (Vec2{960, 540}));
    EXPECT_EQ(p.anchorPoint, (Vec2{640, 360}));
    for (const ParamSpec& s : kSchema)
        if (s.kind != ParamKind::Double2D) EXPECT_DOUBLE_EQ(getScalar(p, s.id), s.defaultValue) << s.key;
}

TEST(MotionSchema, SetClampsToRange)
{
    MotionParams p;
    setScalar(p, ParamId::Opacity, 150.0);
    EXPECT_EQ(p.opacity, 100.0);
    setScalar(p, ParamId::Scale, -5.0);
    EXPECT_EQ(p.scale, 0.0);
    setScalar(p, ParamId::MotionBlurSamples, 1000.0);
    EXPECT_EQ(p.motionBlurSamples, kMaxMotionSamples);
}

TEST(Transform, DefaultsAreIdentityWhenClipMatchesSequence)
{
    const MotionParams p = defaultParams({1920, 1080}, {1920, 1080});
    EXPECT_TRUE(clipToSequence(p).isIdentity(1e-12));
}

TEST(Transform, SmallerClipIsCentred)
{
    const MotionParams p = defaultParams({1920, 1080}, {640, 360});
    expectNear(clipToSequence(p).apply({0, 0}), {640, 360});
}

TEST(Transform, PositionScaleRotationAroundAnchor)
{
    MotionParams p = defaultParams({100, 100}, {100, 100});
    p.position = {60, 40};
    expectNear(clipToSequence(p).apply(p.anchorPoint), {60, 40});

    p.scale = 200.0;
    expectNear(clipToSequence(p).apply(p.anchorPoint + Vec2{10, 0}), {80, 40});

    // 90 degrees clockwise on screen (y down): right of the anchor goes below it.
    p.scale = 100.0;
    p.rotation = 90.0;
    expectNear(clipToSequence(p).apply(p.anchorPoint + Vec2{10, 0}), {60, 50});
    p.rotation = 450.0;  // extra full turn
    expectNear(clipToSequence(p).apply(p.anchorPoint + Vec2{10, 0}), {60, 50});
}

TEST(Transform, PixelAspectRatioRotatesInDisplaySpace)
{
    MotionParams p = defaultParams({100, 100}, {100, 100});
    p.rotation = 90.0;
    // PAR 2: 10 clip pixels right = 20 display units; after rotation 20 display
    // units down = 20 sequence pixels (y is not scaled by PAR).
    expectNear(clipToSequence(p, 2.0, 2.0).apply(p.anchorPoint + Vec2{10, 0}), p.position + Vec2{0, 20});
    // And 20 rows down become 20 display units left = 10 sequence pixels.
    expectNear(clipToSequence(p, 2.0, 2.0).apply(p.anchorPoint + Vec2{0, 20}), p.position + Vec2{-10, 0});
}

TEST(Transform, MotionSampleTimes)
{
    MotionParams p;
    EXPECT_EQ(motionSampleTimes(p, 1.0, 1.0 / 24.0), std::vector<double>{1.0});
    p.motionBlur = true;
    p.motionBlurSamples = 4;
    const auto times = motionSampleTimes(p, 1.0, 1.0 / 24.0);  // 180 deg, phase -90: centred
    ASSERT_EQ(times.size(), 4u);
    EXPECT_NEAR(std::accumulate(times.begin(), times.end(), 0.0) / 4.0, 1.0, 1e-12);
    EXPECT_NEAR(times.back() - times.front(), 0.5 / 24.0 * 3.0 / 4.0, 1e-12);
    p.shutterAngle = 0.0;
    EXPECT_EQ(motionSampleTimes(p, 1.0, 1.0 / 24.0).size(), 1u);
}

TEST(AnimatedMotion, EvaluatesKeyframesAndStatics)
{
    AnimatedMotion m({1920, 1080}, {1920, 1080});
    anim::Keyframe1D a, b;
    a.time = Time(0, 1);
    a.value = 100.0;
    b.time = Time(1, 1);
    b.value = 200.0;
    m.curve(ParamId::Scale).setKey(a);
    m.curve(ParamId::Scale).setKey(b);
    m.setStatic(ParamId::Quality, 0.0);

    const MotionParams p = m.evaluate(0.5);
    EXPECT_DOUBLE_EQ(p.scale, 150.0);
    EXPECT_EQ(p.quality, Quality::Draft);
    EXPECT_EQ(p.position, (Vec2{960, 540}));

    EXPECT_THROW(m.curve(ParamId::Quality), std::invalid_argument);
    EXPECT_THROW(m.curve(ParamId::Position), std::invalid_argument);
    EXPECT_THROW(m.curve2D(ParamId::Scale), std::invalid_argument);
    EXPECT_THROW(m.setStatic(ParamId::Scale, 1.0), std::invalid_argument);
}

TEST(AnimatedMotion, ValuesAreClampedToSchema)
{
    AnimatedMotion m({100, 100}, {100, 100});
    anim::Keyframe1D a;
    a.value = 250.0;
    m.curve(ParamId::Opacity).setKey(a);
    EXPECT_EQ(m.evaluate(0.0).opacity, 100.0);
}
