#include "vkf/motion/AnimatedMotion.h"

#include <stdexcept>
#include <string>

namespace vkf::motion {

namespace {

std::size_t index(ParamId id) { return static_cast<std::size_t>(id); }

const ParamSpec& checkedSpec(ParamId id)
{
    if (index(id) >= kSchema.size())
        throw std::invalid_argument("vkf::motion::AnimatedMotion: unknown parameter");
    return spec(id);
}

void require(bool ok, const char* what)
{
    if (!ok) throw std::invalid_argument(std::string("vkf::motion::AnimatedMotion: ") + what);
}

}  // namespace

AnimatedMotion::AnimatedMotion(FrameSize sequence, FrameSize clip) : statics_(defaultParams(sequence, clip))
{
    for (const ParamSpec& s : kSchema) {
        if (s.kind == ParamKind::Double2D)
            points_[index(s.id)].setDefaultValue(getVec2(statics_, s.id));
        else
            scalars_[index(s.id)].setDefaultValue(getScalar(statics_, s.id));
    }
}

anim::Curve1D& AnimatedMotion::curve(ParamId id)
{
    const ParamSpec& s = checkedSpec(id);
    require(s.kind == ParamKind::Double && s.animatable, "not an animatable scalar");
    return scalars_[index(id)];
}

const anim::Curve1D& AnimatedMotion::curve(ParamId id) const
{
    return const_cast<AnimatedMotion*>(this)->curve(id);
}

anim::Curve2D& AnimatedMotion::curve2D(ParamId id)
{
    const ParamSpec& s = checkedSpec(id);
    require(s.kind == ParamKind::Double2D && s.animatable, "not an animatable 2D value");
    return points_[index(id)];
}

const anim::Curve2D& AnimatedMotion::curve2D(ParamId id) const
{
    return const_cast<AnimatedMotion*>(this)->curve2D(id);
}

void AnimatedMotion::setStatic(ParamId id, double value)
{
    const ParamSpec& s = checkedSpec(id);
    require(!s.animatable && s.kind != ParamKind::Double2D, "not a static parameter");
    setScalar(statics_, id, value);
}

MotionParams AnimatedMotion::evaluate(double seconds) const
{
    MotionParams p = statics_;
    for (const ParamSpec& s : kSchema) {
        if (!s.animatable) continue;
        if (s.kind == ParamKind::Double2D)
            setVec2(p, s.id, points_[index(s.id)].evaluate(seconds));
        else
            setScalar(p, s.id, scalars_[index(s.id)].evaluate(seconds));
    }
    return p;
}

}  // namespace vkf::motion
