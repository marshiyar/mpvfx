#include "vkf/anim/Temporal.h"

#include <algorithm>
#include <cmath>

namespace vkf::anim::detail {

namespace {

constexpr double kThird = 1.0 / 3.0;

struct Handle {
    double speed;
    double influence;
};

double segmentSlope(std::span<const TemporalKey> k, int i)
{
    const double dt = k[i + 1].t - k[i].t;
    return dt > 0.0 ? (k[i + 1].v - k[i].v) / dt : 0.0;
}

// AutoBezier speed at key j: centred difference, one-sided at the ends.
double autoSpeed(std::span<const TemporalKey> k, int j)
{
    const int n = static_cast<int>(k.size());
    const int lo = std::max(j - 1, 0);
    const int hi = std::min(j + 1, n - 1);
    const double dt = k[hi].t - k[lo].t;
    return dt > 0.0 ? (k[hi].v - k[lo].v) / dt : 0.0;
}

Handle outHandle(std::span<const TemporalKey> k, int i)
{
    const TemporalKey& key = k[i];
    switch (key.outInterp) {
        case Interp::Bezier:
        case Interp::ContinuousBezier: return {key.outEase.speed, key.outEase.influence};
        case Interp::AutoBezier: return {autoSpeed(k, i), kThird};
        case Interp::Linear:
        case Interp::Hold: break;
    }
    return {segmentSlope(k, i), kThird};
}

Handle inHandle(std::span<const TemporalKey> k, int i)
{
    const TemporalKey& key = k[i + 1];
    switch (key.inInterp) {
        case Interp::Bezier: return {key.inEase.speed, key.inEase.influence};
        case Interp::ContinuousBezier: return {key.outEase.speed, key.inEase.influence};
        case Interp::AutoBezier: return {autoSpeed(k, i + 1), kThird};
        case Interp::Linear:
        case Interp::Hold: break;
    }
    return {segmentSlope(k, i), kThird};
}

double cubic(double p0, double p1, double p2, double p3, double u)
{
    const double v = 1.0 - u;
    return v * v * v * p0 + 3.0 * v * v * u * p1 + 3.0 * v * u * u * p2 + u * u * u * p3;
}

double cubicDerivative(double p0, double p1, double p2, double p3, double u)
{
    const double v = 1.0 - u;
    return 3.0 * v * v * (p1 - p0) + 6.0 * v * u * (p2 - p1) + 3.0 * u * u * (p3 - p2);
}

// Solve x(u) = x for a Bezier with x0 = 0, x3 = 1 and x1, x2 in [0, 1]
// (monotonic). Newton first, bisection as a guaranteed fallback.
double solveCurveParameter(double x1, double x2, double x)
{
    if (x <= 0.0) return 0.0;
    if (x >= 1.0) return 1.0;
    constexpr double kEps = 1e-12;
    double u = x;
    for (int it = 0; it < 8; ++it) {
        const double err = cubic(0.0, x1, x2, 1.0, u) - x;
        if (std::abs(err) < kEps) return u;
        const double dx = cubicDerivative(0.0, x1, x2, 1.0, u);
        if (std::abs(dx) < 1e-9) break;
        const double next = u - err / dx;
        if (next < 0.0 || next > 1.0) break;
        u = next;
    }
    double lo = 0.0, hi = 1.0;
    u = x;
    for (int it = 0; it < 100; ++it) {
        const double val = cubic(0.0, x1, x2, 1.0, u);
        if (std::abs(val - x) < kEps) break;
        (val < x ? lo : hi) = u;
        u = 0.5 * (lo + hi);
    }
    return u;
}

}  // namespace

int findSegment(std::span<const TemporalKey> keys, double t)
{
    if (keys.empty() || t < keys.front().t) return -1;
    // Last key with key.t <= t.
    const auto it = std::upper_bound(keys.begin(), keys.end(), t,
                                     [](double tt, const TemporalKey& k) { return tt < k.t; });
    return static_cast<int>(it - keys.begin()) - 1;
}

bool isHold(std::span<const TemporalKey> keys, int i)
{
    return keys[i].outInterp == Interp::Hold || keys[i + 1].inInterp == Interp::Hold;
}

double evaluateSegment(std::span<const TemporalKey> k, int i, double t)
{
    const TemporalKey& k0 = k[i];
    const TemporalKey& k1 = k[i + 1];
    const double dt = k1.t - k0.t;
    if (dt <= 0.0 || isHold(k, i)) return k0.v;
    const double x = std::clamp((t - k0.t) / dt, 0.0, 1.0);

    if (k0.outInterp == Interp::Linear && k1.inInterp == Interp::Linear) return k0.v + (k1.v - k0.v) * x;

    const Handle h0 = outHandle(k, i);
    const Handle h1 = inHandle(k, i);
    const double i0 = std::clamp(h0.influence, 0.0, 1.0);
    const double i1 = std::clamp(h1.influence, 0.0, 1.0);
    const double y1 = k0.v + h0.speed * i0 * dt;
    const double y2 = k1.v - h1.speed * i1 * dt;
    const double u = solveCurveParameter(i0, 1.0 - i1, x);
    return cubic(k0.v, y1, y2, k1.v, u);
}

double evaluate(std::span<const TemporalKey> keys, double t)
{
    const int n = static_cast<int>(keys.size());
    if (n == 0) return 0.0;
    const int i = findSegment(keys, t);
    if (i < 0) return keys.front().v;
    if (i >= n - 1) return keys.back().v;
    return evaluateSegment(keys, i, t);
}

}  // namespace vkf::anim::detail
