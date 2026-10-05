add_library(vkf_core STATIC
  src/AnimatedMotion.cpp
  src/CubicPath.cpp
  src/Curve.cpp
  src/MotionParams.cpp
  src/Temporal.cpp
  src/Time.cpp
  src/Track.cpp
  src/Transform.cpp)
add_library(vkf::core ALIAS vkf_core)
target_include_directories(vkf_core PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_compile_features(vkf_core PUBLIC cxx_std_20)
target_link_libraries(vkf_core PRIVATE vkf_warnings)
