#pragma once

#include <array>
#include <cstdint>
#include <span>
#include <string_view>

// The single source of truth for every Motion effect parameter. Host adapters,
// UIs, animation storage and tests iterate this table; nothing else may
// restate a parameter's key, unit, default or range.
namespace vkf::motion {

enum class ParamId : std::uint8_t {
    Position,
    Scale,
    Rotation,
    AnchorPoint,
    AntiFlicker,
    Opacity,
    Quality,
    MotionBlur,
    ShutterAngle,
    ShutterPhase,
    MotionBlurSamples,
    Count
};

enum class ParamKind : std::uint8_t { Double, Double2D, Int, Bool, Choice };

enum class Unit : std::uint8_t { None, Pixels, Percent, Degrees, Fraction };

// How a default is resolved. FrameCenter: the centre of the frame the value
// lives in (sequence frame for Position, clip frame for Anchor Point).
enum class DefaultRef : std::uint8_t { Absolute, FrameCenter };

enum class Quality : std::uint8_t { Draft = 0, High = 1 };

struct ParamSpec {
    ParamId id;
    std::string_view key;    // permanent identifier; never renamed or reused
    std::string_view label;
    std::string_view hint;
    std::string_view group;
    ParamKind kind;
    Unit unit;
    DefaultRef defaultRef;
    double defaultValue;     // Absolute defaults; for Bool 0/1, for Choice the index
    double min;
    double max;
    double displayMin;
    double displayMax;
    bool animatable;
    std::span<const std::string_view> choices;
};

inline constexpr std::string_view kGroupMotion = "Motion";
inline constexpr std::string_view kGroupOpacity = "Opacity";
inline constexpr std::string_view kGroupRender = "Render";

inline constexpr std::array<std::string_view, 2> kQualityChoices = {"Draft", "High"};

inline constexpr double kHuge = 1e7;

inline constexpr std::array<ParamSpec, static_cast<std::size_t>(ParamId::Count)> kSchema = {{
    {ParamId::Position, "position", "Position",
     "Location of the anchor point in the sequence frame, in sequence pixels.", kGroupMotion,
     ParamKind::Double2D, Unit::Pixels, DefaultRef::FrameCenter, 0.0, -kHuge, kHuge, -kHuge, kHuge, true, {}},
    {ParamId::Scale, "scale", "Scale", "Uniform scale around the anchor point, in percent.", kGroupMotion,
     ParamKind::Double, Unit::Percent, DefaultRef::Absolute, 100.0, 0.0, 10000.0, 0.0, 600.0, true, {}},
    {ParamId::Rotation, "rotation", "Rotation",
     "Rotation around the anchor point in degrees, clockwise. Values beyond 360 are extra turns.",
     kGroupMotion, ParamKind::Double, Unit::Degrees, DefaultRef::Absolute, 0.0, -kHuge, kHuge, -360.0, 360.0,
     true, {}},
    {ParamId::AnchorPoint, "anchorPoint", "Anchor Point",
     "Pivot for scale and rotation, in clip pixels.", kGroupMotion, ParamKind::Double2D, Unit::Pixels,
     DefaultRef::FrameCenter, 0.0, -kHuge, kHuge, -kHuge, kHuge, true, {}},
    {ParamId::AntiFlicker, "antiFlicker", "Anti-flicker Filter",
     "Vertical softening that reduces interlace twitter on fine horizontal detail.", kGroupMotion,
     ParamKind::Double, Unit::Fraction, DefaultRef::Absolute, 0.0, 0.0, 1.0, 0.0, 1.0, true, {}},
    {ParamId::Opacity, "opacity", "Opacity", "Opacity in percent.", kGroupOpacity, ParamKind::Double,
     Unit::Percent, DefaultRef::Absolute, 100.0, 0.0, 100.0, 0.0, 100.0, true, {}},
    {ParamId::Quality, "quality", "Quality",
     "Draft: bilinear. High: bicubic with adaptive supersampling when shrinking.", kGroupRender,
     ParamKind::Choice, Unit::None, DefaultRef::Absolute, 1.0, 0.0, 1.0, 0.0, 1.0, false, kQualityChoices},
    {ParamId::MotionBlur, "motionBlur", "Motion Blur", "Blur along the motion of animated transforms.",
     kGroupRender, ParamKind::Bool, Unit::None, DefaultRef::Absolute, 0.0, 0.0, 1.0, 0.0, 1.0, false, {}},
    {ParamId::ShutterAngle, "shutterAngle", "Shutter Angle",
     "Portion of the frame the shutter is open, in degrees (360 = one full frame).", kGroupRender,
     ParamKind::Double, Unit::Degrees, DefaultRef::Absolute, 180.0, 0.0, 720.0, 0.0, 360.0, false, {}},
    {ParamId::ShutterPhase, "shutterPhase", "Shutter Phase",
     "When the shutter opens relative to the frame, in degrees (-90 with 180 centres the blur).",
     kGroupRender, ParamKind::Double, Unit::Degrees, DefaultRef::Absolute, -90.0, -360.0, 360.0, -360.0, 360.0,
     false, {}},
    {ParamId::MotionBlurSamples, "motionBlurSamples", "Samples", "Motion blur samples per frame.",
     kGroupRender, ParamKind::Int, Unit::None, DefaultRef::Absolute, 8.0, 1.0, 64.0, 1.0, 32.0, false, {}},
}};

constexpr const ParamSpec& spec(ParamId id) { return kSchema[static_cast<std::size_t>(id)]; }

inline constexpr int kMaxMotionSamples = 64;

namespace detail {
consteval bool schemaIsConsistent()
{
    for (std::size_t i = 0; i < kSchema.size(); ++i) {
        const ParamSpec& s = kSchema[i];
        if (static_cast<std::size_t>(s.id) != i) return false;
        if (s.key.empty() || s.label.empty()) return false;
        if (s.min > s.max || s.displayMin > s.displayMax) return false;
        if (s.defaultRef == DefaultRef::Absolute && (s.defaultValue < s.min || s.defaultValue > s.max)) return false;
        if ((s.kind == ParamKind::Choice) != !s.choices.empty()) return false;
        if (s.kind == ParamKind::Choice && s.max != static_cast<double>(s.choices.size() - 1)) return false;
        for (std::size_t j = 0; j < i; ++j)
            if (kSchema[j].key == s.key) return false;
    }
    return true;
}
}  // namespace detail

static_assert(detail::schemaIsConsistent(), "MotionSchema table is inconsistent");
static_assert(spec(ParamId::MotionBlurSamples).max == kMaxMotionSamples);

}  // namespace vkf::motion
