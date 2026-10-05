// OpenFX adapter for the Motion effect. Thin by design: parameters are
// declared from MotionSchema, values are read from the host (which owns and
// interpolates keyframes), coordinates are converted by OfxCoords, and all
// sampling decisions come from vkf::render.
#include <algorithm>
#include <array>
#include <cmath>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

#include "ofxsImageEffect.h"
#include "ofxsMultiThread.h"

#include "OfxCoords.h"
#include "vkf/motion/MotionSchema.h"
#include "vkf/motion/Transform.h"
#include "vkf/render/CpuRenderer.h"
#include "vkf/render/RenderPlan.h"
#if VKF_HAS_METAL
#include "vkf/render/MetalRenderer.h"
#endif

#ifndef VKF_OFX_PLUGIN_ID
#error "VKF_OFX_PLUGIN_ID must be defined by the build"
#endif

namespace {

using namespace vkf;
using motion::ParamId;
using motion::ParamKind;
using motion::ParamSpec;

constexpr const char* kPluginLabel = "Motion";
constexpr const char* kPluginGrouping = "Transform";
constexpr const char* kPluginDescription =
    "Premiere-style Motion: Position, Scale, Rotation, Anchor Point, Anti-flicker Filter and Opacity, "
    "with motion blur. Keyframe any parameter with the host's keyframe tools.";
constexpr unsigned kVersionMajor = 1;  // bump only when parameters change incompatibly
constexpr unsigned kVersionMinor = 0;

constexpr std::size_t kParamCount = static_cast<std::size_t>(ParamId::Count);

std::string str(std::string_view s) { return std::string(s); }

render::PixelType toPixelType(OFX::BitDepthEnum d)
{
    switch (d) {
        case OFX::eBitDepthUByte: return render::PixelType::U8;
        case OFX::eBitDepthUShort: return render::PixelType::U16;
        case OFX::eBitDepthFloat: return render::PixelType::F32;
        default: OFX::throwSuiteStatusException(kOfxStatErrFormat);
    }
    return render::PixelType::F32;
}

int toComponents(OFX::PixelComponentEnum c)
{
    switch (c) {
        case OFX::ePixelComponentRGBA: return 4;
        case OFX::ePixelComponentRGB: return 3;
        case OFX::ePixelComponentAlpha: return 1;
        default: OFX::throwSuiteStatusException(kOfxStatErrFormat);
    }
    return 4;
}

RectI toRectI(const OfxRectI& r) { return {r.x1, r.y1, r.x2, r.y2}; }

render::ImageView viewOf(OFX::Image& img)
{
    render::ImageView v;
    v.data = img.getPixelData();
    v.rowBytes = img.getRowBytes();
    v.bounds = toRectI(img.getBounds());
    v.type = toPixelType(img.getPixelDepth());
    v.components = toComponents(img.getPixelComponents());
    return v;
}

// Runs the CPU renderer on the host's thread pool.
class HostExecutor final : public render::Executor {
public:
    void parallelFor(int count, const std::function<void(int, int)>& fn) override
    {
        if (count <= 0) return;
        struct Job final : OFX::MultiThread::Processor {
            int total_;
            const std::function<void(int, int)>& body_;
            Job(int total, const std::function<void(int, int)>& body) : total_(total), body_(body) {}
            void multiThreadFunction(unsigned int id, unsigned int n) override
            {
                const auto begin = static_cast<int>(static_cast<long long>(total_) * id / n);
                const auto end = static_cast<int>(static_cast<long long>(total_) * (id + 1) / n);
                if (end > begin) body_(begin, end);
            }
        } job(count, fn);
        job.multiThread(std::min<unsigned>(OFX::MultiThread::getNumCPUs(), static_cast<unsigned>(count)));
    }
};

#if VKF_HAS_METAL
render::MetalRenderer* sharedMetal()
{
    static std::once_flag once;
    static std::unique_ptr<render::MetalRenderer> renderer;
    std::call_once(once, [] { renderer = render::MetalRenderer::create(); });
    return renderer.get();
}
#endif

// Matrices and settings for one render, derived from parameters at a time.
struct Sampling {
    std::vector<Affine> dstToSrc;  // invertible samples only
    int totalSamples = 1;
    motion::MotionParams params;   // core values at the frame time
};

class MotionEffect final : public OFX::ImageEffect {
public:
    explicit MotionEffect(OfxImageEffectHandle handle) : OFX::ImageEffect(handle)
    {
        dstClip_ = fetchClip(kOfxImageEffectOutputClipName);
        srcClip_ = getContext() == OFX::eContextGenerator ? nullptr : fetchClip(kOfxImageEffectSimpleSourceClipName);
        for (const ParamSpec& s : motion::kSchema) {
            const auto i = static_cast<std::size_t>(s.id);
            const std::string key = str(s.key);
            switch (s.kind) {
                case ParamKind::Double: doubles_[i] = fetchDoubleParam(key); break;
                case ParamKind::Double2D: points_[i] = fetchDouble2DParam(key); break;
                case ParamKind::Int: ints_[i] = fetchIntParam(key); break;
                case ParamKind::Bool: bools_[i] = fetchBooleanParam(key); break;
                case ParamKind::Choice: choices_[i] = fetchChoiceParam(key); break;
            }
        }
        updateEnabledState();
    }

private:
    // --- parameter access -------------------------------------------------

    // Host values at time t, converted to core space.
    motion::MotionParams paramsAt(double t) const
    {
        motion::MotionParams v;
        for (const ParamSpec& s : motion::kSchema) {
            const auto i = static_cast<std::size_t>(s.id);
            switch (s.kind) {
                case ParamKind::Double: motion::setScalar(v, s.id, doubles_[i]->getValueAtTime(t)); break;
                case ParamKind::Int: motion::setScalar(v, s.id, ints_[i]->getValueAtTime(t)); break;
                case ParamKind::Bool: motion::setScalar(v, s.id, bools_[i]->getValueAtTime(t) ? 1.0 : 0.0); break;
                case ParamKind::Choice: {
                    int c = 0;
                    choices_[i]->getValueAtTime(t, c);
                    motion::setScalar(v, s.id, c);
                    break;
                }
                case ParamKind::Double2D: {
                    double x = 0.0, y = 0.0;
                    points_[i]->getValueAtTime(t, x, y);
                    motion::setVec2(v, s.id, {x, y});
                    break;
                }
            }
        }
        return ofx::toCore(v, projectFrame());
    }

    ofx::ProjectFrame projectFrame() const
    {
        auto* self = const_cast<MotionEffect*>(this);  // Support getters are not const
        const OfxPointD off = self->getProjectOffset();
        const OfxPointD size = self->getProjectSize();
        const double par = self->getProjectPixelAspectRatio();
        return {{off.x, off.y}, {size.x, size.y}, par > 0.0 ? par : 1.0};
    }

    // Per-sample matrices for the frame at time t. Motion blur settings are
    // taken at t; the transform is evaluated at each shutter sample.
    Sampling sampling(double t, const ofx::PixelSpace& dst, const ofx::PixelSpace& src) const
    {
        Sampling out;
        out.params = paramsAt(t);
        const std::vector<double> times = motion::motionSampleTimes(out.params, t, 1.0);  // OFX time is in frames
        const ofx::ProjectFrame frame = projectFrame();
        out.totalSamples = static_cast<int>(times.size());
        for (double ts : times) {
            const motion::MotionParams p = ts == t ? out.params : paramsAt(ts);
            if (auto m = ofx::dstPixelToSrcPixel(p, frame, dst, src)) out.dstToSrc.push_back(*m);
        }
        // A static transform with motion blur on needs only one sample.
        if (out.dstToSrc.size() == times.size() && times.size() > 1 &&
            std::all_of(out.dstToSrc.begin(), out.dstToSrc.end(), [&](const Affine& m) {
                const Affine& f = out.dstToSrc.front();
                return m.a == f.a && m.b == f.b && m.c == f.c && m.d == f.d && m.tx == f.tx && m.ty == f.ty;
            })) {
            out.dstToSrc.resize(1);
            out.totalSamples = 1;
        }
        return out;
    }

    ofx::PixelSpace pixelSpace(const OFX::Clip* clip, OfxPointD renderScale) const
    {
        const double par = clip ? clip->getPixelAspectRatio() : 1.0;
        return {{renderScale.x, renderScale.y}, par > 0.0 ? par : 1.0};
    }

    bool sourceConnected() const { return srcClip_ && srcClip_->isConnected(); }

    void updateEnabledState()
    {
        const bool blur = bools_[static_cast<std::size_t>(ParamId::MotionBlur)]->getValue();
        doubles_[static_cast<std::size_t>(ParamId::ShutterAngle)]->setEnabled(blur);
        doubles_[static_cast<std::size_t>(ParamId::ShutterPhase)]->setEnabled(blur);
        ints_[static_cast<std::size_t>(ParamId::MotionBlurSamples)]->setEnabled(blur);
    }

    // --- actions ------------------------------------------------------------

    void changedParam(const OFX::InstanceChangedArgs&, const std::string& name) override
    {
        if (name == motion::spec(ParamId::MotionBlur).key) updateEnabledState();
    }

    void getClipPreferences(OFX::ClipPreferencesSetter& prefs) override
    {
        if (!srcClip_) return;
        // Transforming reveals transparent areas, so opaque RGBA becomes premultiplied.
        OFX::PreMultiplicationEnum pm = srcClip_->getPreMultiplication();
        if (pm == OFX::eImageOpaque && srcClip_->getPixelComponents() == OFX::ePixelComponentRGBA)
            pm = OFX::eImagePreMultiplied;
        prefs.setOutputPremultiplication(pm);
    }

    bool getRegionOfDefinition(const OFX::RegionOfDefinitionArguments& args, OfxRectD& rod) override
    {
        if (!sourceConnected()) return false;
        const OfxRectD s = srcClip_->getRegionOfDefinition(args.time);
        // An infinite source (kOfxFlagInfinite*) stays infinite under any transform.
        if (s.x1 <= kOfxFlagInfiniteMin || s.y1 <= kOfxFlagInfiniteMin || s.x2 >= kOfxFlagInfiniteMax ||
            s.y2 >= kOfxFlagInfiniteMax) {
            rod = s;
            return true;
        }
        const double par = pixelSpace(srcClip_, {1.0, 1.0}).par;
        const motion::MotionParams atTime = paramsAt(args.time);
        // Filters reach past the source edge (radius in full-resolution source
        // pixels); anti-flicker reaches one pixel above and below the output.
        const double radius = atTime.quality == motion::Quality::High ? 2.0 : 1.0;
        const Rect grown{s.x1 - radius * par, s.y1 - radius, s.x2 + radius * par, s.y2 + radius};
        const double af = atTime.antiFlicker > 0.0 ? 1.0 : 0.0;
        const ofx::ProjectFrame frame = projectFrame();
        Rect out{};
        for (double ts : motion::motionSampleTimes(atTime, args.time, 1.0)) {
            const motion::MotionParams p = ts == args.time ? atTime : paramsAt(ts);
            const Affine m = ofx::canonicalTransform(p, frame);
            if (!m.inverse()) continue;  // Scale 0: this sample is invisible
            out = unite(out, transformBounds(m, grown));
        }
        if (out.empty()) {
            rod = {0.0, 0.0, 0.0, 0.0};
        } else {
            rod = {out.x1, out.y1 - af, out.x2, out.y2 + af};
        }
        return true;
    }

    void getRegionsOfInterest(const OFX::RegionsOfInterestArguments& args, OFX::RegionOfInterestSetter& rois) override
    {
        if (!sourceConnected()) return;
        const ofx::PixelSpace dst = pixelSpace(dstClip_, args.renderScale);
        const ofx::PixelSpace src = pixelSpace(srcClip_, args.renderScale);
        const Sampling smp = sampling(args.time, dst, src);
        const Rect dstPix = transformBounds(ofx::canonicalToPixel(dst), {args.regionOfInterest.x1,
                                                                         args.regionOfInterest.y1,
                                                                         args.regionOfInterest.x2,
                                                                         args.regionOfInterest.y2});
        const Rect srcPix = render::sourceFootprint(smp.dstToSrc, dstPix, smp.params.quality,
                                                    smp.params.antiFlicker, args.renderScale.y);
        const Rect c = transformBounds(ofx::pixelToCanonical(src), srcPix);
        rois.setRegionOfInterest(*srcClip_, OfxRectD{c.x1, c.y1, c.x2, c.y2});
    }

    bool isIdentity(const OFX::IsIdentityArguments& args, OFX::Clip*& identityClip, double& identityTime) override
    {
        if (!sourceConnected()) return false;
        const Sampling smp = sampling(args.time, pixelSpace(dstClip_, args.renderScale),
                                      pixelSpace(srcClip_, args.renderScale));
        if (smp.totalSamples != 1 || smp.dstToSrc.size() != 1) return false;
        if (smp.params.opacity < 100.0 || smp.params.antiFlicker > 0.0) return false;
        if (!smp.dstToSrc.front().isIdentity(1e-9)) return false;
        identityClip = srcClip_;
        identityTime = args.time;
        return true;
    }

    void render(const OFX::RenderArguments& args) override
    {
        std::unique_ptr<OFX::Image> dst(dstClip_->fetchImage(args.time));
        if (!dst) OFX::throwSuiteStatusException(kOfxStatFailed);
        std::unique_ptr<OFX::Image> src(sourceConnected() ? srcClip_->fetchImage(args.time) : nullptr);

        const ofx::PixelSpace dstSpace = pixelSpace(dstClip_, args.renderScale);
        const ofx::PixelSpace srcSpace = pixelSpace(srcClip_, args.renderScale);
        const Sampling smp = sampling(args.time, dstSpace, srcSpace);

        const RectI dstBounds = toRectI(dst->getBounds());
        const RectI window = intersect(toRectI(args.renderWindow), dstBounds);

        render::PlanInputs in;
        in.dstToSrc = smp.dstToSrc;
        in.totalSamples = smp.totalSamples;
        in.opacity = smp.params.opacity / 100.0;
        in.antiFlicker = smp.params.antiFlicker;
        in.antiFlickerStep = args.renderScale.y;
        in.quality = args.renderQualityDraft ? motion::Quality::Draft : smp.params.quality;
        in.sourcePremultiplied = !src || src->getPreMultiplication() != OFX::eImageUnPreMultiplied;
        in.srcBounds = src ? toRectI(src->getBounds()) : RectI{};
        in.window = window;
        if (!src) in.dstToSrc = {};  // nothing to sample: renders transparent black

        try {
            const render::RenderPlan plan = render::makePlan(in);
#if VKF_HAS_METAL
            if (args.isEnabledMetalRender) {
                renderMetal(args, plan, src.get(), *dst);
                return;
            }
#endif
            const render::ImageView dstView = viewOf(*dst);
            render::ImageView srcView = src ? viewOf(*src) : dstView;
            if (!src) {
                srcView.data = nullptr;
                srcView.bounds = {};
            }
            if (srcView.type != dstView.type || srcView.components != dstView.components) {
                setPersistentMessage(OFX::Message::eMessageError, "",
                                     "Source and output pixel formats differ; this host setup is unsupported.");
                OFX::throwSuiteStatusException(kOfxStatErrFormat);
            }
            HostExecutor executor;
            render::renderCpu(plan, srcView, dstView, executor);
        } catch (const OFX::Exception::Suite&) {
            throw;  // already carries an OFX status
        } catch (const std::exception& e) {
            setPersistentMessage(OFX::Message::eMessageError, "", std::string("Motion render failed: ") + e.what());
            OFX::throwSuiteStatusException(kOfxStatFailed);
        }
    }

#if VKF_HAS_METAL
    void renderMetal(const OFX::RenderArguments& args, const render::RenderPlan& plan, OFX::Image* src,
                     OFX::Image& dst)
    {
        render::MetalRenderer* metal = sharedMetal();
        if (!metal) throw std::runtime_error("Metal renderer unavailable");
        if (dst.getPixelDepth() != OFX::eBitDepthFloat || dst.getPixelComponents() != OFX::ePixelComponentRGBA)
            throw std::runtime_error("Metal rendering requires float RGBA images");
        const render::MetalImage d{dst.getPixelData(), toRectI(dst.getBounds()), dst.getRowBytes(), 0};
        // With no source, sample from the destination buffer with an empty
        // rectangle: the kernel never reads it.
        render::MetalImage s = d;
        if (src) {
            if (src->getPixelDepth() != OFX::eBitDepthFloat || src->getPixelComponents() != OFX::ePixelComponentRGBA)
                throw std::runtime_error("Metal rendering requires float RGBA images");
            s = {src->getPixelData(), toRectI(src->getBounds()), src->getRowBytes(), 0};
        } else {
            s.bounds = {};
        }
        metal->encode(args.pMetalCmdQ, plan, s, d);
    }
#endif

    OFX::Clip* dstClip_ = nullptr;
    OFX::Clip* srcClip_ = nullptr;
    std::array<OFX::DoubleParam*, kParamCount> doubles_{};
    std::array<OFX::Double2DParam*, kParamCount> points_{};
    std::array<OFX::IntParam*, kParamCount> ints_{};
    std::array<OFX::BooleanParam*, kParamCount> bools_{};
    std::array<OFX::ChoiceParam*, kParamCount> choices_{};
};

// --- description -------------------------------------------------------------

void describeParams(OFX::ImageEffectDescriptor& desc)
{
    OFX::PageParamDescriptor* page = desc.definePageParam("Controls");
    std::vector<std::pair<std::string, OFX::GroupParamDescriptor*>> groups;
    auto groupFor = [&](std::string_view name) {
        for (auto& [n, g] : groups)
            if (n == name) return g;
        OFX::GroupParamDescriptor* g = desc.defineGroupParam(str(name));
        g->setLabel(str(name));
        g->setOpen(name != motion::kGroupRender);
        if (page) page->addChild(*g);
        groups.emplace_back(str(name), g);
        return g;
    };

    for (const ParamSpec& s : motion::kSchema) {
        const std::string key = str(s.key);
        OFX::ParamDescriptor* base = nullptr;
        switch (s.kind) {
            case ParamKind::Double: {
                OFX::DoubleParamDescriptor* p = desc.defineDoubleParam(key);
                p->setDefault(s.defaultValue);
                p->setRange(s.min, s.max);
                p->setDisplayRange(s.displayMin, s.displayMax);
                p->setDoubleType(s.unit == motion::Unit::Degrees ? OFX::eDoubleTypeAngle : OFX::eDoubleTypePlain);
                p->setIncrement(s.unit == motion::Unit::Fraction ? 0.01 : 1.0);
                p->setDigits(s.unit == motion::Unit::Fraction ? 2 : 1);
                p->setAnimates(s.animatable);
                base = p;
                break;
            }
            case ParamKind::Double2D: {
                OFX::Double2DParamDescriptor* p = desc.defineDouble2DParam(key);
                p->setDoubleType(OFX::eDoubleTypeXYAbsolute);
                // Frame-centre defaults resolve in the host's project frame.
                p->setDefaultCoordinateSystem(OFX::eCoordinatesNormalised);
                p->setDefault(0.5, 0.5);
                p->setAnimates(s.animatable);
                p->setDigits(1);
                base = p;
                break;
            }
            case ParamKind::Int: {
                OFX::IntParamDescriptor* p = desc.defineIntParam(key);
                p->setDefault(static_cast<int>(s.defaultValue));
                p->setRange(static_cast<int>(s.min), static_cast<int>(s.max));
                p->setDisplayRange(static_cast<int>(s.displayMin), static_cast<int>(s.displayMax));
                p->setAnimates(s.animatable);
                base = p;
                break;
            }
            case ParamKind::Bool: {
                OFX::BooleanParamDescriptor* p = desc.defineBooleanParam(key);
                p->setDefault(s.defaultValue != 0.0);
                p->setAnimates(s.animatable);
                base = p;
                break;
            }
            case ParamKind::Choice: {
                OFX::ChoiceParamDescriptor* p = desc.defineChoiceParam(key);
                for (std::string_view option : s.choices) p->appendOption(str(option));
                p->setDefault(static_cast<int>(s.defaultValue));
                p->setAnimates(s.animatable);
                base = p;
                break;
            }
        }
        base->setLabel(str(s.label));
        base->setHint(str(s.hint));
        base->setParent(*groupFor(s.group));
    }
}

class MotionFactory final : public OFX::PluginFactoryHelper<MotionFactory> {
public:
    MotionFactory() : OFX::PluginFactoryHelper<MotionFactory>(VKF_OFX_PLUGIN_ID, kVersionMajor, kVersionMinor) {}

    void describe(OFX::ImageEffectDescriptor& desc) override
    {
        desc.setLabel(kPluginLabel);
        desc.setPluginGrouping(kPluginGrouping);
        desc.setPluginDescription(kPluginDescription);
        desc.addSupportedContext(OFX::eContextFilter);
        desc.addSupportedContext(OFX::eContextGeneral);
        desc.addSupportedBitDepth(OFX::eBitDepthUByte);
        desc.addSupportedBitDepth(OFX::eBitDepthUShort);
        desc.addSupportedBitDepth(OFX::eBitDepthFloat);
        desc.setSingleInstance(false);
        desc.setHostFrameThreading(false);
        desc.setSupportsMultiResolution(true);
        desc.setSupportsTiles(true);
        desc.setTemporalClipAccess(false);
        desc.setRenderTwiceAlways(false);
        desc.setSupportsMultipleClipPARs(false);
        desc.setSupportsMultipleClipDepths(false);
        desc.setRenderThreadSafety(OFX::eRenderFullySafe);
#if VKF_HAS_METAL
        if (OFX::getImageEffectHostDescription()->supportsMetalRender) desc.setSupportsMetalRender(true);
#endif
    }

    void describeInContext(OFX::ImageEffectDescriptor& desc, OFX::ContextEnum) override
    {
        for (const char* name : {kOfxImageEffectSimpleSourceClipName, kOfxImageEffectOutputClipName}) {
            OFX::ClipDescriptor* clip = desc.defineClip(name);
            clip->addSupportedComponent(OFX::ePixelComponentRGBA);
            clip->addSupportedComponent(OFX::ePixelComponentRGB);
            clip->addSupportedComponent(OFX::ePixelComponentAlpha);
            clip->setTemporalClipAccess(false);
            clip->setSupportsTiles(true);
        }
        describeParams(desc);
    }

    OFX::ImageEffect* createInstance(OfxImageEffectHandle handle, OFX::ContextEnum) override
    {
        return new MotionEffect(handle);
    }
};

}  // namespace

namespace OFX::Plugin {
void getPluginIDs(OFX::PluginFactoryArray& ids)
{
    static MotionFactory factory;
    ids.push_back(&factory);
}
}  // namespace OFX::Plugin
