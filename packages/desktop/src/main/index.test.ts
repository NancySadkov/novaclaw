import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { forwardInitializationFailure } from "./initialization"

describe("desktop initialization", () => {
  const failure = new Error("sidecar startup failed")
  const expectFailure = (exit: Exit.Exit<unknown, unknown>) => {
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) return
    expect(Cause.squash(exit.cause)).toBe(failure)
  }

  test("forwards loading task failures before renderer initialization", () => {
    const exit = Effect.runSync(
      Effect.gen(function* () {
        const initialization = yield* Deferred.make<never, unknown>()
        yield* forwardInitializationFailure(initialization)(Effect.die(failure)).pipe(Effect.exit)
        return yield* Deferred.await(initialization).pipe(Effect.exit)
      }),
    )

    expectFailure(exit)
  })

  test("forwards loading task failures while renderer initialization waits", () => {
    const exit = Effect.runSync(
      Effect.gen(function* () {
        const initialization = yield* Deferred.make<never, unknown>()
        const waiting = yield* Deferred.await(initialization).pipe(Effect.exit, Effect.forkChild)
        yield* forwardInitializationFailure(initialization)(Effect.die(failure)).pipe(Effect.exit)
        return yield* Fiber.join(waiting)
      }),
    )

    expectFailure(exit)
  })
})

/**
 * The SOURCE ledger for the boot order.
 *
 * `boot.test.ts` proves that `bootWindowFirst` opens the window before its sidecar effect settles.
 * It cannot prove that `index.ts` still *uses* it, nor that nothing new has been slipped in front
 * of the window — and an Electron main module cannot be booted inside `bun test`, so this is the
 * only mechanical check available for the placement itself. A reader who thinks a source assertion
 * is weak is right; it is here because the alternative is nothing at all, and the defect it guards
 * (`yield* Fiber.await(loadingTask)` above `createMainWindow()`) shipped for months while every
 * behavioural test in the package stayed green.
 *
 * ⚠️ Comments are stripped first. This file's own prose names every symbol below, and a raw regex
 * over source counts prose — the standing rule, and the reason the stripper is a scanner rather
 * than `/\/\*[\s\S]*?\*\//`, which eats a line the moment a string literal contains `/*`.
 */
describe("desktop boot order", () => {
  const source = stripComments(readFileSync(new URL("./index.ts", import.meta.url), "utf8"))
  const at = (needle: string) => {
    const index = source.indexOf(needle)
    expect(index, `${needle} is missing from index.ts`).toBeGreaterThan(-1)
    return index
  }

  // ⚠️ These are CONTAINMENT assertions, not "line A runs before line B". Once the sidecar work
  // moved inside an effect that is *passed* to `bootWindowFirst`, source position stopped tracking
  // execution order — `superviseLocalServer` sits textually above `createMainWindow()` and still
  // runs after it. What is actually checkable is which region each call lives in, so that is what
  // is checked: everything that can block must be inside `startSidecar`, and the window opener must
  // be the `openWindow` argument.
  const startSidecarAt = () => at("const startSidecar")
  const bootCallAt = () => at("bootWindowFirst({")

  test("the window opener is the openWindow argument, not something the boot waits for", () => {
    expect(bootCallAt()).toBeLessThan(at("openWindow:"))
    expect(at("openWindow:")).toBeLessThan(at("createMainWindow()"))
    expect(at("createMainWindow()")).toBeLessThan(at("sidecar: startSidecar"))
  })

  test("nothing in this module awaits a fiber — bootWindowFirst owns the ordering", () => {
    // `yield* Fiber.await(loadingTask)` above `createMainWindow()` IS the defect being removed.
    expect(source).not.toContain("Fiber.await")
  })

  test("spawning the sidecar happens inside startSidecar, so it cannot precede the window", () => {
    expect(startSidecarAt()).toBeLessThan(at("superviseLocalServer("))
    expect(at("superviseLocalServer(")).toBeLessThan(bootCallAt())
  })

  test("preferAppEnv's login-shell probes moved inside startSidecar", () => {
    // Two 5s spawnSync probes on macOS/Linux; before the move they ran ahead of app.whenReady().
    expect(startSidecarAt()).toBeLessThan(at("preferAppEnv("))
    expect(at("preferAppEnv(")).toBeLessThan(bootCallAt())
  })

  test("each failure site names the stage it is actually reporting on", () => {
    // Both stages can surface a bare TimeoutError; the argument is the only thing that keeps the
    // port probe from being logged as a health-check failure (ruling 2).
    expect(source).toContain('describeSidecarFailure(cause, "health")')
    expect(source).toContain('describeSidecarFailure(exit.cause, "startup")')
  })

  test("the ephemeral-port probe is deadlined", () => {
    expect(source).toMatch(/Deferred\.await\(res\)[\s\S]{0,200}Effect\.timeout\("10 seconds"\)/)
  })

  test("a lost port race is re-probed, and ONLY a lost port race", () => {
    // 🔴 The boot used to end on a collision it could not win: probe port 0, close the socket, and
    // the sidecar binds a moment later — anything may take it in that gap, and the user got a
    // "could not start the local server" page for a transient race a second probe would have missed.
    // The retry predicate is the load-bearing part: a BROKEN sidecar must fail on the first attempt,
    // or a prompt named error becomes a long wait for the same one.
    expect(source).toMatch(/Effect\.retry\(\{\s*while:\s*isPortRace/)
    expect(source).toMatch(/error\.name === "PortUnavailableError"/)
    // ⚠️ A user-PINNED port (NOVACLAW_PORT) is never retried: re-probing returns the same number, so
    // the retry cannot succeed and would only serve the honest error three timeouts late.
    expect(source).toMatch(/!portIsPinned && error instanceof Error/)
    expect(source).toMatch(/portIsPinned = process\.env\.NOVACLAW_PORT !== undefined/)
  })

  test("the re-probe is BOUNDED, and the probe is inside the retried effect", () => {
    expect(source).toMatch(/Schedule\.recurs\(PORT_RACE_ATTEMPTS - 1\)/)
    // ⚠️ If `probePort` sat outside `startOn`, every attempt would retry the SAME port — a retry
    // that cannot succeed, which is worse than none because it hides the cause behind a delay.
    const startOn = source.indexOf("const startOn = Effect.gen")
    const retry = source.indexOf("Effect.retry({ while: isPortRace")
    expect(startOn).toBeGreaterThan(0)
    expect(source.indexOf("yield* probePort")).toBeGreaterThan(startOn)
    expect(source.indexOf("yield* probePort")).toBeLessThan(retry)
  })

  test("the URL is built from the port that was actually probed, not a captured one", () => {
    // The main process owns `url`; building it outside the retried effect would publish the port of
    // a FAILED attempt — a server nobody talks to, which is the silent failure this design refuses.
    const startOn = source.indexOf("const startOn = Effect.gen")
    const urlBuild = source.indexOf("const url = `http://${hostname}:${port}`")
    expect(urlBuild).toBeGreaterThan(startOn)
  })

  test("the health wait is caught with catchCause, never catch", () => {
    expect(source).toMatch(/health\.wait[\s\S]{0,400}Effect\.catchCause\(/)
    expect(source).not.toMatch(/health\.wait[\s\S]{0,400}Effect\.catch\(/)
  })

  /**
   * Quitting must WAIT for the sidecar, and must never fail to quit.
   *
   * `before-quit` used to be `void stopSidecars()`. Electron does not wait for a floating promise,
   * so the app exited while the sidecar was still stopping and anything unflushed was lost on every
   * ordinary quit — invisibly, which is why only a source assertion catches its return.
   */
  test("before-quit waits for the sidecar instead of floating the promise", () => {
    expect(source).toMatch(/before-quit[\s\S]{0,600}event\.preventDefault\(\)/)
    expect(source).not.toMatch(/on\("before-quit"[\s\S]{0,120}void stopSidecars\(\)/)
  })

  /**
   * ⚠️ The opposite failure is worse than the one being fixed: an app that will not close is
   * answered with a force-kill, which loses strictly more. Both bounds are asserted, because either
   * one alone is insufficient — a timeout that does not exit, or an exit that can be skipped.
   */
  test("the quit path is bounded and always exits", () => {
    expect(source, "a stuck sidecar must not hold the window open").toMatch(
      /before-quit[\s\S]{0,900}QUIT_DEADLINE_MS/,
    )
    expect(source, "every branch must reach app.exit").toMatch(/before-quit[\s\S]{0,900}\.finally\(\(\) => app\.exit\(0\)\)/)
    expect(source, "the second pass must not be intercepted again").toMatch(
      /before-quit[\s\S]{0,200}if \(quitting\) return/,
    )
  })
})

/** Strip `//` and block comments without being fooled by `"/*"` inside a string or template. */
function stripComments(input: string) {
  let out = ""
  let i = 0
  while (i < input.length) {
    const ch = input[i]!
    const next = input[i + 1]
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch
      out += ch
      i++
      while (i < input.length) {
        const c = input[i]!
        out += c
        i++
        if (c === "\\") {
          if (i < input.length) {
            out += input[i]
            i++
          }
          continue
        }
        if (c === quote) break
      }
      continue
    }
    if (ch === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i++
      continue
    }
    if (ch === "/" && next === "*") {
      i += 2
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++
      i += 2
      continue
    }
    out += ch
    i++
  }
  return out
}
