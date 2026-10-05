target_sources(vkf_tests PRIVATE OfxCoordsTests.cpp)
target_link_libraries(vkf_tests PRIVATE vkf_ofx_coords)

# End-to-end: NatronRenderer loads the built bundle and renders keyframed
# transforms; results are compared with the CPU engine by natron_check.
find_program(VKF_NATRON_RENDERER NatronRenderer
  PATHS /Applications/Natron.app/Contents/MacOS "C:/Program Files/Natron/bin" /opt/Natron/bin)
find_package(Python3 COMPONENTS Interpreter)
if(VKF_NATRON_RENDERER AND Python3_FOUND)
  add_executable(vkf_natron_reference NatronReference.cpp)
  target_link_libraries(vkf_natron_reference PRIVATE vkf_ofx_coords vkf::render vkf_warnings)
  add_test(NAME natron_end_to_end
    COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/natron_e2e.py"
            --natron "${VKF_NATRON_RENDERER}"
            --bundle-parent "${CMAKE_BINARY_DIR}/ofx"
            --plugin-id "${VKF_OFX_PLUGIN_ID}"
            --reference "$<TARGET_FILE:vkf_natron_reference>"
            --work "${CMAKE_CURRENT_BINARY_DIR}/natron_work")
  set_tests_properties(natron_end_to_end PROPERTIES TIMEOUT 300 LABELS "integration")
else()
  message(STATUS "NatronRenderer not found: end-to-end OFX test disabled")
endif()
