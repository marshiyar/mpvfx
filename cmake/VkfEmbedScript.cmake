# Script mode: cmake -DINPUT=... -DOUTPUT=... -DSYMBOL=... -P VkfEmbedScript.cmake
file(READ "${INPUT}" hex HEX)
string(LENGTH "${hex}" hexlen)
math(EXPR size "${hexlen} / 2")
string(REGEX REPLACE "([0-9a-f][0-9a-f])" "0x\\1," bytes "${hex}")
string(REGEX REPLACE "(0x..,0x..,0x..,0x..,0x..,0x..,0x..,0x..,0x..,0x..,0x..,0x..,0x..,0x..,0x..,0x..,)"
                     "\\1\n  " bytes "${bytes}")
file(WRITE "${OUTPUT}"
"// Generated from ${INPUT}. Do not edit.
#include <cstddef>
extern const unsigned char ${SYMBOL}[];
extern const std::size_t ${SYMBOL}_size;
alignas(16) const unsigned char ${SYMBOL}[] = {
  ${bytes}0x00};
const std::size_t ${SYMBOL}_size = ${size};
")
