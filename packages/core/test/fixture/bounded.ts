import { Effect, Fiber } from "effect"

/**
 * Run an Effect under a bound that a wedged fiber cannot outlive.
 *
 * S2's admission test is that the rewritten session-runner suite runs on win32 in the default tier —
 * which means no case in it may hang. The old suite hangs, and the reason is measured (2026-08-05, see
 * todo/v0.2.0-prep.md → S2):
 *
 *  1. ⚠️ **A bound expressed in EFFECT time never fires under `TestContext`.** The virtual clock does
 *     not advance on its own, so `Effect.timeout` inside the test waits forever — Effect itself warns
 *     *"A test is using time, but is not advancing the test clock, which may result in the test
 *     hanging."* That is the wedge. So the bound here is a REAL `setTimeout`, outside the runtime,
 *     deliberately unaffected by whatever clock the effect runs under.
 *  2. ⚠️ **A same-process timer cannot bound a SYNCHRONOUS spin** — measured: a 300 ms race lost to a
 *     3 s non-yielding loop, because a blocked event loop cannot run timers. Nothing in-process can
 *     fix that, and this helper does not pretend to: the backstop for a non-yielding runaway is
 *     `script/test.ts`'s wall-clock kill, which is what makes `bun run test` survivable where a bare
 *     `bun test` is not. **This bounds the cooperative case, which is the one a test can recover.**
 *  3. ✅ A cooperative spin IS interruptible from outside — `Fiber.interrupt` killed one in 209 ms.
 *
 * On timeout it REJECTS with `label` and interrupts the fiber, so a runaway case fails by name instead
 * of stalling the suite behind an anonymous per-test timeout — the same legibility the httpapi-listen
 * flake had to be taught (app `3c2d34920`).
 */
export async function runBounded<A, E>(
  effect: Effect.Effect<A, E, never>,
  options: { ms: number; label: string },
): Promise<A> {
  // ⚠️ `Effect.runFork`, not `Effect.fork`. In the `effect@4.0.0-beta.83` build this package resolves,
  // `Effect.fork` is **undefined** while `Effect.runFork` is a function — and the repo root resolves a
  // build where `Effect.fork` DOES exist, so a probe run from there says the opposite. Measured
  // 2026-08-05 both ways. `runFork` is the one that exists in both, and it is what starts a fiber from
  // outside a runtime anyway, which is precisely this helper's position.
  const fiber = Effect.runFork(effect)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Effect.runPromise(Fiber.join(fiber)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${options.label} — still running after ${options.ms}ms`)),
          options.ms,
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    // Always, on every exit path. A bound that reports a runaway and then leaves it running has moved
    // the wedge from this test into the next one, where it will be blamed on innocent code.
    await Effect.runPromise(Fiber.interrupt(fiber)).then(
      () => undefined,
      () => undefined,
    )
  }
}
