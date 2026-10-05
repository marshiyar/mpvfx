#pragma once

#include <cstddef>
#include <cstdint>

#include "vkf/core/Math.h"

namespace vkf::render {

enum class PixelType : std::uint8_t { U8, U16, F32 };

constexpr int bytesPerComponent(PixelType t)
{
    return t == PixelType::U8 ? 1 : t == PixelType::U16 ? 2 : 4;
}

// Non-owning view of a CPU image. `data` points at pixel (bounds.x1,
// bounds.y1); row y starts at data + (y - bounds.y1) * rowBytes. rowBytes may
// be negative (bottom-up storage). Components: 1 (alpha), 3 (RGB), 4 (RGBA).
struct ImageView {
    void* data = nullptr;
    std::ptrdiff_t rowBytes = 0;
    RectI bounds;
    PixelType type = PixelType::F32;
    int components = 4;

    std::byte* row(int y) const
    {
        return static_cast<std::byte*>(data) + static_cast<std::ptrdiff_t>(y - bounds.y1) * rowBytes;
    }
    std::byte* pixel(int x, int y) const
    {
        return row(y) + static_cast<std::ptrdiff_t>(x - bounds.x1) * components * bytesPerComponent(type);
    }
};

}  // namespace vkf::render
