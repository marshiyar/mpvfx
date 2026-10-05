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
if(WIN32)
  message(FATAL_ERROR "The Node-API module needs node.lib on Windows; not configured yet")
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
