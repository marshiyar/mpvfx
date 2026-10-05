#include "vkf/render/MetalRenderer.h"

#import <Foundation/Foundation.h>
#import <Metal/Metal.h>

#include <cstring>
#include <map>
#include <mutex>
#include <stdexcept>

extern const unsigned char vkf_motion_metal_source[];
extern const std::size_t vkf_motion_metal_source_size;

namespace vkf::render {

namespace {

bool validMetalImage(const MetalImage& img)
{
    return img.buffer != nullptr && img.rowBytes > 0 && img.rowBytes % 16 == 0 && img.byteOffset % 16 == 0 &&
           img.rowBytes >= static_cast<std::ptrdiff_t>(img.bounds.width()) * 16;
}

RectI windowOf(const RenderPlan& p) { return {p.window.x, p.window.y, p.window.z, p.window.w}; }
RectI srcRectOf(const RenderPlan& p) { return {p.srcRect.x, p.srcRect.y, p.srcRect.z, p.srcRect.w}; }

Int4 layoutOf(const MetalImage& img)
{
    return {img.bounds.x1, img.bounds.y1, static_cast<std::int32_t>(img.rowBytes / 4),
            static_cast<std::int32_t>(img.byteOffset / 4)};
}

void validatePlan(const RenderPlan& plan)
{
    if (plan.matrixCount() < 0 || plan.matrixCount() > motion::kMaxMotionSamples || plan.supersample() < 1 ||
        plan.supersample() > kMaxSupersample)
        throw std::invalid_argument("vkf::render::MetalRenderer: malformed plan");
}

}  // namespace

struct MetalRenderer::Impl {
    id<MTLDevice> device;
    id<MTLCommandQueue> queue;
    std::mutex mutex;
    std::map<void*, id<MTLComputePipelineState>> pipelines;  // keyed by device
    // Standalone render(): grow-only staging buffers, reused across frames.
    std::mutex stagingMutex;
    id<MTLBuffer> srcStaging;
    id<MTLBuffer> dstStaging;

    id<MTLBuffer> staging(id<MTLBuffer> __strong& buf, std::size_t bytes)
    {
        if (!buf || buf.length < bytes) {
            buf = [device newBufferWithLength:std::max<std::size_t>(bytes, 16) options:MTLResourceStorageModeShared];
            if (!buf) throw std::runtime_error("vkf::render::MetalRenderer: buffer allocation failed");
        }
        return buf;
    }

    id<MTLComputePipelineState> pipelineFor(id<MTLDevice> dev, std::string* error)
    {
        std::lock_guard<std::mutex> lock(mutex);
        void* key = (__bridge void*)dev;
        auto it = pipelines.find(key);
        if (it != pipelines.end()) return it->second;

        NSString* source = [[NSString alloc] initWithBytes:vkf_motion_metal_source
                                                    length:vkf_motion_metal_source_size
                                                  encoding:NSUTF8StringEncoding];
        MTLCompileOptions* options = [MTLCompileOptions new];
        // Parity with the CPU reference requires IEEE semantics (no fast math).
        if (@available(macOS 15.0, *)) {
            options.mathMode = MTLMathModeSafe;
        } else {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
            options.fastMathEnabled = NO;
#pragma clang diagnostic pop
        }
        NSError* err = nil;
        id<MTLLibrary> library = [dev newLibraryWithSource:source options:options error:&err];
        id<MTLFunction> fn = library ? [library newFunctionWithName:@"motionKernel"] : nil;
        id<MTLComputePipelineState> pso = fn ? [dev newComputePipelineStateWithFunction:fn error:&err] : nil;
        if (!pso) {
            if (error) *error = err ? err.localizedDescription.UTF8String : "failed to build Metal kernel";
            return nil;
        }
        pipelines[key] = pso;
        return pso;
    }

    id<MTLCommandBuffer> encodeOn(id<MTLCommandQueue> q, RenderPlan plan, id<MTLBuffer> src, id<MTLBuffer> dst)
    {
        std::string error;
        id<MTLComputePipelineState> pso = pipelineFor(q.device, &error);
        if (!pso) throw std::runtime_error("vkf::render::MetalRenderer: " + error);

        const RectI w = windowOf(plan);
        id<MTLCommandBuffer> cb = [q commandBuffer];
        cb.label = @"vkf.motion";
        id<MTLComputeCommandEncoder> enc = [cb computeCommandEncoder];
        [enc setComputePipelineState:pso];
        [enc setBytes:&plan length:sizeof(RenderPlan) atIndex:0];
        [enc setBuffer:src offset:0 atIndex:1];
        [enc setBuffer:dst offset:0 atIndex:2];
        const NSUInteger tw = pso.threadExecutionWidth;
        const NSUInteger th = std::max<NSUInteger>(1, pso.maxTotalThreadsPerThreadgroup / tw);
        const MTLSize perGroup = MTLSizeMake(tw, th, 1);
        const MTLSize groups = MTLSizeMake((static_cast<NSUInteger>(w.width()) + tw - 1) / tw,
                                           (static_cast<NSUInteger>(w.height()) + th - 1) / th, 1);
        [enc dispatchThreadgroups:groups threadsPerThreadgroup:perGroup];
        [enc endEncoding];
        [cb commit];
        return cb;
    }
};

MetalRenderer::MetalRenderer(std::unique_ptr<Impl> impl) : impl_(std::move(impl)) {}
MetalRenderer::~MetalRenderer() = default;

std::unique_ptr<MetalRenderer> MetalRenderer::create(std::string* error)
{
    @autoreleasepool {
        auto impl = std::make_unique<Impl>();
        impl->device = MTLCreateSystemDefaultDevice();
        if (!impl->device) {
            if (error) *error = "no Metal device";
            return nullptr;
        }
        impl->queue = [impl->device newCommandQueue];
        if (!impl->queue || !impl->pipelineFor(impl->device, error)) return nullptr;
        return std::unique_ptr<MetalRenderer>(new MetalRenderer(std::move(impl)));
    }
}

void MetalRenderer::render(const RenderPlan& planIn, const ImageView& src, const ImageView& dst)
{
    const RectI window = windowOf(planIn);
    const RectI srcRect = srcRectOf(planIn);
    if (window.empty()) return;
    validatePlan(planIn);
    if (src.type != PixelType::F32 || dst.type != PixelType::F32 || src.components != 4 || dst.components != 4)
        throw std::invalid_argument("vkf::render::MetalRenderer: float RGBA images required");
    if (!(intersect(window, dst.bounds) == window) || dst.data == nullptr)
        throw std::invalid_argument("vkf::render::MetalRenderer: window outside destination");
    if (!(src.bounds == srcRect) || (!srcRect.empty() && src.data == nullptr))
        throw std::invalid_argument("vkf::render::MetalRenderer: source bounds differ from plan");

    @autoreleasepool {
        const std::size_t srcRow = static_cast<std::size_t>(std::max(srcRect.width(), 1)) * 16;
        const std::size_t dstRow = static_cast<std::size_t>(window.width()) * 16;
        std::lock_guard<std::mutex> lock(impl_->stagingMutex);
        id<MTLBuffer> srcBuf =
            impl_->staging(impl_->srcStaging, srcRow * static_cast<std::size_t>(std::max(srcRect.height(), 1)));
        id<MTLBuffer> dstBuf = impl_->staging(impl_->dstStaging, dstRow * static_cast<std::size_t>(window.height()));

        auto* s = static_cast<std::byte*>(srcBuf.contents);
        for (int y = srcRect.y1; y < srcRect.y2; ++y)
            std::memcpy(s + static_cast<std::size_t>(y - srcRect.y1) * srcRow, src.row(y),
                        static_cast<std::size_t>(srcRect.width()) * 16);

        RenderPlan plan = planIn;
        plan.srcLayout = {srcRect.x1, srcRect.y1, static_cast<std::int32_t>(srcRow / 4), 0};
        plan.dstLayout = {window.x1, window.y1, static_cast<std::int32_t>(dstRow / 4), 0};
        id<MTLCommandBuffer> cb = impl_->encodeOn(impl_->queue, plan, srcBuf, dstBuf);
        [cb waitUntilCompleted];
        if (cb.status != MTLCommandBufferStatusCompleted) {
            NSString* why = cb.error ? cb.error.localizedDescription : @"command buffer failed";
            throw std::runtime_error(std::string("vkf::render::MetalRenderer: ") + why.UTF8String);
        }

        const auto* d = static_cast<const std::byte*>(dstBuf.contents);
        for (int y = window.y1; y < window.y2; ++y)
            std::memcpy(dst.pixel(window.x1, y), d + static_cast<std::size_t>(y - window.y1) * dstRow, dstRow);
    }
}

void MetalRenderer::encode(void* commandQueue, RenderPlan plan, const MetalImage& src, const MetalImage& dst)
{
    const RectI window = windowOf(plan);
    if (window.empty()) return;
    validatePlan(plan);
    if (commandQueue == nullptr || !validMetalImage(src) || !validMetalImage(dst))
        throw std::invalid_argument("vkf::render::MetalRenderer: invalid Metal images");
    if (!(intersect(window, dst.bounds) == window) || !(src.bounds == srcRectOf(plan)))
        throw std::invalid_argument("vkf::render::MetalRenderer: plan does not match images");

    @autoreleasepool {
        plan.srcLayout = layoutOf(src);
        plan.dstLayout = layoutOf(dst);
        id<MTLCommandQueue> q = (__bridge id<MTLCommandQueue>)commandQueue;
        impl_->encodeOn(q, plan, (__bridge id<MTLBuffer>)src.buffer, (__bridge id<MTLBuffer>)dst.buffer);
    }
}

}  // namespace vkf::render
