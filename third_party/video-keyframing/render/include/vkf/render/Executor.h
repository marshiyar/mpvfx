#pragma once

#include <functional>

namespace vkf::render {

// Parallel loop abstraction so the CPU renderer can run on the host's thread
// pool (e.g. the OFX multithread suite) or on our own threads.
class Executor {
public:
    virtual ~Executor() = default;
    // Calls fn(begin, end) over disjoint sub-ranges covering [0, count) and
    // returns when all have finished. fn must not throw.
    virtual void parallelFor(int count, const std::function<void(int begin, int end)>& fn) = 0;
};

class SerialExecutor final : public Executor {
public:
    void parallelFor(int count, const std::function<void(int, int)>& fn) override
    {
        if (count > 0) fn(0, count);
    }
};

// Splits work across std::threads (0 = hardware concurrency).
class ThreadExecutor final : public Executor {
public:
    explicit ThreadExecutor(unsigned threads = 0);
    void parallelFor(int count, const std::function<void(int, int)>& fn) override;

private:
    unsigned threads_;
};

}  // namespace vkf::render
