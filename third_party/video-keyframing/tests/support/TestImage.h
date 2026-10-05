#pragma once

#include <cstdint>
#include <cstring>
#include <random>
#include <vector>

#include "vkf/render/ImageView.h"

namespace vkf::test {

// Owning image for tests. Stored top-down unless bottomUp is set, in which case
// rowBytes is negative (the view's data pointer is the last memory row).
struct TestImage {
    std::vector<std::byte> storage;
    render::ImageView view;

    TestImage(RectI bounds, render::PixelType type, int components, bool bottomUp = false)
    {
        const std::ptrdiff_t rowBytes =
            static_cast<std::ptrdiff_t>(bounds.width()) * components * render::bytesPerComponent(type);
        storage.assign(static_cast<std::size_t>(rowBytes * std::max(bounds.height(), 0)), std::byte{0});
        view.bounds = bounds;
        view.type = type;
        view.components = components;
        view.rowBytes = bottomUp ? -rowBytes : rowBytes;
        view.data = storage.empty() ? nullptr
                                    : storage.data() + (bottomUp ? rowBytes * (bounds.height() - 1) : 0);
    }

    float* f(int x, int y) { return reinterpret_cast<float*>(view.pixel(x, y)); }
    const float* f(int x, int y) const { return reinterpret_cast<const float*>(view.pixel(x, y)); }

    void fillRandom(std::uint32_t seed)
    {
        std::mt19937 rng(seed);
        std::uniform_real_distribution<float> dist(0.0f, 1.0f);
        for (int y = view.bounds.y1; y < view.bounds.y2; ++y) {
            for (int x = view.bounds.x1; x < view.bounds.x2; ++x) {
                std::byte* p = view.pixel(x, y);
                for (int c = 0; c < view.components; ++c) {
                    const float v = dist(rng);
                    switch (view.type) {
                        case render::PixelType::F32: reinterpret_cast<float*>(p)[c] = v; break;
                        case render::PixelType::U16:
                            reinterpret_cast<std::uint16_t*>(p)[c] = static_cast<std::uint16_t>(v * 65535.f);
                            break;
                        case render::PixelType::U8:
                            reinterpret_cast<std::uint8_t*>(p)[c] = static_cast<std::uint8_t>(v * 255.f);
                            break;
                    }
                }
                // Keep RGBA float images premultiplied-valid: colour <= alpha.
                if (view.type == render::PixelType::F32 && view.components == 4) {
                    float* q = reinterpret_cast<float*>(p);
                    q[0] *= q[3];
                    q[1] *= q[3];
                    q[2] *= q[3];
                }
            }
        }
    }

    bool rowsEqual(const TestImage& o, const RectI& r) const
    {
        const std::size_t bytes =
            static_cast<std::size_t>(r.width()) * view.components * render::bytesPerComponent(view.type);
        for (int y = r.y1; y < r.y2; ++y)
            if (std::memcmp(view.pixel(r.x1, y), o.view.pixel(r.x1, y), bytes) != 0) return false;
        return true;
    }
};

}  // namespace vkf::test
