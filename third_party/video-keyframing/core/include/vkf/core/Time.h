#pragma once

#include <compare>
#include <cstdint>

namespace vkf {

// Exact rational time in seconds. Keyframes are stored at exact times so that
// frame N at 29.97 fps is always exactly frame N; evaluation uses double.
class Time {
public:
    constexpr Time() = default;
    // Throws std::invalid_argument when den == 0.
    Time(std::int64_t num, std::int64_t den);

    // Time of frame `frame` at `fpsNum / fpsDen` frames per second.
    static Time fromFrame(std::int64_t frame, std::int64_t fpsNum, std::int64_t fpsDen);

    constexpr std::int64_t num() const { return num_; }
    constexpr std::int64_t den() const { return den_; }
    double seconds() const { return static_cast<double>(num_) / static_cast<double>(den_); }

    friend bool operator==(const Time& a, const Time& b) { return a.num_ == b.num_ && a.den_ == b.den_; }
    friend std::strong_ordering operator<=>(const Time& a, const Time& b);

private:
    std::int64_t num_ = 0;
    std::int64_t den_ = 1;  // always > 0; num/den always reduced
};

}  // namespace vkf
