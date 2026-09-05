import { Effect, Fiber } from "effect"

/**
 * Run an Effect under a bound that a wedged fiber cannot outlive.
 *
 * S2's admission test is that the rewritten session-runner suite runs on win32 in the default tier —
 * which means no case in it may hang. The old suite hangs, and the reason is measured (2026-08-05, see
 *  → S2):
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
    // Always interrupt, on every exit path. A bound that reports a runaway and then leaves it running
    // has moved the wedge from this test into the next one, where it will be blamed on innocent code.
    //
    // 🔴 ⚠️ **BUT THE INTERRUPT ITSELF MUST BE BOUNDED — this line used to be a bare `await` and that
    // made the helper the exact hang it exists to prevent (measured 2026-08-05).** `Effect.interrupt`
    // cannot land while the fiber sits in an UNINTERRUPTIBLE region, and `Effect.acquireRelease` makes
    // every acquire uninterruptible — which is how every scoped resource in the graph is taken,
    // including `EffectFlock.acquire` (`util/effect-flock.ts`, "acquire is uninterruptible"), whose own
    // wait is `timeoutMs: 5 * 60_000`. So a case parked in an acquire would: trip the 60 s bound, throw
    // as designed, and then **block in this `finally` for as long as the acquire takes**, printing
    // nothing. Observed as a bun process at 0 s CPU against 247–412 s elapsed holding ~6.7 GB of commit
    // — indistinguishable from the wedge this file was written to make impossible.
    //
    // So: fire the interrupt, give it a short grace period, and return regardless. A teardown that can
    // outlive its own timeout is not a timeout.
    //
    // ⚠️ **The grace timer is CLEARED, and that is not tidiness.** A pending `setTimeout` keeps the
    // event loop alive, so leaving one behind per call would delay process exit by up to the grace
    // period — reintroducing "the tests passed and the process would not exit" as a *new* leak inside
    // the fix for the old one. Found by reading, before this file had ever been run.
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Effect.runPromise(Fiber.interrupt(fiber)).then(
          () => undefined,
          () => undefined,
        ),
        new Promise<void>((resolve) => {
          graceTimer = setTimeout(resolve, INTERRUPT_GRACE_MS)
        }),
      ])
    } finally {
      if (graceTimer !== undefined) clearTimeout(graceTimer)
    }
  }
}

/**
 * How long to wait for an interrupt to land before giving up on it.
 *
 * Deliberately short. If the fiber is interruptible the interrupt lands in milliseconds (measured: a
 * cooperative spin died in 209 ms). If it is not, no amount of waiting here helps — the process-level
 * backstop in `script/test.ts` is what remains, and blocking the whole suite meanwhile buys nothing.
 *
 * ⚠️ **This is a deliberate MIDDLE, not a free win, and the trade is worth knowing before you tune it.**
 * Interruption is what runs a fiber's finalizers, and in this graph a finalizer is what releases the
 * **one-permit semaphore guarding the SQLite connection** (`database/sqlite.bun.ts` — `Semaphore.make(1)`
 * plus an `uninterruptibleMask` transaction acquirer, and `semaphore.take(1)` has no timeout). So the
 * original bare `await` was not merely wrong: awaiting is correct for permit hygiene and unbounded in
 * the worst case, while returning early is prompt and may abandon a held permit. Long enough for
 * finalizers in the normal case, bounded in the pathological one.
 *
 * ✅ **The blast radius of getting this wrong is ONE test, not the file** — worth knowing before anyone
 * lengthens the grace out of caution. Each `drive()` builds its own root memo map, hence its own
 * `:memory:` database, connection and semaphore (`Database.node` has `deps: []`, and
 * `effect/layer-node.ts:299-301` returns such a node's layer unchanged, so sharing is a property of the
 * memo map). A permit abandoned here dies with its harness. `runner-harness-drain.test.ts`'s isolation
 * case is the standing proof: it would fail outright if two harnesses shared a database.
 */
const INTERRUPT_GRACE_MS = 1_000
