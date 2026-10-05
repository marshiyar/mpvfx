# Node-API module `vkf.node`. Node-API is ABI-stable, so one build loads in
# Node and in Electron. Headers come from a Node installation (auto-detected
# from `node` on PATH, or pass -DVKF_NODE_API_INCLUDE_DIR=...).
if(NOT VKF_NODE_API_INCLUDE_DIR)
  find_program(VKF_NODE_EXECUTABLE node)
  if(VKF_NODE_EXECUTABLE)
    get_filename_component(node_bin "${VKF_NODE_EXECUTABLE}" REALPATH)
    get_filename_component(node_prefix "${node_bin}" DIRECTORY)
    get_filename_component(node_prefix "${node_prefix}" DIRECTORY)
    if(EXISTS "${node_prefix}/include/node/node_api.h")
      set(VKF_NODE_API_INCLUDE_DIR "${node_prefix}/include/node")
    endif()
  endif()
endif()
if(NOT EXISTS "${VKF_NODE_API_INCLUDE_DIR}/node_api.h")
  message(FATAL_ERROR "node_api.h not found; set VKF_NODE_API_INCLUDE_DIR")
endif()
add_library(vkf_node MODULE vkf_node.cpp)
target_include_directories(vkf_node SYSTEM PRIVATE "${VKF_NODE_API_INCLUDE_DIR}")
target_link_libraries(vkf_node PRIVATE vkf::core vkf_warnings)
target_compile_definitions(vkf_node PRIVATE VKF_VERSION_STRING="${PROJECT_VERSION}" NODE_GYP_MODULE_NAME=vkf)
set_target_properties(vkf_node PROPERTIES
  PREFIX ""
  SUFFIX ".node"
  OUTPUT_NAME "vkf"
  LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/node")
if(WIN32)
  # Electron exports Node-API symbols from electron.exe. Its node.lib and the
  # node-gyp delay-load hook must be linked into this final .node module.
  if(NOT VKF_NODE_API_LIBRARY)
    find_program(VKF_NODE_EXECUTABLE node)
    if(VKF_NODE_EXECUTABLE)
      get_filename_component(node_bin_dir "${VKF_NODE_EXECUTABLE}" DIRECTORY)
      find_file(VKF_NODE_API_LIBRARY NAMES node.lib
        PATHS "${node_bin_dir}" "${node_bin_dir}/lib" NO_DEFAULT_PATH)
    endif()
  endif()
  if(NOT EXISTS "${VKF_NODE_API_LIBRARY}")
    message(FATAL_ERROR "Electron node.lib not found; set VKF_NODE_API_LIBRARY")
  endif()
  if(NOT EXISTS "${VKF_NODE_API_DELAY_LOAD_HOOK}")
    message(FATAL_ERROR "Electron delay-load hook not found; set VKF_NODE_API_DELAY_LOAD_HOOK")
  endif()
  target_sources(vkf_node PRIVATE "${VKF_NODE_API_DELAY_LOAD_HOOK}")
  target_compile_definitions(vkf_node PRIVATE HOST_BINARY="node.exe")
  target_link_libraries(vkf_node PRIVATE "${VKF_NODE_API_LIBRARY}")
  target_link_libraries(vkf_node PRIVATE delayimp.lib)
  target_link_options(vkf_node PRIVATE /DELAYLOAD:node.exe)
  # A MODULE is a runtime DLL on Windows; Visual Studio otherwise puts it in
  # node/Release, while the desktop build expects node/vkf.node.
  set_target_properties(vkf_node PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/node"
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/node"
    RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_BINARY_DIR}/node")
endif()
if(APPLE)
  # Node-API symbols are provided by the host process at load time.
  target_link_options(vkf_node PRIVATE -undefined dynamic_lookup)
endif()

find_program(VKF_NODE_FOR_TESTS node)
if(VKF_BUILD_TESTS AND VKF_NODE_FOR_TESTS)
  add_test(NAME node_binding
    COMMAND "${VKF_NODE_FOR_TESTS}" --test "${CMAKE_CURRENT_SOURCE_DIR}/test/binding.test.mjs")
  set_tests_properties(node_binding PROPERTIES ENVIRONMENT "VKF_NODE_MODULE=$<TARGET_FILE:vkf_node>")
endif()
