// Motion effect kernel for Metal. Mirrors render/src/CpuRenderer.cpp line for
// line; RenderPlan mirrors render/include/vkf/render/RenderPlan.h. Images are
// float RGBA; strides and offsets are in floats.
#include <metal_stdlib>
using namespace metal;

struct RenderPlan {
    int4 srcRect;
    int4 window;
    int4 srcLayout;  // origin x, origin y, row stride, base offset
    int4 dstLayout;
    int4 counts;     // matrix count, supersample n, filter, flags
    float4 params;   // opacity, anti-flicker, anti-flicker step, divisor
    float4 matrices[128];
};

static float4 fetchTexel(const device float* src, constant RenderPlan& p, bool unpremult, int ix, int iy)
{
    if (ix < p.srcRect.x || ix >= p.srcRect.z || iy < p.srcRect.y || iy >= p.srcRect.w) return float4(0.0f);
    const long i = long(p.srcLayout.w) + long(iy - p.srcLayout.y) * long(p.srcLayout.z) + long(ix - p.srcLayout.x) * 4;
    float4 t = float4(src[i], src[i + 1], src[i + 2], src[i + 3]);
    if (unpremult) {
        t.x *= t.w;
        t.y *= t.w;
        t.z *= t.w;
    }
    return t;
}

static void cubicWeights(float t, thread float* w)
{
    const float t2 = t * t, t3 = t2 * t;
    w[0] = 0.5f * (-t3 + 2.0f * t2 - t);
    w[1] = 0.5f * (3.0f * t3 - 5.0f * t2 + 2.0f);
    w[2] = 0.5f * (-3.0f * t3 + 4.0f * t2 + t);
    w[3] = 0.5f * (t3 - t2);
}

static float4 sampleSource(const device float* src, constant RenderPlan& p, bool unpremult, float sx, float sy)
{
    if (!(sx >= float(p.srcRect.x) - 3.0f && sx <= float(p.srcRect.z) + 3.0f &&
          sy >= float(p.srcRect.y) - 3.0f && sy <= float(p.srcRect.w) + 3.0f))
        return float4(0.0f);
    const float u = sx - 0.5f, v = sy - 0.5f;
    const float fu = floor(u), fv = floor(v);
    const int x0 = int(fu), y0 = int(fv);
    const float fx = u - fu, fy = v - fv;
    float4 acc = float4(0.0f);
    if (p.counts.z == 0) {
        acc += fetchTexel(src, p, unpremult, x0, y0) * ((1.0f - fx) * (1.0f - fy));
        acc += fetchTexel(src, p, unpremult, x0 + 1, y0) * (fx * (1.0f - fy));
        acc += fetchTexel(src, p, unpremult, x0, y0 + 1) * ((1.0f - fx) * fy);
        acc += fetchTexel(src, p, unpremult, x0 + 1, y0 + 1) * (fx * fy);
        return acc;
    }
    float wx[4], wy[4];
    cubicWeights(fx, wx);
    cubicWeights(fy, wy);
    for (int j = 0; j < 4; ++j)
        for (int i = 0; i < 4; ++i) acc += fetchTexel(src, p, unpremult, x0 - 1 + i, y0 - 1 + j) * (wx[i] * wy[j]);
    return acc;
}

kernel void motionKernel(constant RenderPlan& p [[buffer(0)]],
                         const device float* src [[buffer(1)]],
                         device float* dst [[buffer(2)]],
                         uint2 gid [[thread_position_in_grid]])
{
    const int x = p.window.x + int(gid.x);
    const int y = p.window.y + int(gid.y);
    if (x >= p.window.z || y >= p.window.w) return;

    const bool unpremult = (p.counts.w & 1) != 0;
    const float px = float(x) + 0.5f;
    const float py = float(y) + 0.5f;
    const int n = p.counts.y;
    const float invN = 1.0f / float(n);
    const float af = p.params.y;
    const float step = p.params.z;
    const int taps = af > 0.0f ? 3 : 1;
    const float tapDy[3] = {taps == 3 ? -step : 0.0f, 0.0f, step};
    const float tapW[3] = {taps == 3 ? 0.25f * af : 1.0f, 1.0f - 0.5f * af, 0.25f * af};

    float4 acc = float4(0.0f);
    for (int k = 0; k < p.counts.x; ++k) {
        const float4 r0 = p.matrices[2 * k];
        const float4 r1 = p.matrices[2 * k + 1];
        for (int t = 0; t < taps; ++t) {
            for (int j = 0; j < n; ++j) {
                const float dy = py + tapDy[t] + ((float(j) + 0.5f) * invN - 0.5f);
                for (int i = 0; i < n; ++i) {
                    const float dx = px + ((float(i) + 0.5f) * invN - 0.5f);
                    const float sx = r0.x * dx + r0.y * dy + r0.z;
                    const float sy = r1.x * dx + r1.y * dy + r1.z;
                    acc += sampleSource(src, p, unpremult, sx, sy) * tapW[t];
                }
            }
        }
    }

    const float divisor = p.params.w;
    const float scale = divisor > 0.0f ? p.params.x / divisor : 0.0f;
    float4 out = float4(acc.x * scale, acc.y * scale, acc.z * scale, clamp(acc.w * scale, 0.0f, 1.0f));
    if (unpremult) {
        if (out.w > 0.0f) {
            out.x /= out.w;
            out.y /= out.w;
            out.z /= out.w;
        } else {
            out.x = out.y = out.z = 0.0f;
        }
    }
    const long o = long(p.dstLayout.w) + long(y - p.dstLayout.y) * long(p.dstLayout.z) + long(x - p.dstLayout.x) * 4;
    dst[o] = out.x;
    dst[o + 1] = out.y;
    dst[o + 2] = out.z;
    dst[o + 3] = out.w;
}
