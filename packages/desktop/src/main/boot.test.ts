import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Fiber } from "effect"
import { bootWindowFirst, describeSidecarFailure } from "./boot"

/**
 * The three boot faults this file pins, all of which used to present to a user as *nothing happens
 * when I launch it*:
 *
 *   1. the sidecar never becomes healthy  — 30 s health gate
 *   2. the sidecar crashes mid-startup    — was logged NOWHERE (defect vs `Effect.catch`)
 *   3. the window itself cannot be opened — was a silent main-fiber death
 *
 * ⚠️ What is NOT covered here is stated plainly rather than faked: nothing below launches Electron,
 * so "a BrowserWindow appeared on screen" is not asserted anywhere. What IS asserted is the
 * ordering contract the window depends on — `openWindow` runs, and has already returned, while the
 * sidecar effect is still pending — plus the source-order ledger in `index.test.ts` that keeps
 * `index.ts` wired to it.
 */
describe("boot ordering", () => {
  test("opens the window before the sidecar settles", async () => {
    const events: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const fiber = Effect.runFork(
      bootWindowFirst({
        openWindow: () => {
          events.push("window")
          return "window-handle"
        },
        onWindowFailed: () => events.push("window-failed"),
        sidecar: Effect.promise(() => gate).pipe(Effect.tap(() => Effect.sync(() => events.push("sidecar")))),
        onSidecarSettled: () => events.push("settled"),
      }),
    )

    // The sidecar is still pending here — and the window already exists. That is the whole fix.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(events).toEqual(["window"])

    release()
    const exit = await Effect.runPromise(Fiber.await(fiber))
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(events).toEqual(["window", "sidecar", "settled"])
  })

  test("a window that cannot be opened is named, and the sidecar still starts", async () => {
    const notices: string[] = []
    const events: string[] = []

    const exit = await Effect.runPromiseExit(
      bootWindowFirst({
        openWindow: () => {
          throw new Error("EPERM: electron-window-state could not read window-state.json")
        },
        onWindowFailed: (notice) => notices.push(`${notice.code}|${notice.summary}|${notice.detail}`),
        sidecar: Effect.sync(() => events.push("sidecar")),
        onSidecarSettled: () => events.push("settled"),
      }),
    )

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain("window.create.failed")
    expect(notices[0]).toContain("NovaClaw could not open its window.")
    expect(notices[0]).toContain("window-state.json")
    expect(events).toEqual(["sidecar", "settled"])
  })
})

describe("sidecar health failures are named", () => {
  test("a health wait that never completes is reported as a timeout", async () => {
    // The real construct, not a hand-built Cause: `Effect.timeout` is what `index.ts` pipes.
    const exit = await Effect.runPromiseExit(Effect.never.pipe(Effect.timeout("10 millis")))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) return

    const failure = describeSidecarFailure(exit.cause, "health")
    expect(failure.kind).toBe("timeout")
    expect(failure.code).toBe("sidecar.health.timeout")
    expect(failure.summary).toContain("did not pass its health check in time")
  })

  /**
   * Ruling 2 against this function itself. The port probe is deadlined too, and its timeout reaches
   * `onSidecarSettled` with a `TimeoutError` indistinguishable from the health gate's — so a single
   * wording would report *"did not pass its health check"* for a failure that never got as far as
   * spawning anything, and send the next reader to the wrong subsystem.
   */
  test("a startup-stage timeout is NOT described as a health-check failure", async () => {
    const exit = await Effect.runPromiseExit(Effect.never.pipe(Effect.timeout("10 millis")))
    if (Exit.isSuccess(exit)) return

    const failure = describeSidecarFailure(exit.cause, "startup")
    expect(failure.kind).toBe("timeout")
    expect(failure.code).toBe("sidecar.startup.timeout")
    expect(failure.summary).toBe("The local server did not finish starting in time.")
    expect(failure.summary).not.toContain("health")
  })

  test("a startup-stage error names the stage it actually failed in", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.fail(new Error("listen EADDRINUSE: address already in use 127.0.0.1:4096")),
    )
    if (Exit.isSuccess(exit)) return

    const failure = describeSidecarFailure(exit.cause, "startup")
    expect(failure.code).toBe("sidecar.startup.failed")
    expect(failure.summary).toBe(
      "The local server could not be started: listen EADDRINUSE: address already in use 127.0.0.1:4096",
    )
    expect(failure.summary).not.toContain("health")
  })

  test("a sidecar that exits mid-startup is caught and its reason survives", async () => {
    const logged: Array<{ kind: string; summary: string }> = []
    const crash = new Error("Sidecar exited before health check passed with code 3221225477")

    // This is `index.ts`'s pipeline verbatim in shape: tryPromise → timeout → catchCause.
    const exit = await Effect.runPromiseExit(
      Effect.tryPromise({ try: () => Promise.reject(crash), catch: (error) => error }).pipe(
        Effect.timeout("30 seconds"),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            const failure = describeSidecarFailure(cause, "health")
            logged.push({ kind: failure.kind, summary: failure.summary })
          }),
        ),
      ),
    )

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(logged).toHaveLength(1)
    expect(logged[0].kind).toBe("error")
    expect(logged[0].summary).toContain("3221225477")
  })

  test("an interrupted health wait is not reported as a crash", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.never)
        yield* Fiber.interrupt(fiber)
        return yield* Fiber.await(fiber)
      }),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isFailure(exit)) return

    const inner = exit.value
    expect(Exit.isFailure(inner)).toBe(true)
    if (Exit.isSuccess(inner)) return
    expect(describeSidecarFailure(inner.cause).kind).toBe("interrupted")
  })

  /**
   * The premise the whole fix rests on, measured against the pinned `effect@4.0.0-beta.83` rather
   * than assumed: `Effect.promise` turns a rejection into a DEFECT, and `Effect.catch` does not see
   * defects. That pair is why a real sidecar crash reached no handler and was logged nowhere. If a
   * future effect release changes either half, this goes red and the comments above stop being true.
   */
  test("Effect.catch does NOT see a rejected Effect.promise — the shape that hid the crash", async () => {
    let handled = false
    const exit = await Effect.runPromiseExit(
      Effect.promise(() => Promise.reject(new Error("boom"))).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            handled = true
          }),
        ),
      ),
    )

    expect(handled).toBe(false)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) return
    expect(Cause.hasDies(exit.cause)).toBe(true)
  })

  test("Effect.catchCause DOES see it — the shape that replaced it", async () => {
    let handled = false
    const exit = await Effect.runPromiseExit(
      Effect.promise(() => Promise.reject(new Error("boom"))).pipe(
        Effect.catchCause(() =>
          Effect.sync(() => {
            handled = true
          }),
        ),
      ),
    )

    expect(handled).toBe(true)
    expect(Exit.isSuccess(exit)).toBe(true)
  })
})
