add_library(vkf_render STATIC
  src/CpuRenderer.cpp
  src/Executor.cpp
  src/RenderPlan.cpp)
add_library(vkf::render ALIAS vkf_render)
target_include_directories(vkf_render PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_link_libraries(vkf_render PUBLIC vkf::core PRIVATE vkf_warnings)
find_package(Threads REQUIRED)
target_link_libraries(vkf_render PUBLIC Threads::Threads)

# Metal backend: MSL is compiled at runtime from embedded source, so building
# does not depend on the (optionally installed) offline Metal toolchain.
if(VKF_ENABLE_METAL)
  add_library(vkf_render_metal STATIC src/metal/MetalRenderer.mm)
  add_library(vkf::render_metal ALIAS vkf_render_metal)
  vkf_embed_file(vkf_render_metal "${CMAKE_CURRENT_SOURCE_DIR}/shaders/motion.metal" vkf_motion_metal_source)
  target_link_libraries(vkf_render_metal PUBLIC vkf::render PRIVATE vkf_warnings
                        "-framework Metal" "-framework Foundation")
  target_compile_options(vkf_render_metal PRIVATE -fobjc-arc)
  target_compile_definitions(vkf_render_metal PUBLIC VKF_HAS_METAL=1)
endif()

# Vulkan backend: GLSL compiled to SPIR-V at build time and embedded.
if(VKF_ENABLE_VULKAN)
  set(spv "${CMAKE_CURRENT_BINARY_DIR}/motion.comp.spv")
  add_custom_command(
    OUTPUT "${spv}"
    COMMAND "${Vulkan_GLSLC_EXECUTABLE}" --target-env=vulkan1.1 -O -Werror
            "${CMAKE_CURRENT_SOURCE_DIR}/shaders/motion.comp" -o "${spv}"
    DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/shaders/motion.comp"
    COMMENT "Compiling motion.comp to SPIR-V"
    VERBATIM)
  add_library(vkf_render_vulkan STATIC src/vulkan/VulkanRenderer.cpp)
  add_library(vkf::render_vulkan ALIAS vkf_render_vulkan)
  vkf_embed_file(vkf_render_vulkan "${spv}" vkf_motion_spirv)
  target_link_libraries(vkf_render_vulkan PUBLIC vkf::render PRIVATE vkf_warnings Vulkan::Vulkan)
  target_compile_definitions(vkf_render_vulkan PUBLIC VKF_HAS_VULKAN=1)
endif()
