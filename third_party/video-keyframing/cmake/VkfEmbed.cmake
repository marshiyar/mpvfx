# vkf_embed_file(<target> <input> <symbol>)
# Generates a .cpp defining `extern const unsigned char <symbol>[]` and
# `extern const std::size_t <symbol>_size` from <input> and adds it to <target>.
# The generated data is followed by a NUL byte (not counted in the size), so
# text files can be used directly as C strings.
function(vkf_embed_file target input symbol)
  set(out "${CMAKE_CURRENT_BINARY_DIR}/embed/${symbol}.cpp")
  add_custom_command(
    OUTPUT "${out}"
    COMMAND "${CMAKE_COMMAND}" -DINPUT=${input} -DOUTPUT=${out} -DSYMBOL=${symbol}
            -P "${VKF_EMBED_SCRIPT}"
    DEPENDS "${input}" "${VKF_EMBED_SCRIPT}"
    COMMENT "Embedding ${symbol}"
    VERBATIM)
  target_sources(${target} PRIVATE "${out}")
endfunction()

set(VKF_EMBED_SCRIPT "${CMAKE_CURRENT_LIST_DIR}/VkfEmbedScript.cmake" CACHE INTERNAL "")
