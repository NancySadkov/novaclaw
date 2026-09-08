import { Effect, Queue } from "effect"

/** The PTY ring is 2 MiB; a socket gets at most one equally sized transient copy. */
export const PTY_OUTBOX_LIMIT_BYTES = 2 * 1024 * 1024

/** Keep tiny writes from consuming an unbounded number of queue cells. */
const QUEUE_CAPACITY = 1024

export interface ByteBoundedOutbox<A> {
  /** False means this attachment must be closed and resumed from its cursor. */
  readonly offerUnsafe: (item: A) => boolean
  /** Takes one item and releases its accounted bytes. */
  readonly take: Effect.Effect<A>
  readonly queuedBytes: () => number
  readonly overflowed: () => boolean
}

/**
 * A non-blocking producer queue with a byte ceiling.
 *
 * PTY callbacks run synchronously on the native output path, so producers cannot await a slow
 * WebSocket. Once the ceiling or the cell bound is reached, the caller gets a false result and
 * must close the attachment; dropping the tail is recoverable because PTY output has cursors and
 * a bounded replay ring.
 */
export const makeByteBoundedOutbox = <A>(
  sizeOf: (item: A) => number,
  limitBytes = PTY_OUTBOX_LIMIT_BYTES,
): Effect.Effect<ByteBoundedOutbox<A>> =>
  Effect.gen(function* () {
    const queue = yield* Queue.bounded<A>(QUEUE_CAPACITY)
    let bytes = 0
    let overflowed = false

    const offerUnsafe = (item: A) => {
      if (overflowed) return false
      const size = sizeOf(item)
      if (!Number.isSafeInteger(size) || size < 0 || bytes + size > limitBytes) {
        overflowed = true
        return false
      }
      if (!Queue.offerUnsafe(queue, item)) {
        overflowed = true
        return false
      }
      bytes += size
      return true
    }

    return {
      offerUnsafe,
      take: Queue.take(queue).pipe(Effect.tap((item) => Effect.sync(() => (bytes -= sizeOf(item))))),
      queuedBytes: () => bytes,
      overflowed: () => overflowed,
    }
  })
