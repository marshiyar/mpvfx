#include "vkf/render/CpuRenderer.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <stdexcept>

// This file is the normative implementation of the sampling algorithm in the
// design spec. render/shaders/motion.metal and motion.comp mirror it line for
// line; keep all three in sync (the parity tests enforce it).
namespace vkf::render {

namespace {

struct F4 {
    float r = 0.f, g = 0.f, b = 0.f, a = 0.f;
};

inline F4 madd(F4 acc, F4 v, float w) { return {acc.r + v.r * w, acc.g + v.g * w, acc.b + v.b * w, acc.a + v.a * w}; }

template <class T>
inline float toFloat(T v)
{
    if constexpr (std::is_same_v<T, float>)
        return v;
    else
        return static_cast<float>(v) * (1.0f / static_cast<float>(std::numeric_limits<T>::max()));
}

template <class T>
inline T fromFloat(float v)
{
    if constexpr (std::is_same_v<T, float>) {
        return v;
    } else {
        constexpr float maxv = static_cast<float>(std::numeric_limits<T>::max());
        const float c = std::clamp(v, 0.0f, 1.0f) * maxv + 0.5f;
        return static_cast<T>(c);
    }
}

template <class T, int N>
class Kernel {
public:
    Kernel(const RenderPlan& plan, const ImageView& src, const ImageView& dst)
        : plan_(plan), src_(src), dst_(dst),
          unpremult_(N == 4 && plan.unpremultipliedSource()),
          sx1_(plan.srcRect.x), sy1_(plan.srcRect.y), sx2_(plan.srcRect.z), sy2_(plan.srcRect.w)
    {
    }

    void renderRows(int yBegin, int yEnd) const
    {
        for (int y = yBegin; y < yEnd; ++y) {
            T* out = reinterpret_cast<T*>(dst_.pixel(plan_.window.x, y));
            for (int x = plan_.window.x; x < plan_.window.z; ++x, out += N) store(out, shade(x, y));
        }
    }

private:
    F4 fetch(int ix, int iy) const
    {
        if (ix < sx1_ || ix >= sx2_ || iy < sy1_ || iy >= sy2_) return {};
        const T* p = reinterpret_cast<const T*>(src_.pixel(ix, iy));
        F4 t;
        if constexpr (N == 1) {
            t.a = toFloat(p[0]);
        } else {
            t.r = toFloat(p[0]);
            t.g = toFloat(p[1]);
            t.b = toFloat(p[2]);
            t.a = N == 4 ? toFloat(p[3]) : 1.0f;
        }
        if (unpremult_) {
            t.r *= t.a;
            t.g *= t.a;
            t.b *= t.a;
        }
        return t;
    }

    static void cubicWeights(float t, float w[4])
    {
        // Catmull-Rom.
        const float t2 = t * t, t3 = t2 * t;
        w[0] = 0.5f * (-t3 + 2.0f * t2 - t);
        w[1] = 0.5f * (3.0f * t3 - 5.0f * t2 + 2.0f);
        w[2] = 0.5f * (-3.0f * t3 + 4.0f * t2 + t);
        w[3] = 0.5f * (t3 - t2);
    }

    F4 sample(float sx, float sy) const
    {
        // Points further than the filter radius from the source are empty.
        // Written so NaN also takes this branch.
        if (!(sx >= static_cast<float>(sx1_) - 3.0f && sx <= static_cast<float>(sx2_) + 3.0f &&
              sy >= static_cast<float>(sy1_) - 3.0f && sy <= static_cast<float>(sy2_) + 3.0f))
            return {};
        const float u = sx - 0.5f, v = sy - 0.5f;
        const float fu = std::floor(u), fv = std::floor(v);
        const int x0 = static_cast<int>(fu), y0 = static_cast<int>(fv);
        const float fx = u - fu, fy = v - fv;
        F4 acc;
        if (plan_.filter() == Filter::Bilinear) {
            acc = madd(acc, fetch(x0, y0), (1.0f - fx) * (1.0f - fy));
            acc = madd(acc, fetch(x0 + 1, y0), fx * (1.0f - fy));
            acc = madd(acc, fetch(x0, y0 + 1), (1.0f - fx) * fy);
            acc = madd(acc, fetch(x0 + 1, y0 + 1), fx * fy);
            return acc;
        }
        float wx[4], wy[4];
        cubicWeights(fx, wx);
        cubicWeights(fy, wy);
        for (int j = 0; j < 4; ++j)
            for (int i = 0; i < 4; ++i) acc = madd(acc, fetch(x0 - 1 + i, y0 - 1 + j), wx[i] * wy[j]);
        return acc;
    }

    F4 shade(int x, int y) const
    {
        const float px = static_cast<float>(x) + 0.5f;
        const float py = static_cast<float>(y) + 0.5f;
        const int n = plan_.supersample();
        const float invN = 1.0f / static_cast<float>(n);
        const float af = plan_.params.y;
        const float step = plan_.params.z;
        const int taps = af > 0.0f ? 3 : 1;
        const float tapDy[3] = {taps == 3 ? -step : 0.0f, 0.0f, step};
        const float tapW[3] = {taps == 3 ? 0.25f * af : 1.0f, 1.0f - 0.5f * af, 0.25f * af};
        // With one tap only index 0 is used (offset 0, weight 1).

        F4 acc;
        for (int k = 0; k < plan_.matrixCount(); ++k) {
            const Float4 r0 = plan_.matrices[2 * k];
            const Float4 r1 = plan_.matrices[2 * k + 1];
            for (int t = 0; t < taps; ++t) {
                for (int j = 0; j < n; ++j) {
                    const float dy = py + tapDy[t] + ((static_cast<float>(j) + 0.5f) * invN - 0.5f);
                    for (int i = 0; i < n; ++i) {
                        const float dx = px + ((static_cast<float>(i) + 0.5f) * invN - 0.5f);
                        const float sx = r0.x * dx + r0.y * dy + r0.z;
                        const float sy = r1.x * dx + r1.y * dy + r1.z;
                        acc = madd(acc, sample(sx, sy), tapW[t]);
                    }
                }
            }
        }

        const float divisor = plan_.params.w;
        const float scale = divisor > 0.0f ? plan_.params.x / divisor : 0.0f;
        F4 out{acc.r * scale, acc.g * scale, acc.b * scale, std::clamp(acc.a * scale, 0.0f, 1.0f)};
        if (unpremult_) {
            if (out.a > 0.0f) {
                out.r /= out.a;
                out.g /= out.a;
                out.b /= out.a;
            } else {
                out.r = out.g = out.b = 0.0f;
            }
        }
        return out;
    }

    static void store(T* p, const F4& c)
    {
        if constexpr (N == 1) {
            p[0] = fromFloat<T>(c.a);
        } else {
            p[0] = fromFloat<T>(c.r);
            p[1] = fromFloat<T>(c.g);
            p[2] = fromFloat<T>(c.b);
            if constexpr (N == 4) p[3] = fromFloat<T>(c.a);
        }
    }

    const RenderPlan& plan_;
    const ImageView& src_;
    const ImageView& dst_;
    const bool unpremult_;
    const int sx1_, sy1_, sx2_, sy2_;
};

template <class T, int N>
void run(const RenderPlan& plan, const ImageView& src, const ImageView& dst, Executor& executor)
{
    const Kernel<T, N> kernel(plan, src, dst);
    const int y0 = plan.window.y;
    executor.parallelFor(plan.window.w - plan.window.y,
                         [&](int b, int e) { kernel.renderRows(y0 + b, y0 + e); });
}

template <class T>
void dispatchComponents(const RenderPlan& plan, const ImageView& src, const ImageView& dst, Executor& ex)
{
    switch (src.components) {
        case 1: run<T, 1>(plan, src, dst, ex); return;
        case 3: run<T, 3>(plan, src, dst, ex); return;
        case 4: run<T, 4>(plan, src, dst, ex); return;
        default: throw std::invalid_argument("vkf::render::renderCpu: unsupported component count");
    }
}

}  // namespace

void renderCpu(const RenderPlan& plan, const ImageView& src, const ImageView& dst, Executor& executor)
{
    const RectI window{plan.window.x, plan.window.y, plan.window.z, plan.window.w};
    const RectI srcRect{plan.srcRect.x, plan.srcRect.y, plan.srcRect.z, plan.srcRect.w};
    if (window.empty()) return;
    if (src.type != dst.type || src.components != dst.components)
        throw std::invalid_argument("vkf::render::renderCpu: source and destination formats differ");
    if (!(intersect(window, dst.bounds) == window) || dst.data == nullptr)
        throw std::invalid_argument("vkf::render::renderCpu: window outside destination");
    if (!(src.bounds == srcRect) || (!srcRect.empty() && src.data == nullptr))
        throw std::invalid_argument("vkf::render::renderCpu: source bounds differ from plan");
    if (plan.matrixCount() < 0 || plan.matrixCount() > motion::kMaxMotionSamples || plan.supersample() < 1 ||
        plan.supersample() > kMaxSupersample)
        throw std::invalid_argument("vkf::render::renderCpu: malformed plan");

    switch (src.type) {
        case PixelType::U8: dispatchComponents<std::uint8_t>(plan, src, dst, executor); return;
        case PixelType::U16: dispatchComponents<std::uint16_t>(plan, src, dst, executor); return;
        case PixelType::F32: dispatchComponents<float>(plan, src, dst, executor); return;
    }
}

}  // namespace vkf::render
