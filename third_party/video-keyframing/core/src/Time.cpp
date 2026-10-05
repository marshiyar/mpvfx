#include "vkf/core/Time.h"

#include <numeric>
#include <stdexcept>

namespace vkf {

namespace {

// Floor division for den > 0.
std::int64_t floorDiv(std::int64_t n, std::int64_t d)
{
    std::int64_t q = n / d;
    if ((n % d) != 0 && n < 0) --q;
    return q;
}

// Exact comparison of a/b and c/d (b, d > 0) without overflow, by comparing
// integer parts and recursing on the reciprocal of the remainders.
std::strong_ordering compareFractions(std::int64_t a, std::int64_t b, std::int64_t c, std::int64_t d)
{
    for (;;) {
        const std::int64_t qa = floorDiv(a, b);
        const std::int64_t qc = floorDiv(c, d);
        if (qa != qc) return qa <=> qc;
        const std::int64_t ra = a - qa * b;  // 0 <= ra < b
        const std::int64_t rc = c - qc * d;
        if (ra == 0 || rc == 0) return ra <=> rc;
        // ra/b vs rc/d  <=>  d/rc vs b/ra  (reversed)
        a = d;
        c = b;
        b = rc;
        d = ra;
    }
}

}  // namespace

Time::Time(std::int64_t num, std::int64_t den)
{
    if (den == 0) throw std::invalid_argument("vkf::Time: zero denominator");
    if (den < 0) {
        num = -num;
        den = -den;
    }
    const std::int64_t g = std::gcd(num, den);
    num_ = num / g;
    den_ = den / g;
}

Time Time::fromFrame(std::int64_t frame, std::int64_t fpsNum, std::int64_t fpsDen)
{
    if (fpsNum <= 0 || fpsDen <= 0) throw std::invalid_argument("vkf::Time: invalid frame rate");
    // seconds = frame / (fpsNum / fpsDen) = frame * fpsDen / fpsNum; reduce first to limit overflow.
    const std::int64_t g = std::gcd(frame, fpsNum);
    const std::int64_t fnum = g ? frame / g : frame;
    const std::int64_t fden = g ? fpsNum / g : fpsNum;
    return Time(fnum * fpsDen, fden);
}

std::strong_ordering operator<=>(const Time& a, const Time& b)
{
    if (a == b) return std::strong_ordering::equal;
    return compareFractions(a.num_, a.den_, b.num_, b.den_);
}

}  // namespace vkf
