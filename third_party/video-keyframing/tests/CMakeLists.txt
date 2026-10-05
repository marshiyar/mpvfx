include(GoogleTest)

add_executable(vkf_tests
  core/CurveTests.cpp
  core/MotionTests.cpp
  core/TimeTests.cpp
  core/TrackTests.cpp
  render/CpuRendererTests.cpp)
target_link_libraries(vkf_tests PRIVATE vkf::render GTest::gtest_main vkf_warnings)

# GPU parity tests compare each backend against the CPU reference.
if(VKF_ENABLE_METAL OR VKF_ENABLE_VULKAN)
  target_sources(vkf_tests PRIVATE render/GpuParityTests.cpp)
endif()
if(VKF_ENABLE_METAL)
  target_sources(vkf_tests PRIVATE render/MetalHostPathTests.mm)
  set_source_files_properties(render/MetalHostPathTests.mm PROPERTIES COMPILE_OPTIONS "-fobjc-arc")
  target_link_libraries(vkf_tests PRIVATE vkf::render_metal "-framework Metal" "-framework Foundation")
endif()
if(VKF_ENABLE_VULKAN)
  target_link_libraries(vkf_tests PRIVATE vkf::render_vulkan)
endif()

gtest_discover_tests(vkf_tests DISCOVERY_TIMEOUT 60)

if(VKF_BUILD_OFX)
  add_subdirectory(ofx)
endif()
