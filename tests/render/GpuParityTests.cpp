#include <gtest/gtest.h>

#include <cmath>
#include <functional>
#include <iostream>
#include <random>
#include <string>
#include <vector>

#include "../support/TestImage.h"
#include "vkf/render/CpuRenderer.h"
#if VKF_HAS_METAL
#include "vkf/render/MetalRenderer.h"
#endif
#if VKF_HAS_VULKAN
#include "vkf/render/VulkanRenderer.h"
#endif

using namespace vkf;
using namespace vkf::render;
using vkf::test::TestImage;

namespace {

using GpuRender = std::function<void(const RenderPlan&, const ImageView&, const ImageView&)>;

struct Case {
    std::vector<Affine> matrices;
    PlanInputs inputs;
};

Case randomCase(std::mt19937& rng, RectI src, RectI window)
{
    std::uniform_real_distribution<double> u(0.0, 1.0);
    Case c;
    const int samples = 1 + static_cast<int>(u(rng) * 4.0);
    const double angle = u(rng) * 6.4, scale = 0.2 + u(rng) * 2.8;
    const Vec2 shift{u(rng) * 40.0 - 20.0, u(rng) * 40.0 - 20.0};
    for (int k = 0; k < samples; ++k) {
        const Affine fwd = Affine::translate(shift.x + 3.0 * k, shift.y + 1.5 * k) * Affine::translate(40, 30) *
                           Affine::rotate(angle + 0.05 * k) * Affine::scale(scale, scale) *
                           Affine::translate(-33, -26);
        c.matrices.push_back(fwd.inverse().value());
    }
    c.inputs.dstToSrc = c.matrices;
    c.inputs.totalSamples = samples + (u(rng) < 0.2 ? 1 : 0);
    c.inputs.opacity = 0.3 + 0.7 * u(rng);
    c.inputs.antiFlicker = u(rng) < 0.5 ? 0.0 : u(rng);
    c.inputs.antiFlickerStep = u(rng) < 0.5 ? 1.0 : 0.5;
    c.inputs.quality = u(rng) < 0.5 ? motion::Quality::Draft : motion::Quality::High;
    c.inputs.sourcePremultiplied = u(rng) < 0.7;
    c.inputs.srcBounds = src;
    c.inputs.window = window;
    return c;
}

// Max per-channel difference; unpremultiplied outputs are compared after
// re-premultiplying, because dividing by a tiny alpha amplifies rounding.
double maxDiff(const TestImage& a, const TestImage& b, const RectI& r, bool unpremult)
{
    double worst = 0.0;
    for (int y = r.y1; y < r.y2; ++y)
        for (int x = r.x1; x < r.x2; ++x) {
            const float* p = a.f(x, y);
            const float* q = b.f(x, y);
            for (int c = 0; c < 4; ++c) {
                const double pv = unpremult && c < 3 ? p[c] * p[3] : p[c];
                const double qv = unpremult && c < 3 ? q[c] * q[3] : q[c];
                worst = std::max(worst, std::abs(pv - qv));
                if (!std::isfinite(qv)) return INFINITY;
            }
        }
    return worst;
}

void checkParity(const GpuRender& gpu, const std::string& name)
{
    std::mt19937 rng(1234);
    const RectI src{-5, 3, 62, 56};
    TestImage in(src, PixelType::F32, 4);
    in.fillRandom(99);
    SerialExecutor serial;
    double energy = 0.0;  // guards against vacuous passes (e.g. both outputs empty)
    for (int iter = 0; iter < 40; ++iter) {
        const RectI window{-12 + iter % 5, -7, 85 - iter % 3, 71};
        const Case c = randomCase(rng, src, window);
        const RenderPlan plan = makePlan(c.inputs);
        TestImage cpu(window, PixelType::F32, 4), gpuOut(window, PixelType::F32, 4);
        renderCpu(plan, in.view, cpu.view, serial);
        gpu(plan, in.view, gpuOut.view);
        const double diff = maxDiff(cpu, gpuOut, window, !c.inputs.sourcePremultiplied);
        for (int y = window.y1; y < window.y2; ++y)
            for (int x = window.x1; x < window.x2; ++x) energy += gpuOut.f(x, y)[3];
        EXPECT_LE(diff, 1e-4) << name << " iteration " << iter << " quality "
                              << static_cast<int>(c.inputs.quality) << " n=" << plan.supersample();
    }
    EXPECT_GT(energy / 40.0, 100.0) << name << ": GPU output is (nearly) empty";
}

}  // namespace

#if VKF_HAS_METAL
TEST(GpuParity, MetalMatchesCpu)
{
    std::string error;
    auto metal = MetalRenderer::create(&error);
    if (!metal) GTEST_SKIP() << "Metal unavailable: " << error;
    checkParity([&](const RenderPlan& p, const ImageView& s, const ImageView& d) { metal->render(p, s, d); },
                "Metal");
}
#endif

#if VKF_HAS_VULKAN
TEST(GpuParity, VulkanMatchesCpu)
{
    std::string error;
    auto vk = VulkanRenderer::create(&error);
    if (!vk) GTEST_SKIP() << "Vulkan unavailable: " << error;
    std::cout << "[          ] Vulkan device: " << vk->deviceName() << "\n";
    checkParity([&](const RenderPlan& p, const ImageView& s, const ImageView& d) { vk->render(p, s, d); },
                "Vulkan");
}
#endif
