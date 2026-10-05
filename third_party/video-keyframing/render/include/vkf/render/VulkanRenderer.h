#pragma once

#include <memory>
#include <string>

#include "vkf/render/ImageView.h"
#include "vkf/render/RenderPlan.h"

namespace vkf::render {

// Vulkan compute backend for our own engine (OpenFX defines no Vulkan
// interop, so the OFX plugin does not use it). Thread-safe: renders are
// serialised on one queue; GPU buffers are cached and grown as needed.
class VulkanRenderer {
public:
    // Picks a device with a compute queue (discrete GPUs first). Returns
    // nullptr (with a reason in *error, if given) when none is usable.
    static std::unique_ptr<VulkanRenderer> create(std::string* error = nullptr);
    ~VulkanRenderer();

    VulkanRenderer(const VulkanRenderer&) = delete;
    VulkanRenderer& operator=(const VulkanRenderer&) = delete;

    // Same contract as renderCpu, float RGBA only. Throws
    // std::invalid_argument for bad input, std::runtime_error on GPU failure.
    void render(const RenderPlan& plan, const ImageView& src, const ImageView& dst);

    std::string deviceName() const;

private:
    struct Impl;
    explicit VulkanRenderer(std::unique_ptr<Impl> impl);
    std::unique_ptr<Impl> impl_;
};

}  // namespace vkf::render
