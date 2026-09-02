import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { Effect } from "effect"

/**
 * Wait for ONE matching global event, then resolve.
 *
 * ⚠️ **If you are re-arming this in a loop until some condition holds, you want {@link waitUntil}
 * instead.** Re-arming a one-shot wait loses two things it cannot give back: the timeout is a budget
 * for a single round, so a stream of matching events restarts it forever and the caller's deadline
 * stops existing; and the listener is detached the instant the predicate matches, so anything
 * arriving between that detach and the next arm is dropped — which for a condition-wait is exactly
 * the event that would have satisfied it.
 */
export function waitEvent(input: { timeout: number; signal?: AbortSignal; fn: (event: GlobalEvent) => boolean }) {
  if (input.signal?.aborted) return Effect.fail(input.signal.reason ?? new Error("Request aborted"))

  return Effect.callback<void, unknown>((resume) => {
    const abort = () => {
      cleanup()
      resume(Effect.fail(input.signal?.reason ?? new Error("Request aborted")))
    }

    const handler = (event: GlobalEvent) => {
      try {
        if (!input.fn(event)) return
        cleanup()
        resume(Effect.void)
      } catch (error) {
        cleanup()
        resume(Effect.fail(error))
      }
    }

    const cleanup = () => {
      clearTimeout(timeout)
      GlobalBus.off("event", handler)
      input.signal?.removeEventListener("abort", abort)
    }

    const timeout = setTimeout(() => {
      cleanup()
      resume(Effect.fail(new Error("Timed out waiting for global event")))
    }, input.timeout)

    GlobalBus.on("event", handler)
    input.signal?.addEventListener("abort", abort, { once: true })
    return Effect.sync(cleanup)
  })
}

/**
 * Wait until `check` says the condition holds, re-checking on every matching global event.
 *
 * 🔴 **Why this is a primitive and not a loop around {@link waitEvent}.** A condition-wait written by
 * re-arming a one-shot event wait is wrong twice over, and both halves shipped:
 *
 *  · **The deadline restarts.** `timeout` is a per-round budget for `waitEvent`, so a caller passing
 *    5 s and re-arming on each match has no 5 s bound at all — it has "5 s of silence". On an
 *    instance where a matching event lands every few hundred milliseconds, the wait never expires,
 *    and the request path holding it never returns.
 *  · **There is a window between the event and the re-check.** The one-shot detaches its listener the
 *    moment the predicate matches, and the next one is attached only after the condition has been
 *    re-evaluated. An event that arrives inside that gap is dropped — so the LAST event before the
 *    instance goes quiet can be the one that is missed, and the wait then burns its whole timeout
 *    waiting for a successor that is never coming.
 *
 * Both are structural here rather than defended: ONE absolute deadline is computed before the first
 * check and every park is bounded by what remains of it, and ONE listener stays attached across the
 * whole wait, latching an arrival so that an event landing DURING a `check` makes the next park
 * return immediately instead of vanishing.
 */
export function waitUntil(input: {
  readonly timeout: number
  readonly signal?: AbortSignal
  readonly fn: (event: GlobalEvent) => boolean
  readonly check: () => Effect.Effect<boolean>
}): Effect.Effect<void, unknown> {
  return Effect.suspend(() => {
    if (input.signal?.aborted) return Effect.fail(input.signal.reason ?? new Error("Request aborted"))

    // ONE deadline for the whole wait, fixed before the first check.
    const deadline = Date.now() + input.timeout
    // Latched by the standing listener. Cleared immediately BEFORE each check, never after, so an
    // event that lands while the check is in flight is still visible to the park that follows it.
    let pending = false
    let failure: { readonly error: unknown } | undefined
    let wake: (() => void) | undefined

    const handler = (event: GlobalEvent) => {
      try {
        if (!input.fn(event)) return
      } catch (error) {
        failure ??= { error }
      }
      pending = true
      wake?.()
    }
    GlobalBus.on("event", handler)

    const park = (ms: number) =>
      Effect.callback<void, unknown>((resume) => {
        if (pending || failure) {
          resume(Effect.void)
          return
        }
        if (input.signal?.aborted) {
          resume(Effect.fail(input.signal.reason ?? new Error("Request aborted")))
          return
        }
        const release = () => {
          clearTimeout(timer)
          wake = undefined
          input.signal?.removeEventListener("abort", abort)
        }
        const abort = () => {
          release()
          resume(Effect.fail(input.signal?.reason ?? new Error("Request aborted")))
        }
        const timer = setTimeout(() => {
          release()
          resume(Effect.fail(new Error("Timed out waiting for global event")))
        }, ms)
        wake = () => {
          release()
          resume(Effect.void)
        }
        input.signal?.addEventListener("abort", abort, { once: true })
        return Effect.sync(release)
      })

    return Effect.gen(function* () {
      for (;;) {
        pending = false
        if (failure) return yield* Effect.fail(failure.error)
        if (yield* input.check()) return
        const remaining = deadline - Date.now()
        if (remaining <= 0) return yield* Effect.fail(new Error("Timed out waiting for global event"))
        yield* park(remaining)
      }
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          wake = undefined
          GlobalBus.off("event", handler)
        }),
      ),
    )
  })
}
