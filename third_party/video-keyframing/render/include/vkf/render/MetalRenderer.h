#pragma once

#include <cstddef>
#include <memory>
#include <string>

#include "vkf/render/ImageView.h"
#include "vkf/render/RenderPlan.h"

namespace vkf::render {

// A float RGBA image living in a Metal buffer (id<MTLBuffer> passed as void*).
struct MetalImage {
    void* buffer = nullptr;
    RectI bounds;
    std::ptrdiff_t rowBytes = 0;  // must be a positive multiple of 16
    std::size_t byteOffset = 0;   // offset of pixel (bounds.x1, bounds.y1) in the buffer
};

// Metal backend. Thread-safe: one instance may be used from several render
// threads at once. Pipelines are built per device and cached.
class MetalRenderer {
public:
    // Uses the system default device. Returns nullptr (with a reason in
    // *error, if given) when Metal is unavailable or the kernel fails to build.
    static std::unique_ptr<MetalRenderer> create(std::string* error = nullptr);
    ~MetalRenderer();

    MetalRenderer(const MetalRenderer&) = delete;
    MetalRenderer& operator=(const MetalRenderer&) = delete;

    // Renders CPU float RGBA images through the GPU and waits for the result.
    // Same contract as renderCpu. Throws std::invalid_argument for bad input,
    // std::runtime_error on GPU failure.
    void render(const RenderPlan& plan, const ImageView& src, const ImageView& dst);

    // Host interop: encodes the render into `commandQueue`
    // (id<MTLCommandQueue>) and commits without waiting, as OFX hosts expect.
    // `plan` layouts are filled in from the images. Throws like render().
    void encode(void* commandQueue, RenderPlan plan, const MetalImage& src, const MetalImage& dst);

private:
    struct Impl;
    explicit MetalRenderer(std::unique_ptr<Impl> impl);
    std::unique_ptr<Impl> impl_;
};

}  // namespace vkf::render
