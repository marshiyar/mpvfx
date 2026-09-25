#include <gtest/gtest.h>

#include <cstdint>
#include <limits>
#include <stdexcept>

#include "vkf/core/Time.h"

using vkf::Time;

TEST(Time, NormalizesSignAndGcd)
{
    EXPECT_EQ(Time(2, 4), Time(1, 2));
    const Time t(1, -2);
    EXPECT_EQ(t.num(), -1);
    EXPECT_EQ(t.den(), 2);
    EXPECT_EQ(Time(0, 5), Time());
}

TEST(Time, ZeroDenominatorThrows) { EXPECT_THROW(Time(1, 0), std::invalid_argument); }

TEST(Time, OrderingIsExact)
{
    EXPECT_LT(Time(1, 3), Time(1, 2));
    EXPECT_GT(Time(-1, 3), Time(-1, 2));
    EXPECT_LT(Time(-7, 2), Time(-3, 1));
    // Values whose cross products overflow int64.
    constexpr std::int64_t big = std::numeric_limits<std::int64_t>::max();
    EXPECT_LT(Time(big - 1, big), Time(1, 1));
    EXPECT_LT(Time(big - 2, big - 1), Time(big - 1, big));
    EXPECT_GT(Time(big, big - 1), Time(1, 1));
}

TEST(Time, FrameTimesAreExact)
{
    // 29.97 fps = 30000/1001.
    EXPECT_EQ(Time::fromFrame(3, 30000, 1001), Time(3003, 30000));
    EXPECT_EQ(Time::fromFrame(30000, 30000, 1001), Time(1001, 1));
    EXPECT_DOUBLE_EQ(Time::fromFrame(37, 24, 1).seconds(), 37.0 / 24.0);
    EXPECT_THROW(Time::fromFrame(1, 0, 1), std::invalid_argument);
}
