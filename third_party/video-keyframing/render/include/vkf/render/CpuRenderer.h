#pragma once

#include "vkf/render/Executor.h"
#include "vkf/render/ImageView.h"
#include "vkf/render/RenderPlan.h"

namespace vkf::render {

// Reference renderer: defines the exact output every GPU backend must match.
// Writes plan.window into dst. src.bounds must equal plan.srcRect; the window
// must lie inside dst.bounds; src and dst must share pixel type and component
// count. Throws std::invalid_argument otherwise.
void renderCpu(const RenderPlan& plan, const ImageView& src, const ImageView& dst, Executor& executor);

}  // namespace vkf::render
