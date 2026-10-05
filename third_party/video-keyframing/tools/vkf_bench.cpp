// Renders a UHD float RGBA frame with each available backend and prints the
// median time. GPU timings include upload and download (the standalone path);
// inside OFX hosts with GPU images there is no transfer.
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <functional>
#include <random>
#include <string>
#include <vector>

#include "vkf/render/CpuRenderer.h"
#if VKF_HAS_METAL
#include "vkf/render/MetalRenderer.h"
#endif
#if VKF_HAS_VULKAN
#include "vkf/render/VulkanRenderer.h"
#endif

using namespace vkf;
using namespace vkf::render;

namespace {

constexpr int kW = 3840, kH = 2160, kRuns = 7;

double medianMs(const std::function<void()>& fn)
{
    fn();  // warm-up (pipeline creation, page faults)
    std::vector<double> t;
    for (int i = 0; i < kRuns; ++i) {
        const auto a = std::chrono::steady_clock::now();
        fn();
        t.push_back(std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - a).count());
    }
    std::sort(t.begin(), t.end());
    return t[t.size() / 2];
}

}  // namespace

int main()
{
    const RectI frame{0, 0, kW, kH};
    std::vector<float> src(static_cast<std::size_t>(kW) * kH * 4), dst(src.size());
    std::mt19937 rng(1);
    std::uniform_real_distribution<float> u(0.f, 1.f);
    for (float& v : src) v = u(rng);
    const ImageView sv{src.data(), kW * 16, frame, PixelType::F32, 4};
    const ImageView dv{dst.data(), kW * 16, frame, PixelType::F32, 4};

    struct Scenario {
        const char* name;
        motion::Quality quality;
        double scale;
        int samples;
    };
    const Scenario scenarios[] = {
        {"Draft, rotate+scale 80%", motion::Quality::Draft, 0.8, 1},
        {"High, rotate+scale 80%", motion::Quality::High, 0.8, 1},
        {"High, shrink to 40% (supersampled)", motion::Quality::High, 0.4, 1},
        {"High, motion blur 8 samples", motion::Quality::High, 0.8, 8},
    };

    ThreadExecutor threads;
#if VKF_HAS_METAL
    auto metal = MetalRenderer::create();
#endif
#if VKF_HAS_VULKAN
    auto vulkan = VulkanRenderer::create();
#endif

    std::printf("UHD %dx%d float RGBA, median of %d runs (ms)\n", kW, kH, kRuns);
    std::printf("%-38s %10s %10s %10s\n", "scenario", "CPU", "Metal", "Vulkan");
    for (const Scenario& s : scenarios) {
        std::vector<Affine> m;
        for (int k = 0; k < s.samples; ++k) {
            const Affine fwd = Affine::translate(kW / 2.0 + 4.0 * k, kH / 2.0) * Affine::rotate(0.3 + 0.01 * k) *
                               Affine::scale(s.scale, s.scale) * Affine::translate(-kW / 2.0, -kH / 2.0);
            m.push_back(fwd.inverse().value());
        }
        PlanInputs in;
        in.dstToSrc = m;
        in.totalSamples = s.samples;
        in.quality = s.quality;
        in.srcBounds = frame;
        in.window = frame;
        const RenderPlan plan = makePlan(in);

        const double cpu = medianMs([&] { renderCpu(plan, sv, dv, threads); });
        std::string metalMs = "n/a", vulkanMs = "n/a";
#if VKF_HAS_METAL
        if (metal) metalMs = std::to_string(medianMs([&] { metal->render(plan, sv, dv); })).substr(0, 6);
#endif
#if VKF_HAS_VULKAN
        if (vulkan) vulkanMs = std::to_string(medianMs([&] { vulkan->render(plan, sv, dv); })).substr(0, 6);
#endif
        std::printf("%-38s %10.1f %10s %10s\n", s.name, cpu, metalMs.c_str(), vulkanMs.c_str());
    }
    return 0;
}
