// Exercises MetalRenderer::encode, the path OFX hosts use: caller-owned
// buffers with padded rows and a non-zero offset, on the caller's queue.
#include <gtest/gtest.h>

#import <Metal/Metal.h>

#include <cstring>

#include "../support/TestImage.h"
#include "vkf/render/CpuRenderer.h"
#include "vkf/render/MetalRenderer.h"

using namespace vkf;
using namespace vkf::render;
using vkf::test::TestImage;

TEST(MetalHostPath, EncodeOnCallerQueueMatchesCpu)
{
    @autoreleasepool {
        std::string error;
        auto metal = MetalRenderer::create(&error);
        if (!metal) GTEST_SKIP() << "Metal unavailable: " << error;
        id<MTLDevice> dev = MTLCreateSystemDefaultDevice();
        id<MTLCommandQueue> queue = [dev newCommandQueue];

        const RectI srcRect{10, 20, 58, 60};
        const RectI dstRect{0, 0, 80, 70};
        TestImage in(srcRect, PixelType::F32, 4);
        in.fillRandom(4);

        const std::size_t srcRowBytes = 64 * 16;  // padded rows
        const std::size_t dstRowBytes = 96 * 16;
        const std::size_t offset = 256;
        id<MTLBuffer> srcBuf = [dev newBufferWithLength:offset + srcRowBytes * 40 options:MTLResourceStorageModeShared];
        id<MTLBuffer> dstBuf = [dev newBufferWithLength:offset + dstRowBytes * 70 options:MTLResourceStorageModeShared];
        for (int y = srcRect.y1; y < srcRect.y2; ++y)
            std::memcpy(static_cast<std::byte*>(srcBuf.contents) + offset + (y - srcRect.y1) * srcRowBytes,
                        in.view.row(y), 48 * 16);

        const std::vector<Affine> matrices{(Affine::translate(40, 35) * Affine::rotate(0.3) * Affine::scale(0.6, 0.6) *
                                     Affine::translate(-34, -40))
                                        .inverse()
                                        .value()};
        PlanInputs inputs;
        inputs.dstToSrc = matrices;
        inputs.srcBounds = srcRect;
        inputs.window = {5, 4, 75, 66};
        const RenderPlan plan = makePlan(inputs);

        metal->encode((__bridge void*)queue, plan,
                      {(__bridge void*)srcBuf, srcRect, static_cast<std::ptrdiff_t>(srcRowBytes), offset},
                      {(__bridge void*)dstBuf, dstRect, static_cast<std::ptrdiff_t>(dstRowBytes), offset});
        id<MTLCommandBuffer> fenceCb = [queue commandBuffer];  // queues execute in order
        [fenceCb commit];
        [fenceCb waitUntilCompleted];

        TestImage cpu(dstRect, PixelType::F32, 4);
        SerialExecutor serial;
        renderCpu(plan, in.view, cpu.view, serial);
        double worst = 0.0;
        for (int y = inputs.window.y1; y < inputs.window.y2; ++y)
            for (int x = inputs.window.x1; x < inputs.window.x2; ++x) {
                const float* g = reinterpret_cast<const float*>(static_cast<std::byte*>(dstBuf.contents) + offset +
                                                                y * dstRowBytes + x * 16);
                for (int c = 0; c < 4; ++c) worst = std::max(worst, static_cast<double>(std::abs(g[c] - cpu.f(x, y)[c])));
            }
        EXPECT_LE(worst, 1e-4);
    }
}
