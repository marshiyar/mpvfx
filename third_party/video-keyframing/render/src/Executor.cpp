#include "vkf/render/Executor.h"

#include <algorithm>
#include <thread>
#include <vector>

namespace vkf::render {

ThreadExecutor::ThreadExecutor(unsigned threads)
    : threads_(threads != 0 ? threads : std::max(1u, std::thread::hardware_concurrency()))
{
}

void ThreadExecutor::parallelFor(int count, const std::function<void(int, int)>& fn)
{
    if (count <= 0) return;
    const int chunks = static_cast<int>(std::min<unsigned>(threads_, static_cast<unsigned>(count)));
    if (chunks <= 1) {
        fn(0, count);
        return;
    }
    std::vector<std::thread> workers;
    workers.reserve(static_cast<std::size_t>(chunks - 1));
    auto bounds = [&](int c) { return static_cast<int>(static_cast<long long>(count) * c / chunks); };
    for (int c = 1; c < chunks; ++c) workers.emplace_back([&, c] { fn(bounds(c), bounds(c + 1)); });
    fn(0, bounds(1));
    for (std::thread& t : workers) t.join();
}

}  // namespace vkf::render
