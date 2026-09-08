import { Effect, Stream } from "effect"

/**
 * Read at most `maxBytes` from a byte stream, and STOP — do not drain the rest.
 *
 * 🔴 **The primitive four P1 findings are missing** (NC-SEC-005/006/008/009). They are one shape: a
 * declared limit applied AFTER the bytes are already in memory.
 *   · NC-SEC-006 — the LLM executor `await`s `response.text` in full, then slices to 16,384.
 *   · NC-SEC-008 — the MCP transports get no response-size policy at all.
 *   · NC-SEC-009 — the messenger measured the sender's CLAIMED size, not the download.
 *   · NC-SEC-005 — uploads have a byte cap but no read deadline.
 * Each has been patched or scoped separately. What none of them had is a reader that refuses
 * mid-flight instead of measuring a completed buffer.
 *
 * ⚠️ **Stopping is the point, and it is what `core/src/process.ts:collectStream` does NOT do.** That
 * one caps what it KEEPS but keeps counting: `acc.bytes += chunk.length` runs to the end of the
 * stream, so a hostile 10 GB body is still read in full — memory is safe while the connection, the
 * bandwidth and the time are not. It also lives in `core`, which `llm` cannot import (core depends on
 * llm, not the reverse), so the one bounded reader in the tree was unreachable from the package that
 * needed it most. That is why this is in `schema`: everything depends on it, and it already carries
 * cross-cutting utilities like `Log`.
 *
 * ⚠️ `takeUntil` INCLUDES the chunk that trips the predicate, so at most one chunk beyond the cap is
 * pulled before the stream is released. That is bounded by the producer's chunk size, not by the
 * body's length, which is the property that matters.
 */
export type BoundedRead = {
  /** At most `maxBytes` — the excess is never retained. */
  readonly bytes: Uint8Array
  /** True when the stream had more to give. The caller decides whether that is a failure. */
  readonly truncated: boolean
}

export const readBounded = <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
  maxBytes: number,
): Effect.Effect<BoundedRead, E, R> =>
  Effect.suspend(() => {
    let seen = 0
    return Stream.runFold(
      stream.pipe(
        /**
         * ⚠️ `>` and not `>=`, and this is the whole correctness of `truncated`. Stopping AT the cap
         * makes "exactly maxBytes" and "maxBytes and more" indistinguishable — a 20,000-byte body
         * delivered as one 16,384-byte chunk reported `truncated: false`, because nothing was ever
         * read past the bound to prove there was more. Read one byte beyond and the question answers
         * itself; `ripgrep.ts` already does this as `Stream.take(limit + 1)`.
         */
        Stream.takeUntil((chunk: Uint8Array) => {
          seen += chunk.length
          return seen > maxBytes
        }),
      ),
      () => ({ chunks: [] as Uint8Array[], bytes: 0 }),
      (acc, chunk) => {
        const remaining = maxBytes - acc.bytes
        if (remaining > 0) acc.chunks.push(remaining >= chunk.length ? chunk : chunk.slice(0, remaining))
        acc.bytes += chunk.length
        return acc
      },
    ).pipe(
      Effect.map((acc) => {
        const total = acc.chunks.reduce((n, c) => n + c.length, 0)
        const bytes = new Uint8Array(total)
        let at = 0
        for (const chunk of acc.chunks) {
          bytes.set(chunk, at)
          at += chunk.length
        }
        return { bytes, truncated: acc.bytes > maxBytes }
      }),
    )
  })

/** The same bound, decoded as UTF-8 — the shape every diagnostic-body caller actually wants. */
export const readBoundedText = <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
  maxBytes: number,
): Effect.Effect<{ readonly text: string; readonly truncated: boolean }, E, R> =>
  readBounded(stream, maxBytes).pipe(
    Effect.map((read) => ({ text: new TextDecoder().decode(read.bytes), truncated: read.truncated })),
  )
