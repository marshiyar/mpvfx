#include "vkf/anim/CubicPath.h"

#include <algorithm>
#include <array>
#include <cmath>

namespace vkf::anim {

namespace {

constexpr int kLutSize = 32;

// 5-point Gauss-Legendre nodes / weights on [-1, 1].
constexpr std::array<double, 5> kGaussX = {-0.9061798459386640, -0.5384693101056831, 0.0,
                                           0.5384693101056831, 0.9061798459386640};
constexpr std::array<double, 5> kGaussW = {0.2369268850561891, 0.4786286704993665, 0.5688888888888889,
                                           0.4786286704993665, 0.2369268850561891};

double arcLength(const CubicPath& path, double u0, double u1)
{
    const double half = 0.5 * (u1 - u0);
    const double mid = 0.5 * (u1 + u0);
    double sum = 0.0;
    for (std::size_t g = 0; g < kGaussX.size(); ++g)
        sum += kGaussW[g] * vkf::length(path.derivative(mid + half * kGaussX[g]));
    return sum * half;
}

Vec2 normalized(Vec2 v)
{
    const double l = vkf::length(v);
    return l > 1e-12 ? v / l : Vec2{};
}

}  // namespace

CubicPath::CubicPath(Vec2 p0, Vec2 p1, Vec2 p2, Vec2 p3) : p0_(p0), p1_(p1), p2_(p2), p3_(p3)
{
    cumulative_.resize(kLutSize + 1);
    cumulative_[0] = 0.0;
    for (int j = 0; j < kLutSize; ++j) {
        cumulative_[static_cast<std::size_t>(j + 1)] =
            cumulative_[static_cast<std::size_t>(j)] +
            arcLength(*this, static_cast<double>(j) / kLutSize, static_cast<double>(j + 1) / kLutSize);
    }
}

Vec2 CubicPath::point(double u) const
{
    const double v = 1.0 - u;
    return v * v * v * p0_ + 3.0 * v * v * u * p1_ + 3.0 * v * u * u * p2_ + u * u * u * p3_;
}

Vec2 CubicPath::derivative(double u) const
{
    const double v = 1.0 - u;
    return 3.0 * v * v * (p1_ - p0_) + 6.0 * v * u * (p2_ - p1_) + 3.0 * u * u * (p3_ - p2_);
}

double CubicPath::parameterAt(double s) const
{
    const double total = length();
    if (s <= 0.0 || total <= 0.0) return 0.0;
    if (s >= total) return 1.0;
    const auto it = std::upper_bound(cumulative_.begin(), cumulative_.end(), s);
    const int j = std::clamp(static_cast<int>(it - cumulative_.begin()) - 1, 0, kLutSize - 1);
    const double ua = static_cast<double>(j) / kLutSize;
    const double ub = static_cast<double>(j + 1) / kLutSize;
    const double la = cumulative_[static_cast<std::size_t>(j)];
    const double lb = cumulative_[static_cast<std::size_t>(j + 1)];
    double u = lb > la ? ua + (ub - ua) * (s - la) / (lb - la) : ua;
    for (int it2 = 0; it2 < 4; ++it2) {
        const double err = la + arcLength(*this, ua, u) - s;
        const double speed = vkf::length(derivative(u));
        if (speed < 1e-12) break;
        u = std::clamp(u - err / speed, ua, ub);
    }
    return u;
}

// Direction at an end; falls back along the control polygon when the end
// handle is degenerate (a handle placed on its own anchor).
Vec2 CubicPath::endTangent(bool atStart) const
{
    const Vec2 candidates[3] = {atStart ? p1_ - p0_ : p3_ - p2_, atStart ? p2_ - p0_ : p3_ - p1_, p3_ - p0_};
    for (const Vec2& c : candidates) {
        const Vec2 n = normalized(c);
        if (n.x != 0.0 || n.y != 0.0) return n;
    }
    return {};
}

Vec2 CubicPath::pointAtDistance(double s) const
{
    const double total = length();
    if (s < 0.0) return p0_ + endTangent(true) * s;
    if (s > total) return p3_ + endTangent(false) * (s - total);
    return point(parameterAt(s));
}

Vec2 CubicPath::tangentAtDistance(double s) const
{
    const double total = length();
    if (s <= 0.0) return endTangent(true);
    if (s >= total) return endTangent(false);
    const Vec2 t = normalized(derivative(parameterAt(s)));
    return (t.x != 0.0 || t.y != 0.0) ? t : endTangent(true);
}

}  // namespace vkf::anim
