# OpenFX plugin bundle (see OpenFX "Packaging" reference):
#   <name>.ofx.bundle/Contents/Info.plist
#   <name>.ofx.bundle/Contents/<ARCH>/<name>.ofx
set(VKF_OFX_PLUGIN_ID "org.videokeyframing.Motion" CACHE STRING "OFX plugin identifier (reverse DNS; never change after release)")
set(VKF_OFX_BUNDLE_NAME "VKFMotion" CACHE STRING "OFX bundle / binary name")

if(APPLE)
  set(vkf_ofx_arch "MacOS")
  set(vkf_ofx_default_install "/Library/OFX/Plugins")
  option(VKF_OFX_UNIVERSAL "Build the macOS plugin as a universal (arm64 + x86_64) binary" ON)
elseif(WIN32)
  if(CMAKE_SYSTEM_PROCESSOR MATCHES "ARM64|aarch64")
    set(vkf_ofx_arch "Win-arm64")
  else()
    set(vkf_ofx_arch "Win64")
  endif()
  set(vkf_ofx_default_install "C:/Program Files/Common Files/OFX/Plugins")
else()
  # Linux-$(uname -m), with the historical name for x86_64.
  if(CMAKE_SYSTEM_PROCESSOR MATCHES "x86_64|AMD64")
    set(vkf_ofx_arch "Linux-x86-64")
  else()
    set(vkf_ofx_arch "Linux-${CMAKE_SYSTEM_PROCESSOR}")
  endif()
  set(vkf_ofx_default_install "/usr/OFX/Plugins")
endif()
set(VKF_OFX_INSTALL_DIR "${vkf_ofx_default_install}" CACHE PATH "Where `cmake --install` puts the bundle")

# Coordinate bridge: pure C++, unit tested without a host.
add_library(vkf_ofx_coords STATIC src/OfxCoords.cpp)
target_include_directories(vkf_ofx_coords PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src")
target_link_libraries(vkf_ofx_coords PUBLIC vkf::core PRIVATE vkf_warnings)

set(bundle_dir "${CMAKE_BINARY_DIR}/ofx/${VKF_OFX_BUNDLE_NAME}.ofx.bundle")
add_library(vkf_ofx MODULE src/MotionPlugin.cpp)
target_link_libraries(vkf_ofx PRIVATE vkf_ofx_coords vkf::render OpenFX::Support vkf_warnings)
target_compile_definitions(vkf_ofx PRIVATE VKF_OFX_PLUGIN_ID="${VKF_OFX_PLUGIN_ID}")
if(VKF_ENABLE_METAL)
  target_link_libraries(vkf_ofx PRIVATE vkf::render_metal)
endif()
set_target_properties(vkf_ofx PROPERTIES
  PREFIX ""
  SUFFIX ".ofx"
  OUTPUT_NAME "${VKF_OFX_BUNDLE_NAME}"
  LIBRARY_OUTPUT_DIRECTORY "${bundle_dir}/Contents/${vkf_ofx_arch}"
  RUNTIME_OUTPUT_DIRECTORY "${bundle_dir}/Contents/${vkf_ofx_arch}")
foreach(cfg ${CMAKE_CONFIGURATION_TYPES})
  string(TOUPPER "${cfg}" CFG)
  set_target_properties(vkf_ofx PROPERTIES
    LIBRARY_OUTPUT_DIRECTORY_${CFG} "${bundle_dir}/Contents/${vkf_ofx_arch}"
    RUNTIME_OUTPUT_DIRECTORY_${CFG} "${bundle_dir}/Contents/${vkf_ofx_arch}")
endforeach()

if(APPLE AND VKF_OFX_UNIVERSAL)
  # Everything linked into the plugin must carry both slices.
  set(universal_targets vkf_ofx vkf_ofx_coords vkf_core vkf_render OfxSupport)
  if(VKF_ENABLE_METAL)
    list(APPEND universal_targets vkf_render_metal)
  endif()
  set_target_properties(${universal_targets} PROPERTIES OSX_ARCHITECTURES "arm64;x86_64")
endif()

if(APPLE)
  # Apple silicon only loads signed code. "-" is an ad-hoc signature, fine for
  # local use; pass a "Developer ID Application: ..." identity for distribution.
  set(VKF_CODESIGN_IDENTITY "-" CACHE STRING "codesign identity for the plugin binary")
  add_custom_command(TARGET vkf_ofx POST_BUILD
    COMMAND codesign --force --timestamp=none --sign "${VKF_CODESIGN_IDENTITY}" "$<TARGET_FILE:vkf_ofx>"
    COMMENT "Signing ${VKF_OFX_BUNDLE_NAME}.ofx"
    VERBATIM)
endif()

if(UNIX AND NOT APPLE)
  # Keep libstdc++ symbols private so hosts with other runtimes are unaffected.
  target_link_options(vkf_ofx PRIVATE -Wl,--exclude-libs,ALL -static-libstdc++ -static-libgcc)
endif()

configure_file(Info.plist.in "${bundle_dir}/Contents/Info.plist" @ONLY)

install(DIRECTORY "${bundle_dir}" DESTINATION "${VKF_OFX_INSTALL_DIR}" USE_SOURCE_PERMISSIONS)

set(VKF_OFX_BUNDLE_DIR "${bundle_dir}" CACHE INTERNAL "")
