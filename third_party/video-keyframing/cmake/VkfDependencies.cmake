include(FetchContent)

# OpenFX 1.5.1 (BSD-3-Clause). We only compile its C++ Support library
# ourselves; SOURCE_SUBDIR points at a path without a CMakeLists.txt so the
# upstream Conan-based build is not pulled in.
# Offline builds: -DFETCHCONTENT_SOURCE_DIR_OPENFX=/path/to/openfx
if(VKF_BUILD_OFX)
  FetchContent_Declare(
    openfx
    URL https://github.com/AcademySoftwareFoundation/openfx/archive/refs/tags/OFX_Release_1.5.1.tar.gz
    URL_HASH SHA256=8c5766e2e0896b79fab226a07c9effb52793f6bb14d0d30cf4631fddb5f87e84
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE
    SOURCE_SUBDIR "vkf-no-cmake")
  FetchContent_MakeAvailable(openfx)

  file(GLOB VKF_OFX_SUPPORT_SOURCES CONFIGURE_DEPENDS "${openfx_SOURCE_DIR}/Support/Library/*.cpp")
  add_library(OfxSupport STATIC ${VKF_OFX_SUPPORT_SOURCES})
  target_include_directories(OfxSupport SYSTEM PUBLIC "${openfx_SOURCE_DIR}/include"
                                                      "${openfx_SOURCE_DIR}/Support/include")
  add_library(OpenFX::Support ALIAS OfxSupport)
endif()

if(VKF_BUILD_TESTS)
  # Offline builds: -DFETCHCONTENT_SOURCE_DIR_GOOGLETEST=/path/to/googletest
  FetchContent_Declare(
    googletest
    URL https://github.com/google/googletest/archive/refs/tags/v1.15.2.tar.gz
    URL_HASH SHA256=7b42b4d6ed48810c5362c265a17faebe90dc2373c885e5216439d37927f02926
    SYSTEM
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
  set(INSTALL_GTEST OFF CACHE BOOL "" FORCE)
  set(gtest_force_shared_crt ON CACHE BOOL "" FORCE)
  FetchContent_MakeAvailable(googletest)
endif()

if(VKF_ENABLE_VULKAN)
  find_package(Vulkan COMPONENTS glslc)
  if(NOT Vulkan_FOUND OR NOT Vulkan_GLSLC_EXECUTABLE)
    message(WARNING "Vulkan SDK or glslc not found: Vulkan backend disabled")
    # Normal variable: re-evaluated on every configure, so installing the SDK
    # later re-enables the backend without clearing the cache.
    set(VKF_ENABLE_VULKAN OFF)
  endif()
endif()
