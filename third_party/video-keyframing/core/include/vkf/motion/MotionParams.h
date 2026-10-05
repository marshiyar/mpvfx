#pragma once

#include "vkf/core/Math.h"
#include "vkf/motion/MotionSchema.h"

namespace vkf::motion {

// Motion effect values at one instant, in core ("Premiere") space:
// pixel units, origin top-left, y down, rotation clockwise in degrees.
struct MotionParams {
    Vec2 position;
    double scale = 100.0;
    double rotation = 0.0;
    Vec2 anchorPoint;
    double antiFlicker = 0.0;
    double opacity = 100.0;
    Quality quality = Quality::High;
    bool motionBlur = false;
    double shutterAngle = 180.0;
    double shutterPhase = -90.0;
    int motionBlurSamples = 8;
};

struct FrameSize {
    double width = 0.0;
    double height = 0.0;
};

// Defaults resolved from the schema: Position at the sequence centre, Anchor
// Point at the clip centre, everything else from kSchema.
MotionParams defaultParams(FrameSize sequence, FrameSize clip);

// Generic, schema-driven access. Scalar kinds (Double, Int, Bool, Choice) use
// getScalar/setScalar; Double2D uses getVec2/setVec2. Values are clamped to
// the schema range on set. Throws std::invalid_argument on a kind mismatch.
double getScalar(const MotionParams& p, ParamId id);
void setScalar(MotionParams& p, ParamId id, double value);
Vec2 getVec2(const MotionParams& p, ParamId id);
void setVec2(MotionParams& p, ParamId id, Vec2 value);

}  // namespace vkf::motion
