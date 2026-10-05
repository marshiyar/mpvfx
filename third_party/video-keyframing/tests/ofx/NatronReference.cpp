// Reference renderer for the Natron end-to-end test. Reads a job file written
// by natron_e2e.py, renders each job with the engine exactly as the OFX
// plugin would (OfxCoords + RenderPlan + CPU renderer), and compares against
// the frame Natron rendered through the plugin.
//
// Job file lines:
//   job <name> <src.rgba> <out.rgba> <width> <height> <quality 0|1> <antiFlicker> <opacity%> <totalSamples>
//   s <posX> <posY> <scale> <rotation> <anchorX> <anchorY>     (one per motion sample, canonical values)
//
// .rgba files: "VKFRGBA <w> <h>\n" then float RGBA, bottom row first (OFX
// pixel order). Exit code 0 when every job matches within tolerance.
#include <cmath>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include "OfxCoords.h"
#include "vkf/render/CpuRenderer.h"

using namespace vkf;

namespace {

struct Raw {
    int width = 0, height = 0;
    std::vector<float> rgba;  // bottom row first
};

bool readRaw(const std::string& path, Raw& img)
{
    std::ifstream f(path, std::ios::binary);
    if (!f) return false;
    std::string magic;
    f >> magic >> img.width >> img.height;
    f.get();  // newline after the header
    if (magic != "VKFRGBA" || img.width <= 0 || img.height <= 0) return false;
    img.rgba.resize(static_cast<std::size_t>(img.width) * img.height * 4);
    f.read(reinterpret_cast<char*>(img.rgba.data()), static_cast<std::streamsize>(img.rgba.size() * sizeof(float)));
    return static_cast<bool>(f);
}

struct Job {
    std::string name, src, out;
    int width = 0, height = 0, quality = 1;
    double antiFlicker = 0.0, opacity = 100.0;
    int totalSamples = 1;
    std::vector<motion::MotionParams> samples;  // host (canonical) values
};

std::vector<Job> readJobs(const std::string& path)
{
    std::vector<Job> jobs;
    std::ifstream f(path);
    std::string line;
    while (std::getline(f, line)) {
        std::istringstream in(line);
        std::string tag;
        in >> tag;
        if (tag == "job") {
            Job j;
            in >> j.name >> j.src >> j.out >> j.width >> j.height >> j.quality >> j.antiFlicker >> j.opacity >>
                j.totalSamples;
            jobs.push_back(j);
        } else if (tag == "s" && !jobs.empty()) {
            motion::MotionParams p;
            in >> p.position.x >> p.position.y >> p.scale >> p.rotation >> p.anchorPoint.x >> p.anchorPoint.y;
            jobs.back().samples.push_back(p);
        }
    }
    return jobs;
}

}  // namespace

int main(int argc, char** argv)
{
    if (argc != 4 || std::string(argv[3]).size() != 4) {
        std::cerr << "usage: vkf_natron_reference <jobs.txt> <tolerance> <RGBA mask, e.g. 1111>\n";
        return 2;
    }
    const double tolerance = std::stod(argv[2]);
    const std::string mask = argv[3];  // channels the host writes reliably
    const std::vector<Job> jobs = readJobs(argv[1]);
    if (jobs.empty()) {
        std::cerr << "no jobs\n";
        return 2;
    }
    bool ok = true;
    for (const Job& job : jobs) {
        Raw src, natron;
        if (!readRaw(job.src, src) || !readRaw(job.out, natron) || src.width != job.width ||
            src.height != job.height || natron.width != job.width || natron.height != job.height) {
            std::cerr << job.name << ": cannot read images or size mismatch\n";
            ok = false;
            continue;
        }
        const RectI frameRect{0, 0, job.width, job.height};
        std::vector<float>& srcRgba = src.rgba;
        std::vector<float> dstRgba(srcRgba.size(), 0.0f);
        const std::ptrdiff_t rowBytes = static_cast<std::ptrdiff_t>(job.width) * 16;
        render::ImageView sv{srcRgba.data(), rowBytes, frameRect, render::PixelType::F32, 4};
        render::ImageView dv{dstRgba.data(), rowBytes, frameRect, render::PixelType::F32, 4};

        const ofx::ProjectFrame frame{{0, 0}, {static_cast<double>(job.width), static_cast<double>(job.height)}, 1.0};
        const ofx::PixelSpace pixels{{1.0, 1.0}, 1.0};
        std::vector<Affine> matrices;
        for (const motion::MotionParams& host : job.samples)
            if (auto m = ofx::dstPixelToSrcPixel(ofx::toCore(host, frame), frame, pixels, pixels))
                matrices.push_back(*m);
        render::PlanInputs in;
        in.dstToSrc = matrices;
        in.totalSamples = job.totalSamples;
        in.opacity = job.opacity / 100.0;
        in.antiFlicker = job.antiFlicker;
        in.antiFlickerStep = 1.0;
        in.quality = job.quality == 0 ? motion::Quality::Draft : motion::Quality::High;
        in.srcBounds = frameRect;
        in.window = frameRect;
        render::ThreadExecutor threads;
        render::renderCpu(render::makePlan(in), sv, dv, threads);

        double worst = 0.0, energy = 0.0;
        for (std::size_t i = 0; i < natron.rgba.size(); ++i) {
            if (mask[i % 4] != '1') continue;
            const double a = natron.rgba[i], b = dstRgba[i];
            worst = std::max(worst, std::isfinite(a) ? std::abs(a - b) : INFINITY);
            energy += std::abs(a);
        }
        const bool pass = worst <= tolerance && energy > 1000.0;
        ok = ok && pass;
        std::printf("%-28s max|natron-engine| = %.3g  (%s)\n", job.name.c_str(), worst, pass ? "ok" : "FAIL");
    }
    return ok ? 0 : 1;
}
