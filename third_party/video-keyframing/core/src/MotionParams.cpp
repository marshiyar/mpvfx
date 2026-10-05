#include "vkf/motion/MotionParams.h"

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <string>

namespace vkf::motion {

namespace {

[[noreturn]] void kindMismatch(ParamId id)
{
    throw std::invalid_argument("vkf::motion: wrong accessor for parameter '" + std::string(spec(id).key) + "'");
}

double clampToSpec(ParamId id, double v)
{
    const ParamSpec& s = spec(id);
    if (!std::isfinite(v)) v = s.defaultRef == DefaultRef::Absolute ? s.defaultValue : 0.0;
    return std::clamp(v, s.min, s.max);
}

}  // namespace

MotionParams defaultParams(FrameSize sequence, FrameSize clip)
{
    MotionParams p;
    for (const ParamSpec& s : kSchema) {
        if (s.kind == ParamKind::Double2D) {
            const FrameSize f = s.id == ParamId::AnchorPoint ? clip : sequence;
            setVec2(p, s.id, s.defaultRef == DefaultRef::FrameCenter ? Vec2{f.width * 0.5, f.height * 0.5}
                                                                     : Vec2{s.defaultValue, s.defaultValue});
        } else {
            setScalar(p, s.id, s.defaultValue);
        }
    }
    return p;
}

double getScalar(const MotionParams& p, ParamId id)
{
    switch (id) {
        case ParamId::Scale: return p.scale;
        case ParamId::Rotation: return p.rotation;
        case ParamId::AntiFlicker: return p.antiFlicker;
        case ParamId::Opacity: return p.opacity;
        case ParamId::Quality: return static_cast<double>(p.quality);
        case ParamId::MotionBlur: return p.motionBlur ? 1.0 : 0.0;
        case ParamId::ShutterAngle: return p.shutterAngle;
        case ParamId::ShutterPhase: return p.shutterPhase;
        case ParamId::MotionBlurSamples: return static_cast<double>(p.motionBlurSamples);
        case ParamId::Position:
        case ParamId::AnchorPoint:
        case ParamId::Count: break;
    }
    kindMismatch(id);
}

void setScalar(MotionParams& p, ParamId id, double value)
{
    if (id == ParamId::Count || spec(id).kind == ParamKind::Double2D) kindMismatch(id);
    const double v = clampToSpec(id, value);
    switch (id) {
        case ParamId::Scale: p.scale = v; return;
        case ParamId::Rotation: p.rotation = v; return;
        case ParamId::AntiFlicker: p.antiFlicker = v; return;
        case ParamId::Opacity: p.opacity = v; return;
        case ParamId::Quality: p.quality = static_cast<Quality>(static_cast<int>(std::lround(v))); return;
        case ParamId::MotionBlur: p.motionBlur = v >= 0.5; return;
        case ParamId::ShutterAngle: p.shutterAngle = v; return;
        case ParamId::ShutterPhase: p.shutterPhase = v; return;
        case ParamId::MotionBlurSamples: p.motionBlurSamples = static_cast<int>(std::lround(v)); return;
        case ParamId::Position:
        case ParamId::AnchorPoint:
        case ParamId::Count: break;
    }
    kindMismatch(id);
}

Vec2 getVec2(const MotionParams& p, ParamId id)
{
    if (id == ParamId::Position) return p.position;
    if (id == ParamId::AnchorPoint) return p.anchorPoint;
    kindMismatch(id);
}

void setVec2(MotionParams& p, ParamId id, Vec2 value)
{
    const Vec2 v{clampToSpec(id, value.x), clampToSpec(id, value.y)};
    if (id == ParamId::Position)
        p.position = v;
    else if (id == ParamId::AnchorPoint)
        p.anchorPoint = v;
    else
        kindMismatch(id);
}

}  // namespace vkf::motion
