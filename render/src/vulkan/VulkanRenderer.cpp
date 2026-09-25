#include "vkf/render/VulkanRenderer.h"

#include <vulkan/vulkan.h>

#include <algorithm>
#include <cstring>
#include <limits>
#include <mutex>
#include <stdexcept>
#include <vector>

extern const unsigned char vkf_motion_spirv[];
extern const std::size_t vkf_motion_spirv_size;

namespace vkf::render {

namespace {

void check(VkResult r, const char* what)
{
    if (r != VK_SUCCESS)
        throw std::runtime_error(std::string("vkf::render::VulkanRenderer: ") + what + " failed (VkResult " +
                                 std::to_string(static_cast<int>(r)) + ")");
}

bool hasExtension(const std::vector<VkExtensionProperties>& exts, const char* name)
{
    return std::any_of(exts.begin(), exts.end(),
                       [&](const VkExtensionProperties& e) { return std::strcmp(e.extensionName, name) == 0; });
}

constexpr std::uint32_t kLocalSize = 16;
constexpr const char* kPortabilityEnumeration = "VK_KHR_portability_enumeration";
constexpr const char* kPortabilitySubset = "VK_KHR_portability_subset";

}  // namespace

struct VulkanRenderer::Impl {
    struct Buffer {
        VkBuffer buffer = VK_NULL_HANDLE;
        VkDeviceMemory memory = VK_NULL_HANDLE;
        void* mapped = nullptr;
        VkDeviceSize capacity = 0;
    };

    VkInstance instance = VK_NULL_HANDLE;
    VkPhysicalDevice physical = VK_NULL_HANDLE;
    VkDevice device = VK_NULL_HANDLE;
    VkQueue queue = VK_NULL_HANDLE;
    std::uint32_t queueFamily = 0;
    std::string name;
    VkShaderModule shader = VK_NULL_HANDLE;
    VkDescriptorSetLayout setLayout = VK_NULL_HANDLE;
    VkPipelineLayout pipelineLayout = VK_NULL_HANDLE;
    VkPipeline pipeline = VK_NULL_HANDLE;
    VkDescriptorPool descriptorPool = VK_NULL_HANDLE;
    VkDescriptorSet descriptorSet = VK_NULL_HANDLE;
    VkCommandPool commandPool = VK_NULL_HANDLE;
    VkCommandBuffer commandBuffer = VK_NULL_HANDLE;
    VkFence fence = VK_NULL_HANDLE;
    Buffer planBuf, srcBuf, dstBuf;
    std::mutex mutex;

    ~Impl()
    {
        if (device) {
            vkDeviceWaitIdle(device);
            for (Buffer* b : {&planBuf, &srcBuf, &dstBuf}) release(*b);
            if (fence) vkDestroyFence(device, fence, nullptr);
            if (commandPool) vkDestroyCommandPool(device, commandPool, nullptr);
            if (descriptorPool) vkDestroyDescriptorPool(device, descriptorPool, nullptr);
            if (pipeline) vkDestroyPipeline(device, pipeline, nullptr);
            if (pipelineLayout) vkDestroyPipelineLayout(device, pipelineLayout, nullptr);
            if (setLayout) vkDestroyDescriptorSetLayout(device, setLayout, nullptr);
            if (shader) vkDestroyShaderModule(device, shader, nullptr);
            vkDestroyDevice(device, nullptr);
        }
        if (instance) vkDestroyInstance(instance, nullptr);
    }

    void release(Buffer& b)
    {
        if (b.mapped) vkUnmapMemory(device, b.memory);
        if (b.buffer) vkDestroyBuffer(device, b.buffer, nullptr);
        if (b.memory) vkFreeMemory(device, b.memory, nullptr);
        b = {};
    }

    void createInstance()
    {
        std::uint32_t count = 0;
        vkEnumerateInstanceExtensionProperties(nullptr, &count, nullptr);
        std::vector<VkExtensionProperties> exts(count);
        vkEnumerateInstanceExtensionProperties(nullptr, &count, exts.data());

        VkApplicationInfo app{};

        app.sType = VK_STRUCTURE_TYPE_APPLICATION_INFO;
        app.pApplicationName = "vkf";
        app.apiVersion = VK_API_VERSION_1_1;
        VkInstanceCreateInfo ci{};
        ci.sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO;
        ci.pApplicationInfo = &app;
        std::vector<const char*> enabled;
        // Needed to see MoltenVK (macOS) and other non-conformant drivers.
        if (hasExtension(exts, kPortabilityEnumeration)) {
            enabled.push_back(kPortabilityEnumeration);
            ci.flags |= 0x00000001;  // VK_INSTANCE_CREATE_ENUMERATE_PORTABILITY_BIT_KHR
        }
        ci.enabledExtensionCount = static_cast<std::uint32_t>(enabled.size());
        ci.ppEnabledExtensionNames = enabled.data();
        check(vkCreateInstance(&ci, nullptr, &instance), "vkCreateInstance");
    }

    bool pickDevice()
    {
        std::uint32_t count = 0;
        check(vkEnumeratePhysicalDevices(instance, &count, nullptr), "vkEnumeratePhysicalDevices");
        std::vector<VkPhysicalDevice> devices(count);
        check(vkEnumeratePhysicalDevices(instance, &count, devices.data()), "vkEnumeratePhysicalDevices");
        int bestScore = -1;
        for (VkPhysicalDevice d : devices) {
            VkPhysicalDeviceProperties props;
            vkGetPhysicalDeviceProperties(d, &props);
            std::uint32_t qn = 0;
            vkGetPhysicalDeviceQueueFamilyProperties(d, &qn, nullptr);
            std::vector<VkQueueFamilyProperties> qs(qn);
            vkGetPhysicalDeviceQueueFamilyProperties(d, &qn, qs.data());
            for (std::uint32_t i = 0; i < qn; ++i) {
                if (!(qs[i].queueFlags & VK_QUEUE_COMPUTE_BIT)) continue;
                const int score = props.deviceType == VK_PHYSICAL_DEVICE_TYPE_DISCRETE_GPU     ? 3
                                  : props.deviceType == VK_PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU ? 2
                                                                                               : 1;
                if (score > bestScore) {
                    bestScore = score;
                    physical = d;
                    queueFamily = i;
                    name = props.deviceName;
                }
                break;
            }
        }
        return physical != VK_NULL_HANDLE;
    }

    void createDevice()
    {
        std::uint32_t count = 0;
        vkEnumerateDeviceExtensionProperties(physical, nullptr, &count, nullptr);
        std::vector<VkExtensionProperties> exts(count);
        vkEnumerateDeviceExtensionProperties(physical, nullptr, &count, exts.data());
        std::vector<const char*> enabled;
        if (hasExtension(exts, kPortabilitySubset)) enabled.push_back(kPortabilitySubset);

        const float priority = 1.0f;
        VkDeviceQueueCreateInfo qci{};
        qci.sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO;
        qci.queueFamilyIndex = queueFamily;
        qci.queueCount = 1;
        qci.pQueuePriorities = &priority;
        VkDeviceCreateInfo dci{};
        dci.sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO;
        dci.queueCreateInfoCount = 1;
        dci.pQueueCreateInfos = &qci;
        dci.enabledExtensionCount = static_cast<std::uint32_t>(enabled.size());
        dci.ppEnabledExtensionNames = enabled.data();
        check(vkCreateDevice(physical, &dci, nullptr, &device), "vkCreateDevice");
        vkGetDeviceQueue(device, queueFamily, 0, &queue);
    }

    void createPipeline()
    {
        VkShaderModuleCreateInfo smci{};
        smci.sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO;
        smci.codeSize = vkf_motion_spirv_size;
        smci.pCode = reinterpret_cast<const std::uint32_t*>(vkf_motion_spirv);
        check(vkCreateShaderModule(device, &smci, nullptr, &shader), "vkCreateShaderModule");

        VkDescriptorSetLayoutBinding bindings[3]{};
        for (std::uint32_t i = 0; i < 3; ++i) {
            bindings[i].binding = i;
            bindings[i].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
            bindings[i].descriptorCount = 1;
            bindings[i].stageFlags = VK_SHADER_STAGE_COMPUTE_BIT;
        }
        VkDescriptorSetLayoutCreateInfo dslci{};
        dslci.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO;
        dslci.bindingCount = 3;
        dslci.pBindings = bindings;
        check(vkCreateDescriptorSetLayout(device, &dslci, nullptr, &setLayout), "vkCreateDescriptorSetLayout");

        VkPipelineLayoutCreateInfo plci{};

        plci.sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO;
        plci.setLayoutCount = 1;
        plci.pSetLayouts = &setLayout;
        check(vkCreatePipelineLayout(device, &plci, nullptr, &pipelineLayout), "vkCreatePipelineLayout");

        VkComputePipelineCreateInfo cpci{};

        cpci.sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO;
        cpci.stage.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
        cpci.stage.stage = VK_SHADER_STAGE_COMPUTE_BIT;
        cpci.stage.module = shader;
        cpci.stage.pName = "main";
        cpci.layout = pipelineLayout;
        check(vkCreateComputePipelines(device, VK_NULL_HANDLE, 1, &cpci, nullptr, &pipeline),
              "vkCreateComputePipelines");

        VkDescriptorPoolSize poolSize{VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 3};
        VkDescriptorPoolCreateInfo dpci{};
        dpci.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO;
        dpci.maxSets = 1;
        dpci.poolSizeCount = 1;
        dpci.pPoolSizes = &poolSize;
        check(vkCreateDescriptorPool(device, &dpci, nullptr, &descriptorPool), "vkCreateDescriptorPool");
        VkDescriptorSetAllocateInfo dsai{};
        dsai.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO;
        dsai.descriptorPool = descriptorPool;
        dsai.descriptorSetCount = 1;
        dsai.pSetLayouts = &setLayout;
        check(vkAllocateDescriptorSets(device, &dsai, &descriptorSet), "vkAllocateDescriptorSets");

        VkCommandPoolCreateInfo cpi{};

        cpi.sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO;
        cpi.flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT;
        cpi.queueFamilyIndex = queueFamily;
        check(vkCreateCommandPool(device, &cpi, nullptr, &commandPool), "vkCreateCommandPool");
        VkCommandBufferAllocateInfo cbai{};
        cbai.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO;
        cbai.commandPool = commandPool;
        cbai.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
        cbai.commandBufferCount = 1;
        check(vkAllocateCommandBuffers(device, &cbai, &commandBuffer), "vkAllocateCommandBuffers");
        VkFenceCreateInfo fci{};
        fci.sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO;
        check(vkCreateFence(device, &fci, nullptr, &fence), "vkCreateFence");
    }

    // Grow-only host-visible, coherent storage buffer.
    void ensure(Buffer& b, VkDeviceSize size)
    {
        size = std::max<VkDeviceSize>(size, 16);
        if (b.capacity >= size) return;
        release(b);
        VkBufferCreateInfo bci{};
        bci.sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO;
        bci.size = size;
        bci.usage = VK_BUFFER_USAGE_STORAGE_BUFFER_BIT;
        bci.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
        check(vkCreateBuffer(device, &bci, nullptr, &b.buffer), "vkCreateBuffer");
        VkMemoryRequirements req;
        vkGetBufferMemoryRequirements(device, b.buffer, &req);
        VkPhysicalDeviceMemoryProperties mem;
        vkGetPhysicalDeviceMemoryProperties(physical, &mem);
        const VkMemoryPropertyFlags want = VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT;
        std::uint32_t type = std::numeric_limits<std::uint32_t>::max();
        for (std::uint32_t i = 0; i < mem.memoryTypeCount; ++i)
            if ((req.memoryTypeBits & (1u << i)) && (mem.memoryTypes[i].propertyFlags & want) == want) {
                type = i;
                break;
            }
        if (type == std::numeric_limits<std::uint32_t>::max())
            throw std::runtime_error("vkf::render::VulkanRenderer: no host-visible memory type");
        VkMemoryAllocateInfo mai{};
        mai.sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO;
        mai.allocationSize = req.size;
        mai.memoryTypeIndex = type;
        check(vkAllocateMemory(device, &mai, nullptr, &b.memory), "vkAllocateMemory");
        check(vkBindBufferMemory(device, b.buffer, b.memory, 0), "vkBindBufferMemory");
        check(vkMapMemory(device, b.memory, 0, VK_WHOLE_SIZE, 0, &b.mapped), "vkMapMemory");
        b.capacity = size;
    }
};

VulkanRenderer::VulkanRenderer(std::unique_ptr<Impl> impl) : impl_(std::move(impl)) {}
VulkanRenderer::~VulkanRenderer() = default;

std::unique_ptr<VulkanRenderer> VulkanRenderer::create(std::string* error)
{
    try {
        auto impl = std::make_unique<Impl>();
        impl->createInstance();
        if (!impl->pickDevice()) {
            if (error) *error = "no Vulkan device with a compute queue";
            return nullptr;
        }
        impl->createDevice();
        impl->createPipeline();
        return std::unique_ptr<VulkanRenderer>(new VulkanRenderer(std::move(impl)));
    } catch (const std::exception& e) {
        if (error) *error = e.what();
        return nullptr;
    }
}

std::string VulkanRenderer::deviceName() const { return impl_->name; }

void VulkanRenderer::render(const RenderPlan& planIn, const ImageView& src, const ImageView& dst)
{
    const RectI window{planIn.window.x, planIn.window.y, planIn.window.z, planIn.window.w};
    const RectI srcRect{planIn.srcRect.x, planIn.srcRect.y, planIn.srcRect.z, planIn.srcRect.w};
    if (window.empty()) return;
    if (planIn.matrixCount() < 0 || planIn.matrixCount() > motion::kMaxMotionSamples || planIn.supersample() < 1 ||
        planIn.supersample() > kMaxSupersample)
        throw std::invalid_argument("vkf::render::VulkanRenderer: malformed plan");
    if (src.type != PixelType::F32 || dst.type != PixelType::F32 || src.components != 4 || dst.components != 4)
        throw std::invalid_argument("vkf::render::VulkanRenderer: float RGBA images required");
    if (!(intersect(window, dst.bounds) == window) || dst.data == nullptr)
        throw std::invalid_argument("vkf::render::VulkanRenderer: window outside destination");
    if (!(src.bounds == srcRect) || (!srcRect.empty() && src.data == nullptr))
        throw std::invalid_argument("vkf::render::VulkanRenderer: source bounds differ from plan");

    const std::size_t srcRow = static_cast<std::size_t>(std::max(srcRect.width(), 1)) * 16;
    const std::size_t dstRow = static_cast<std::size_t>(window.width()) * 16;
    const std::size_t srcBytes = srcRow * static_cast<std::size_t>(std::max(srcRect.height(), 1));
    const std::size_t dstBytes = dstRow * static_cast<std::size_t>(window.height());
    // The shader indexes with 32-bit ints.
    constexpr std::size_t kMaxBytes = static_cast<std::size_t>(std::numeric_limits<std::int32_t>::max()) * 4;
    if (srcBytes >= kMaxBytes || dstBytes >= kMaxBytes)
        throw std::invalid_argument("vkf::render::VulkanRenderer: image too large");

    Impl& g = *impl_;
    std::lock_guard<std::mutex> lock(g.mutex);
    g.ensure(g.planBuf, sizeof(RenderPlan));
    g.ensure(g.srcBuf, srcBytes);
    g.ensure(g.dstBuf, dstBytes);

    RenderPlan plan = planIn;
    plan.srcLayout = {srcRect.x1, srcRect.y1, static_cast<std::int32_t>(srcRow / 4), 0};
    plan.dstLayout = {window.x1, window.y1, static_cast<std::int32_t>(dstRow / 4), 0};
    std::memcpy(g.planBuf.mapped, &plan, sizeof plan);
    auto* s = static_cast<std::byte*>(g.srcBuf.mapped);
    for (int y = srcRect.y1; y < srcRect.y2; ++y)
        std::memcpy(s + static_cast<std::size_t>(y - srcRect.y1) * srcRow, src.row(y),
                    static_cast<std::size_t>(srcRect.width()) * 16);

    VkDescriptorBufferInfo infos[3] = {{g.planBuf.buffer, 0, VK_WHOLE_SIZE},
                                       {g.srcBuf.buffer, 0, VK_WHOLE_SIZE},
                                       {g.dstBuf.buffer, 0, VK_WHOLE_SIZE}};
    VkWriteDescriptorSet writes[3]{};
    for (std::uint32_t i = 0; i < 3; ++i) {
        writes[i].sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET;
        writes[i].dstSet = g.descriptorSet;
        writes[i].dstBinding = i;
        writes[i].descriptorCount = 1;
        writes[i].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
        writes[i].pBufferInfo = &infos[i];
    }
    vkUpdateDescriptorSets(g.device, 3, writes, 0, nullptr);

    check(vkResetCommandBuffer(g.commandBuffer, 0), "vkResetCommandBuffer");
    VkCommandBufferBeginInfo begin{};
    begin.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO;
    begin.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
    check(vkBeginCommandBuffer(g.commandBuffer, &begin), "vkBeginCommandBuffer");
    vkCmdBindPipeline(g.commandBuffer, VK_PIPELINE_BIND_POINT_COMPUTE, g.pipeline);
    vkCmdBindDescriptorSets(g.commandBuffer, VK_PIPELINE_BIND_POINT_COMPUTE, g.pipelineLayout, 0, 1,
                            &g.descriptorSet, 0, nullptr);
    vkCmdDispatch(g.commandBuffer, (static_cast<std::uint32_t>(window.width()) + kLocalSize - 1) / kLocalSize,
                  (static_cast<std::uint32_t>(window.height()) + kLocalSize - 1) / kLocalSize, 1);
    // Make shader writes visible to the host read below.
    VkMemoryBarrier barrier{};
    barrier.sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER;
    barrier.srcAccessMask = VK_ACCESS_SHADER_WRITE_BIT;
    barrier.dstAccessMask = VK_ACCESS_HOST_READ_BIT;
    vkCmdPipelineBarrier(g.commandBuffer, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_PIPELINE_STAGE_HOST_BIT, 0, 1,
                         &barrier, 0, nullptr, 0, nullptr);
    check(vkEndCommandBuffer(g.commandBuffer), "vkEndCommandBuffer");

    VkSubmitInfo submit{};

    submit.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO;
    submit.commandBufferCount = 1;
    submit.pCommandBuffers = &g.commandBuffer;
    check(vkResetFences(g.device, 1, &g.fence), "vkResetFences");
    check(vkQueueSubmit(g.queue, 1, &submit, g.fence), "vkQueueSubmit");
    check(vkWaitForFences(g.device, 1, &g.fence, VK_TRUE, std::numeric_limits<std::uint64_t>::max()),
          "vkWaitForFences");

    const auto* d = static_cast<const std::byte*>(g.dstBuf.mapped);
    for (int y = window.y1; y < window.y2; ++y)
        std::memcpy(dst.pixel(window.x1, y), d + static_cast<std::size_t>(y - window.y1) * dstRow, dstRow);
}

}  // namespace vkf::render
