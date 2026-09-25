#include "vkf/anim/Curve.h"

#include <algorithm>
#include <cmath>

namespace vkf::anim {

namespace {

template <class K>
auto findByTime(std::vector<K>& keys, const Time& time)
{
    return std::lower_bound(keys.begin(), keys.end(), time,
                            [](const K& k, const Time& t) { return k.time < t; });
}

template <class K>
void insertOrReplace(std::vector<K>& keys, const K& key)
{
    auto it = findByTime(keys, key.time);
    if (it != keys.end() && it->time == key.time)
        *it = key;
    else
        keys.insert(it, key);
}

template <class K>
bool eraseAt(std::vector<K>& keys, const Time& time)
{
    auto it = findByTime(keys, time);
    if (it == keys.end() || !(it->time == time)) return false;
    keys.erase(it);
    return true;
}

template <class K>
detail::TemporalKey temporalFrom(const K& k, double v)
{
    return {k.time.seconds(), v, k.inInterp, k.outInterp, k.inEase, k.outEase};
}

}  // namespace

// ---------------------------------------------------------------- Curve1D

void Curve1D::setKey(const Keyframe1D& key)
{
    insertOrReplace(keys_, key);
    rebuild();
}

bool Curve1D::removeKey(const Time& time)
{
    const bool removed = eraseAt(keys_, time);
    if (removed) rebuild();
    return removed;
}

void Curve1D::clear()
{
    keys_.clear();
    rebuild();
}

void Curve1D::rebuild()
{
    temporal_.clear();
    temporal_.reserve(keys_.size());
    for (const Keyframe1D& k : keys_) temporal_.push_back(temporalFrom(k, k.value));
}

double Curve1D::evaluate(double seconds) const
{
    if (temporal_.empty()) return default_;
    return detail::evaluate(temporal_, seconds);
}

// ---------------------------------------------------------------- Curve2D

void Curve2D::setKey(const Keyframe2D& key)
{
    insertOrReplace(keys_, key);
    rebuild();
}

bool Curve2D::removeKey(const Time& time)
{
    const bool removed = eraseAt(keys_, time);
    if (removed) rebuild();
    return removed;
}

void Curve2D::clear()
{
    keys_.clear();
    rebuild();
}

double Curve2D::segmentLength(int i) const
{
    return segments_.at(static_cast<std::size_t>(i)).length();
}

void Curve2D::rebuild()
{
    const int n = static_cast<int>(keys_.size());
    auto pos = [&](int j) { return keys_[static_cast<std::size_t>(std::clamp(j, 0, n - 1))].value; };

    segments_.clear();
    temporal_.clear();
    double cumulative = 0.0;
    for (int i = 0; i < n; ++i) {
        temporal_.push_back(temporalFrom(keys_[i], cumulative));
        if (i == n - 1) break;

        const Keyframe2D& k0 = keys_[i];
        const Keyframe2D& k1 = keys_[i + 1];
        Vec2 outTan{}, inTan{};
        switch (k0.spatial) {
            case Spatial::Linear: break;
            case Spatial::Bezier: outTan = k0.outTangent; break;
            case Spatial::AutoBezier: outTan = (pos(i + 1) - pos(i - 1)) / 6.0; break;
        }
        switch (k1.spatial) {
            case Spatial::Linear: break;
            case Spatial::Bezier: inTan = k1.inTangent; break;
            case Spatial::AutoBezier: inTan = -(pos(i + 2) - pos(i)) / 6.0; break;
        }

        CubicPath seg(k0.value, k0.value + outTan, k1.value + inTan, k1.value);
        cumulative += seg.length();
        segments_.push_back(std::move(seg));
    }
}

Vec2 Curve2D::evaluate(double seconds) const
{
    const int n = static_cast<int>(keys_.size());
    if (n == 0) return default_;
    const int i = detail::findSegment(temporal_, seconds);
    if (i < 0) return keys_.front().value;
    if (i >= n - 1) return keys_.back().value;
    if (detail::isHold(temporal_, i)) return keys_[i].value;

    const CubicPath& seg = segments_[static_cast<std::size_t>(i)];
    const double s = detail::evaluateSegment(temporal_, i, seconds) - temporal_[i].v;
    return seg.point(seg.parameterAt(std::clamp(s, 0.0, seg.length())));
}

}  // namespace vkf::anim
