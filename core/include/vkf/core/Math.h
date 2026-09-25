#pragma once

#include <algorithm>
#include <cmath>
#include <optional>

namespace vkf {

struct Vec2 {
    double x = 0.0;
    double y = 0.0;

    friend constexpr Vec2 operator+(Vec2 a, Vec2 b) { return {a.x + b.x, a.y + b.y}; }
    friend constexpr Vec2 operator-(Vec2 a, Vec2 b) { return {a.x - b.x, a.y - b.y}; }
    friend constexpr Vec2 operator-(Vec2 a) { return {-a.x, -a.y}; }
    friend constexpr Vec2 operator*(Vec2 a, double s) { return {a.x * s, a.y * s}; }
    friend constexpr Vec2 operator*(double s, Vec2 a) { return {a.x * s, a.y * s}; }
    friend constexpr Vec2 operator/(Vec2 a, double s) { return {a.x / s, a.y / s}; }
    friend constexpr bool operator==(Vec2 a, Vec2 b) = default;
};

inline double length(Vec2 v) { return std::hypot(v.x, v.y); }

// Axis-aligned rectangle, half-open in the integer case: [x1, x2) x [y1, y2).
struct Rect {
    double x1 = 0.0, y1 = 0.0, x2 = 0.0, y2 = 0.0;

    constexpr bool empty() const { return !(x2 > x1) || !(y2 > y1); }
    friend constexpr bool operator==(const Rect&, const Rect&) = default;
};

struct RectI {
    int x1 = 0, y1 = 0, x2 = 0, y2 = 0;

    constexpr bool empty() const { return x2 <= x1 || y2 <= y1; }
    constexpr int width() const { return x2 - x1; }
    constexpr int height() const { return y2 - y1; }
    friend constexpr bool operator==(const RectI&, const RectI&) = default;
};

inline Rect unite(const Rect& a, const Rect& b)
{
    if (a.empty()) return b;
    if (b.empty()) return a;
    return {std::min(a.x1, b.x1), std::min(a.y1, b.y1), std::max(a.x2, b.x2), std::max(a.y2, b.y2)};
}

inline Rect intersect(const Rect& a, const Rect& b)
{
    Rect r{std::max(a.x1, b.x1), std::max(a.y1, b.y1), std::min(a.x2, b.x2), std::min(a.y2, b.y2)};
    return r.empty() ? Rect{} : r;
}

inline RectI intersect(const RectI& a, const RectI& b)
{
    RectI r{std::max(a.x1, b.x1), std::max(a.y1, b.y1), std::min(a.x2, b.x2), std::min(a.y2, b.y2)};
    return r.empty() ? RectI{} : r;
}

// Smallest integer rectangle containing r.
inline RectI roundOut(const Rect& r)
{
    if (r.empty()) return {};
    return {static_cast<int>(std::floor(r.x1)), static_cast<int>(std::floor(r.y1)),
            static_cast<int>(std::ceil(r.x2)), static_cast<int>(std::ceil(r.y2))};
}

// 2D affine transform:  x' = a*x + b*y + tx,  y' = c*x + d*y + ty.
struct Affine {
    double a = 1.0, b = 0.0, tx = 0.0;
    double c = 0.0, d = 1.0, ty = 0.0;

    static constexpr Affine identity() { return {}; }
    static constexpr Affine translate(double x, double y) { return {1.0, 0.0, x, 0.0, 1.0, y}; }
    static constexpr Affine scale(double sx, double sy) { return {sx, 0.0, 0.0, 0.0, sy, 0.0}; }
    // Rotation by theta radians in the coordinate system's own sense
    // (counter-clockwise for y-up, clockwise on screen for y-down).
    static Affine rotate(double theta)
    {
        const double s = std::sin(theta), co = std::cos(theta);
        return {co, -s, 0.0, s, co, 0.0};
    }

    constexpr Vec2 apply(Vec2 p) const { return {a * p.x + b * p.y + tx, c * p.x + d * p.y + ty}; }
    constexpr Vec2 applyLinear(Vec2 v) const { return {a * v.x + b * v.y, c * v.x + d * v.y}; }
    constexpr double determinant() const { return a * d - b * c; }

    // this * o : apply o first, then this.
    friend constexpr Affine operator*(const Affine& m, const Affine& o)
    {
        return {m.a * o.a + m.b * o.c, m.a * o.b + m.b * o.d, m.a * o.tx + m.b * o.ty + m.tx,
                m.c * o.a + m.d * o.c, m.c * o.b + m.d * o.d, m.c * o.tx + m.d * o.ty + m.ty};
    }

    std::optional<Affine> inverse() const
    {
        const double det = determinant();
        // Relative singularity test: scale-invariant.
        const double norm = std::max({std::abs(a), std::abs(b), std::abs(c), std::abs(d)});
        if (norm == 0.0 || !std::isfinite(det) || std::abs(det) <= 1e-12 * norm * norm) return std::nullopt;
        const double id = 1.0 / det;
        Affine r{d * id, -b * id, 0.0, -c * id, a * id, 0.0};
        r.tx = -(r.a * tx + r.b * ty);
        r.ty = -(r.c * tx + r.d * ty);
        return r;
    }

    bool isIdentity(double eps) const
    {
        return std::abs(a - 1.0) <= eps && std::abs(b) <= eps && std::abs(c) <= eps &&
               std::abs(d - 1.0) <= eps && std::abs(tx) <= eps && std::abs(ty) <= eps;
    }
};

// Bounding box of a rectangle after an affine transform.
inline Rect transformBounds(const Affine& m, const Rect& r)
{
    if (r.empty()) return {};
    const Vec2 p[4] = {m.apply({r.x1, r.y1}), m.apply({r.x2, r.y1}), m.apply({r.x1, r.y2}), m.apply({r.x2, r.y2})};
    Rect out{p[0].x, p[0].y, p[0].x, p[0].y};
    for (const Vec2& q : p) {
        out.x1 = std::min(out.x1, q.x);
        out.y1 = std::min(out.y1, q.y);
        out.x2 = std::max(out.x2, q.x);
        out.y2 = std::max(out.y2, q.y);
    }
    return out;
}

// Largest singular value of the linear part: how many source pixels one
// destination pixel spans along its most stretched direction.
inline double maxSingularValue(const Affine& m)
{
    const double p = m.a * m.a + m.c * m.c;
    const double q = m.a * m.b + m.c * m.d;
    const double r = m.b * m.b + m.d * m.d;
    const double mean = 0.5 * (p + r);
    const double disc = std::sqrt(std::max(0.0, 0.25 * (p - r) * (p - r) + q * q));
    return std::sqrt(mean + disc);
}

}  // namespace vkf
