### Q1
subskill: 1
type: mcq
question: Two threads each run `counter++` 1000 times on a plain `int counter = 0`, with no lock. What can you say about the final value?
options:
- A. It is always 2000.
- B. It is always 1000.
- C. Nothing is guaranteed: the unsynchronised increments are a data race, which is undefined behaviour.
- D. It is 2000 on x86 and may be less on ARM.
answer: C
family: plain-counter-race
task: prediction
difficulty: 2
explanation: Each `counter++` is a read, an add and a write. Two threads can interleave them and lose updates, and since they race on a non-atomic int the C++ program has undefined behaviour, so no value is promised.

### Q2
subskill: 1
type: open
question: A colleague says: "I ran the multithreaded test 10,000 times and it always passed, so the code is thread safe." What does that evidence show, and what does it not show?
answer: It shows the outputs were right on the interleavings that happened to run on this machine, compiler and load. It does not show the code is free of data races: a race may need a rare interleaving, another compiler or optimisation level, or a weaker memory model such as ARM to show up, and a data race is undefined behaviour even when the output looks right. A sanitizer run or an argument about happens-before is needed.
rubric: says the tests cover only the interleavings that ran; says a data race can exist with correct outputs; names a reason it can stay hidden (rare timing, compiler, hardware memory model); names a better kind of evidence (ThreadSanitizer or a happens-before argument)
family: tests-vs-safety
task: explanation
difficulty: 2
explanation: Testing samples interleavings; it cannot enumerate them. Thread safety is a claim about every interleaving the memory model allows.

### Q3
subskill: 2
type: mcq
question: Why is a condition-variable wait written as `while (queue.empty()) cv.wait(lock);` rather than `if (queue.empty()) cv.wait(lock);`?
options:
- A. A wake-up can be spurious, and another consumer may take the item first, so the condition must be checked again after waking.
- B. `wait` does not take the lock, so the loop takes it.
- C. The loop is faster because it avoids a system call.
- D. `notify_one` wakes every waiting thread, and the loop sends the extra ones back.
answer: A
family: wait-in-loop
task: explanation
difficulty: 2
explanation: `wait` may return without a notify, and between the notify and the waiter getting the lock another thread can empty the queue. The predicate form `cv.wait(lock, pred)` is the same loop.

### Q4
subskill: 2
type: open
question: In this code the consumer can wait forever even though the producer has finished: the producer runs `ready = true; cv.notify_one();` without holding the mutex, and the consumer runs `std::unique_lock lk(m); if (!ready) cv.wait(lk);`. Give the interleaving that loses the wake-up, and the fix.
answer: The consumer locks m and reads ready as false. Before it starts waiting, the producer sets ready = true and calls notify_one; no thread is waiting yet, so the notify is lost. The consumer then waits and nothing wakes it. Fix: the producer sets ready while holding m (lock, set, unlock, then notify), and the consumer waits in a loop: cv.wait(lk, [&]{ return ready; }). Then the check and the wait cannot be split by the producer's write.
rubric: gives an interleaving where the notify happens after the check and before the wait; says the notify is lost because nobody is waiting; the fix changes ready under the mutex; the fix waits in a loop or with a predicate
family: lost-wakeup
task: error-finding
difficulty: 3
explanation: Holding the mutex while changing the condition is what makes the consumer's check-then-wait atomic with respect to the producer.

### Q5
subskill: 3
type: mcq
question: `std::atomic<int> hits;` is incremented by many threads with `hits.fetch_add(1, std::memory_order_relaxed)`, and read once after every thread has been joined. What does relaxed ordering give here?
options:
- A. No guarantee: relaxed increments can be lost.
- B. Every increment is atomic, so the final count is exact; relaxed orders nothing else, which this counter does not need.
- C. The same as memory_order_seq_cst on every platform.
- D. A data race, because relaxed atomics are not synchronised.
answer: B
family: relaxed-counter
task: application
difficulty: 3
explanation: Relaxed still makes each read-modify-write atomic. The joins order the final read after every increment. Relaxed is wrong only when the atomic is also meant to publish other data.

### Q6
subskill: 3
type: mcq
question: Thread A writes `data = 42;` then `ready.store(true, ?)`. Thread B spins on `ready.load(?)` until it is true, then reads `data`. What is the weakest pair of orders that guarantees B reads 42?
options:
- A. relaxed store, relaxed load
- B. release store, acquire load
- C. seq_cst store, relaxed load
- D. relaxed store, acquire load
answer: B
family: publish-flag
task: application
difficulty: 3
explanation: The acquire load that reads the value of the release store synchronises with it, so `data = 42` happens-before B's read of data. Any relaxed side breaks that edge.

### Q7
subskill: 1
type: short
part: spsc-queue 1/3
task: prediction
question: **Trace** · A bounded queue shared by one producer thread and one consumer thread holds one item (capacity 1): push returns false when it is full, and pop returns false when it is empty. The producer tries to push 1, 2, 3 in that order, retrying the same value when push returns false. The consumer calls pop, retrying when it returns false. The calls run one at a time in this order of threads: P, P, C, P, C, C, P, C. Write the result of each of the eight calls, in order, using `push1` for a successful push of 1, `full` for a push that returned false, `pop1` for a pop that returned 1, and `empty` for a pop that returned false. Separate them with commas.
answer: push1, full, pop1, push2, pop2, empty, push3, pop3
family: spsc-trace
difficulty: 2
explanation: With one slot, push(2) fails until the consumer has taken 1. After pop2 the queue is empty, so the next pop fails until the producer pushes 3.

### Q8
subskill: 3
type: open
part: spsc-queue 2/3
task: application
question: **Implement** · This queue has a data race: the producer and the consumer read and write `head_` and `tail_` with no synchronisation. Change the queue so it has no data race, using std::atomic and the weakest memory orders that are still correct. Keep `main` unchanged: it is the test harness. Send the whole program.
answer: "#include <atomic>\n#include <cstdio>\n#include <thread>\n#include <vector>\n\n// A bounded single-producer, single-consumer ring buffer. One slot is kept empty,\n// so it holds up to `capacity` items.\ntemplate <typename T>\nclass SpscQueue {\n public:\n  explicit SpscQueue(std::size_t capacity) : buf_(capacity + 1) {}\n  bool push(const T& v) {\n    std::size_t t = tail_.load(std::memory_order_relaxed);\n    std::size_t next = (t + 1) % buf_.size();\n    if (next == head_.load(std::memory_order_acquire)) return false;  // full\n    buf_[t] = v;\n    tail_.store(next, std::memory_order_release);  // publishes the slot write\n    return true;\n  }\n  bool pop(T& out) {\n    std::size_t h = head_.load(std::memory_order_relaxed);\n    if (h == tail_.load(std::memory_order_acquire)) return false;  // empty\n    out = buf_[h];\n    head_.store((h + 1) % buf_.size(), std::memory_order_release);  // frees the slot\n    return true;\n  }\n\n private:\n  std::vector<T> buf_;\n  std::atomic<std::size_t> head_{0};  // next slot to read; written by the consumer only\n  std::atomic<std::size_t> tail_{0};  // next slot to write; written by the producer only\n};\n\n// Do not change main: it is the test harness. Input: n capacity.\nint main() {\n  long long n = 0, cap = 0;\n  if (std::scanf(\"%lld %lld\", &n, &cap) != 2 || cap < 1) return 1;\n  SpscQueue<long long> q(static_cast<std::size_t>(cap));\n  std::thread producer([&] {\n    for (long long i = 1; i <= n; ++i)\n      while (!q.push(i)) std::this_thread::yield();\n  });\n  long long sum = 0, expect = 1;\n  bool ordered = true;\n  for (long long got = 0; got < n;) {\n    long long v;\n    if (q.pop(v)) {\n      if (v != expect++) ordered = false;\n      sum += v;\n      ++got;\n    } else {\n      std::this_thread::yield();\n    }\n  }\n  producer.join();\n  std::printf(\"%lld %s\\n\", sum, ordered ? \"in order\" : \"out of order\");\n  return 0;\n}\n"
code: {"language":"cpp","concurrent":true,"timeLimitMs":5000,"starter":"#include <atomic>\n#include <cstdio>\n#include <thread>\n#include <vector>\n\n// A bounded single-producer, single-consumer ring buffer. One slot is kept empty,\n// so it holds up to `capacity` items.\ntemplate <typename T>\nclass SpscQueue {\n public:\n  explicit SpscQueue(std::size_t capacity) : buf_(capacity + 1) {}\n  bool push(const T& v) {\n    std::size_t next = (tail_ + 1) % buf_.size();\n    if (next == head_) return false;  // full\n    buf_[tail_] = v;\n    tail_ = next;\n    return true;\n  }\n  bool pop(T& out) {\n    if (head_ == tail_) return false;  // empty\n    out = buf_[head_];\n    head_ = (head_ + 1) % buf_.size();\n    return true;\n  }\n\n private:\n  std::vector<T> buf_;\n  std::size_t head_ = 0;  // next slot to read; written by the consumer only\n  std::size_t tail_ = 0;  // next slot to write; written by the producer only\n};\n\n// Do not change main: it is the test harness. Input: n capacity.\nint main() {\n  long long n = 0, cap = 0;\n  if (std::scanf(\"%lld %lld\", &n, &cap) != 2 || cap < 1) return 1;\n  SpscQueue<long long> q(static_cast<std::size_t>(cap));\n  std::thread producer([&] {\n    for (long long i = 1; i <= n; ++i)\n      while (!q.push(i)) std::this_thread::yield();\n  });\n  long long sum = 0, expect = 1;\n  bool ordered = true;\n  for (long long got = 0; got < n;) {\n    long long v;\n    if (q.pop(v)) {\n      if (v != expect++) ordered = false;\n      sum += v;\n      ++got;\n    } else {\n      std::this_thread::yield();\n    }\n  }\n  producer.join();\n  std::printf(\"%lld %s\\n\", sum, ordered ? \"in order\" : \"out of order\");\n  return 0;\n}\n","tests":[{"name":"five items through two slots","stdin":"5 2","expected":"15 in order"},{"name":"empty run","stdin":"0 3","expected":"0 in order"},{"name":"a thousand items through four slots","stdin":"1000 4","expected":"500500 in order"},{"name":"many items through one slot","stdin":"20000 1","expected":"200010000 in order","hidden":true}]}
family: spsc-implement
difficulty: 4
explanation: The producer owns tail_ and the consumer owns head_, so each reads its own index relaxed. Reading the other thread's index needs acquire, and publishing your own needs release.

### Q9
subskill: 3
type: open
part: spsc-queue 3/3
task: explanation
question: **Defend the ordering** · In the fixed queue, push does `buf_[t] = v;` then `tail_.store(next, std::memory_order_release);`, and pop does `tail_.load(std::memory_order_acquire)` before reading `buf_[h]`. Explain why this makes the consumer's read of the slot safe. Then say what could go wrong if both were memory_order_relaxed, and why the tests you just ran would probably not show it.
answer: The acquire load in pop reads the value written by the release store in push, so the two synchronise: everything the producer wrote before the store, including buf_[t] = v, happens-before everything the consumer does after the load, including reading buf_[h]. So the consumer sees the value, and there is no data race on the slot. The same pairing on head_ (release in pop, acquire in push) makes sure a slot is reused only after its value was read. With relaxed on both, the consumer could see the new tail before the slot write is visible and read a stale value, and the slot access becomes a data race. Tests on x86 would probably still pass, because x86 keeps stores in order and loads in order, and the compiler may not reorder these accesses in practice; the failure needs a weaker memory model such as ARM, other optimisation, or a rare interleaving. Passing tests sample interleavings; they cannot show the ordering argument holds.
rubric: the acquire load reads the value of the release store, so they synchronise; the slot write happens-before the slot read; names the head_ pairing or slot reuse; with relaxed the consumer can read a stale or torn slot value, a data race; says x86 ordering, the compiler or timing can hide this so tests pass; says the tests cannot establish thread safety
family: spsc-defend
difficulty: 4
explanation: This part is marked on its own, against the rubric, by a separate assessor: passing the tests in part 2 says nothing about this argument, and this argument does not make failing code pass.
