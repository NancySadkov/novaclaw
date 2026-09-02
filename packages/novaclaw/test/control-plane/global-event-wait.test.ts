import { expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { GlobalBus, MAX_LISTENERS } from "../../src/bus/global"
import { Workspace } from "../../src/control-plane/workspace"
import { WorkspaceV2 } from "@novaclaw/core/workspace"

/**
 * **Waiting on the global bus: the deadline, the wakeup, and the cap on the bus itself.**
 *
 * These three share a file because they are three halves of one mechanism — a sync fence waits by
 * subscribing to `GlobalBus`, so a fence that never expires and a bus that drops subscribers are the
 * same request hanging for two different reasons.
 *
 * ⚠️ The first case's claim IS a duration, so it runs on the LIVE clock deliberately: a virtual clock
 * would make "the deadline never arrives" and "the deadline arrives instantly" indistinguishable, and
 * every timeout would read as a deadlock.
 */

const workspaceID = WorkspaceV2.ID.make("wrk_global_event_wait")

/** `synced()` reads exactly one chain off the database; `rows` answers it, round by round. */
const stubDb = (rows: () => Array<{ id: string; seq: number }>) =>
  ({
    select: () => ({ from: () => ({ where: () => ({ all: () => Effect.sync(rows) }) }) }),
  }) as never

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

test("a steady stream of matching events does not restart the deadline", async () => {
  // Every durable event on the instance carries a `"sync"` payload, so this is what an ordinary busy
  // instance looks like to the fence's predicate — not a pathological case.
  const stream = setInterval(() => {
    GlobalBus.emit("event", { workspace: workspaceID, payload: { type: "sync" } })
  }, 20)

  const startedAt = Date.now()
  try {
    const settled = await Promise.race([
      Effect.runPromise(
        Effect.exit(
          Workspace.waitUntilSynced({
            db: stubDb(() => []),
            workspaceID,
            // Never reachable: the fence wants sequence 5 and the store answers with nothing.
            state: { agg_never_synced: 5 },
            timeout: 300,
          }),
        ),
      ),
      // ⚠️ BOUNDED. A deadline that restarts never returns, and this must FAIL rather than hang.
      delay(3_000).then(() => "still-waiting" as const),
    ])

    expect(settled).not.toBe("still-waiting")
    expect(Exit.isFailure(settled as never)).toBe(true)
    // The budget is for the whole wait, so this is a 300 ms deadline and not "300 ms of silence".
    expect(Date.now() - startedAt).toBeLessThan(1_500)
  } finally {
    clearInterval(stream)
  }
}, 20_000)

test("an event that lands while the condition is being re-checked is not lost", async () => {
  let checks = 0
  const rows = () => {
    checks++
    if (checks > 1) return [{ id: "agg_late_wakeup", seq: 1 }]
    // The ONLY event this test ever emits, delivered from inside the first check — the window
    // between a match and the re-arm, which is where a re-armed one-shot listener drops it. Nothing
    // arrives afterwards, so a dropped wakeup can only end in the timeout.
    GlobalBus.emit("event", { workspace: workspaceID, payload: { type: "sync" } })
    return []
  }

  const startedAt = Date.now()
  const settled = await Promise.race([
    Effect.runPromise(
      Effect.exit(
        Workspace.waitUntilSynced({
          db: stubDb(rows),
          workspaceID,
          state: { agg_late_wakeup: 1 },
          timeout: 2_000,
        }),
      ),
    ),
    delay(5_000).then(() => "still-waiting" as const),
  ])

  expect(settled).not.toBe("still-waiting")
  expect(Exit.isSuccess(settled as never)).toBe(true)
  expect(checks).toBeGreaterThanOrEqual(2)
  // A lost wakeup does not fail loudly — it burns the whole timeout and then reports success late.
  expect(Date.now() - startedAt).toBeLessThan(1_000)
}, 20_000)

test("the global bus is capped for its real subscriber count, not Node's default ten", () => {
  expect(MAX_LISTENERS).toBeGreaterThan(10)
  expect(GlobalBus.getMaxListeners()).toBe(MAX_LISTENERS)

  // The behaviour, not just the number: sixteen ordinary subscribers is a desktop window, a browser
  // tab, the CLI and a few agents' streams, and it must not print a leak warning nobody can act on.
  const warnings: string[] = []
  const emitWarning = process.emitWarning
  const listeners = Array.from({ length: 16 }, () => () => undefined)
  try {
    process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
      warnings.push(String((warning as { name?: string })?.name ?? warning))
      return (emitWarning as (...args: never[]) => void).apply(process, [warning, ...rest] as never[])
    }) as typeof process.emitWarning
    for (const each of listeners) GlobalBus.on("event", each)
  } finally {
    for (const each of listeners) GlobalBus.off("event", each)
    process.emitWarning = emitWarning
  }

  expect(warnings.filter((name) => name.includes("MaxListenersExceeded"))).toEqual([])
})
