#include "vkf/motion/AnimatedMotion.h"

#include <stdexcept>
#include <string>

namespace vkf::motion {

namespace {

std::size_t index(ParamId id) { return static_cast<std::size_t>(id); }

void require(ParamId id, bool ok, const char* what)
{
    if (id == ParamId::Count || !ok)
        throw std::invalid_argument(std::string("vkf::motion::AnimatedMotion: ") + what);
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
    require(id, spec(id).kind == ParamKind::Double && spec(id).animatable, "not an animatable scalar");
    return scalars_[index(id)];
}

const anim::Curve1D& AnimatedMotion::curve(ParamId id) const
{
    return const_cast<AnimatedMotion*>(this)->curve(id);
}

anim::Curve2D& AnimatedMotion::curve2D(ParamId id)
{
    require(id, spec(id).kind == ParamKind::Double2D && spec(id).animatable, "not an animatable 2D value");
    return points_[index(id)];
}

const anim::Curve2D& AnimatedMotion::curve2D(ParamId id) const
{
    return const_cast<AnimatedMotion*>(this)->curve2D(id);
}

void AnimatedMotion::setStatic(ParamId id, double value)
{
    require(id, !spec(id).animatable && spec(id).kind != ParamKind::Double2D, "not a static parameter");
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
