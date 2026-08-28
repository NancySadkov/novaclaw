import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"

import { readBounded, readBoundedText } from "./bounded-stream"

const chunks = (...sizes: number[]) => Stream.fromIterable(sizes.map((n) => new Uint8Array(n).fill(65)))

/**
 * 🔴 The bound four P1 findings are missing (NC-SEC-005/006/008/009): a limit that refuses
 * mid-flight, rather than one applied to a buffer that was already read in full.
 *
 * A/B: drop the `takeUntil` and "stops reading — does not drain" fails, because every chunk is
 * pulled; drop the `remaining > 0` slice and "keeps at most maxBytes" fails.
 */
describe("readBounded", () => {
  test("keeps at most maxBytes and says it truncated", async () => {
    const read = await Effect.runPromise(readBounded(chunks(10, 10, 10), 15))
    expect(read.bytes.length).toBe(15)
    expect(read.truncated).toBe(true)
  })

  test("🔴 STOPS reading — it does not drain the rest of the stream", async () => {
    // The difference from `core/src/process.ts:collectStream`, which caps what it keeps but keeps
    // counting to the end. A hostile body must cost the peer's bandwidth, not ours.
    let pulled = 0
    /**
     * ⚠️ `rechunk(1)` is load-bearing in this TEST, not in the reader. `Stream.fromIterable` emits
     * its whole iterable as ONE chunk, so a `map` over it runs for every element before any
     * downstream operator sees the first — the first version of this test measured Effect's chunking
     * and reported 10 pulls against a reader that was working correctly. One element per chunk makes
     * the pull boundary observable, which is the thing under test.
     */
    const counted = Stream.fromIterable([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).pipe(
      Stream.rechunk(1),
      Stream.map((i) => {
        pulled = i
        return new Uint8Array(10).fill(65)
      }),
    )
    const read = await Effect.runPromise(readBounded(counted, 15))
    expect(read.truncated).toBe(true)
    // `takeUntil` includes the chunk that trips the bound: two chunks (20 bytes) crosses 15, and
    // nothing beyond is pulled. Bounded by the producer's chunk size, never by the body's length.
    expect(pulled).toBe(2)
  })

  test("a stream under the bound comes back whole and untruncated", async () => {
    // The control: without it the two above would pass against a reader that always returned empty.
    const read = await Effect.runPromise(readBounded(chunks(4, 4), 100))
    expect(read.bytes.length).toBe(8)
    expect(read.truncated).toBe(false)
  })

  test("🔴 a body delivered in ONE chunk exactly the size of the cap still reports truncation", async () => {
    /**
     * The bug this reader shipped with for ten minutes. `seen >= maxBytes` stopped AT the bound, so
     * "exactly maxBytes" and "maxBytes and more" were indistinguishable: a 20,000-byte provider error
     * arriving as one 16,384-byte chunk came back `truncated: false`, and the caller would report a
     * complete body it had cut in half. Caught by the LLM executor's own truncation test, not by this
     * file — which is why that test was worth keeping green rather than adjusting.
     */
    const read = await Effect.runPromise(readBounded(chunks(16_384, 3_616), 16_384))
    expect(read.bytes.length).toBe(16_384)
    expect(read.truncated).toBe(true)
  })

  test("a body exactly AT the cap with nothing after it is not truncated", async () => {
    // The other side of the same boundary — otherwise "always truncated" would pass the test above.
    const read = await Effect.runPromise(readBounded(chunks(16_384), 16_384))
    expect(read.bytes.length).toBe(16_384)
    expect(read.truncated).toBe(false)
  })

  test("an empty stream is not a truncation", async () => {
    const read = await Effect.runPromise(readBounded(Stream.empty, 100))
    expect(read.bytes.length).toBe(0)
    expect(read.truncated).toBe(false)
  })

  test("readBoundedText decodes what it kept", async () => {
    const read = await Effect.runPromise(readBoundedText(chunks(3, 3), 4))
    expect(read.text).toBe("AAAA")
    expect(read.truncated).toBe(true)
  })
})
