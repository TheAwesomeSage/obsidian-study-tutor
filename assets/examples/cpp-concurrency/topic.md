# C++ concurrency

## Overview

Writing C++ that shares data between threads without data races: what a race is, how a mutex and a condition variable hand work from one thread to another, and how atomics with acquire and release ordering make a lock-free queue correct. This is an example course that ships with Study Tutor. It was written by hand, not compiled from your notes, and cites no notes in your vault.

Running the code questions needs a C++ compiler on this computer and **Run C and C++ answers** turned on in the settings. Without one, code answers are judged by a model and the record says they were not run.

## Outcome

Fix the data race in a single-producer, single-consumer ring buffer with std::atomic, and defend the memory ordering you chose.

Done well when:
- Traces a producer and a consumer through a bounded queue, call by call
- Uses atomic indices so the queue has no data race
- Pairs each release store with the acquire load that reads it
- Explains why the slot write happens-before the slot read
- Says what passing tests do and do not establish about thread safety

## Subskills

### 1. Threads and data races
prerequisites: none
- A data race is two threads accessing the same memory location without synchronisation, at least one of them writing. In C++ it is undefined behaviour, not just a wrong answer.
- `counter++` on a plain int is a read, an add and a write; two threads can interleave them and lose updates.
- An interleaving is one order in which the steps of the threads happen. A test sees only the interleavings that happened to run.
misconceptions:
- a race only matters if the output looks wrong
- code that passes its tests many times is thread safe
worked example:
Two threads each run `x++` once on `int x = 0`. One interleaving: T1 reads 0, T2 reads 0, T1 writes 1, T2 writes 1. The final value is 1, not 2, and because this is a data race the program has undefined behaviour anyway.

### 2. Mutexes and condition variables
prerequisites: 1
- A std::mutex makes the code between lock and unlock run in one thread at a time; unlocking happens-before the next lock of the same mutex.
- A condition variable waits for a condition under a mutex. The wait goes in a loop on the condition, because wake-ups can be spurious and another thread may take the item first.
- The condition must change while the mutex is held, or a notify can arrive between the check and the wait and be lost.
misconceptions:
- notify_one wakes a thread that has not started waiting yet
- a single if before wait is enough
worked example:
`std::unique_lock<std::mutex> lk(m); cv.wait(lk, [&] { return !items.empty(); }); auto v = items.front(); items.pop();` The predicate form of wait is the loop `while (items.empty()) cv.wait(lk);`.

### 3. Atomics and memory ordering
prerequisites: 1
- A std::atomic access is never a data race. Its memory order says what else it orders.
- memory_order_relaxed makes each access atomic and orders nothing around it.
- A release store and an acquire load that reads its value synchronise: everything written before the release happens-before everything read after the acquire.
- In a single-producer, single-consumer ring buffer the producer writes the slot, then release-stores the tail; the consumer acquire-loads the tail, then reads the slot. The head index is the same pattern in the other direction, so a slot is reused only after it was read.
- On x86 most loads and stores are already ordered strongly, so code with too weak an ordering can pass every test there and fail on ARM.
misconceptions:
- relaxed is fine wherever the variable is atomic
- volatile makes a variable safe to share between threads
worked example:
Producer: `data = 42; ready.store(true, std::memory_order_release);` Consumer: `while (!ready.load(std::memory_order_acquire)) {} use(data);` The acquire load reads the value the release store wrote, so `data = 42` happens-before `use(data)`, and the consumer sees 42.
