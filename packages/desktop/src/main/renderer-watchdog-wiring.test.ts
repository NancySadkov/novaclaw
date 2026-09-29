import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

/**
 * 🔴 A WEDGED RENDERER MUST BE RECOVERED, NOT PHOTOGRAPHED.
 *
 * Measured 2026-09-29 on a live client against a server that was provably healthy — `/global/health`
 * answered 200 in 13 ms. The renderer froze mid-session and never recovered: the window stopped
 * painting entirely (the tab activity indicators stopped pulsing, which is a renderer no longer
 * producing frames), the server logged no client connection for the duration, and the client's own
 * network service sat on six sockets `Established` for 366 s that would never carry a request again.
 *
 * The old response was a dialog offering to relaunch the app, open the logs, or keep waiting — three
 * manual escapes, from a product whose own rule is that it heals itself. The sidecar already killed and
 * restarted a hung process; the renderer only sampled a stack.
 *
 * The behaviour is pinned in `renderer-watchdog.test.ts`. This file holds the WIRE, because the
 * failure mode that matters most is not a wrong policy — it is a correct policy that nothing calls.
 */
const windows = readFileSync(new URL("./windows.ts", import.meta.url), "utf8")
const code = windows
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((line) => !line.trim().startsWith("//"))
  .join("\n")

describe("the renderer watchdog is armed, and armed on the right events", () => {
  test("an unresponsive window arms the watchdog", () => {
    expect(code).toMatch(/win\.on\("unresponsive",[\s\S]*?watchdog\.arm\(\)/)
  })

  test("🔴 a window that RECOVERS disarms it before anything else", () => {
    // Order is the whole point. If the sampler runs first and the window is responsive again, a timer
    // already counting toward a reload would still fire and destroy a window that had come back.
    const handler = /win\.on\("responsive",[\s\S]*?\}\)/
      .exec(code)?.[0]
    expect(handler, "the responsive handler must still be findable — a rename must fail here").toBeDefined()
    expect(handler!.indexOf("watchdog.disarm()")).toBeGreaterThan(-1)
    expect(handler!.indexOf("watchdog.disarm()")).toBeLessThan(handler!.indexOf("sampler.stopAndFlush()"))
  })

  test("a closed window disarms it, so a reload cannot fire into a window that is gone", () => {
    expect(code).toMatch(/win\.on\("closed", \(\) => watchdog\.disarm\(\)\)/)
  })

  test("the stack sampler is still started — the diagnosis is not traded for the cure", () => {
    expect(code).toMatch(/win\.on\("unresponsive",[\s\S]*?sampler\.start\(\)/)
  })
})

describe("the old dead end is gone", () => {
  test("🔴 being frozen no longer opens a dialog before the shell has tried to fix it", () => {
    // The frozen client was met with this, immediately, on the `unresponsive` event:
    //   show("NovaClaw is not responding", "You can relaunch the app, open the logs, or keep waiting.")
    // Three ways for a person to do what the shell should have done on its own — and it asked BEFORE
    // trying, so the person was invited to do the recovery while the watchdog was still counting out
    // its grace period. The dialog now belongs to give-up only, which is the one moment a person can
    // actually help.
    expect(windows).not.toMatch(/You can relaunch the app/)
    const onUnresponsive = /win\.on\("unresponsive",[\s\S]*?\n  \}\)/.exec(code)?.[0]
    expect(onUnresponsive, "the unresponsive handler must remain findable").toBeDefined()
    expect(onUnresponsive).not.toMatch(/show\(/)
  })

  test("the watchdog gets its grace period before a person is asked to intervene", () => {
    // The `show` that survives is the give-up one, and it is reached only after the policy has
    // exhausted its reloads — so the dialog can never race the recovery it is meant to replace.
    expect(code).toMatch(/onGivenUp:[\s\S]*?void show\(/)
    expect(code).not.toMatch(/onRecovered:[\s\S]{0,200}?void show\(/)
  })

  test("a recovery is logged, so the reload is visible in the record rather than silent", () => {
    expect(code).toContain("renderer recovered by reload")
    // And the give-up is reported rather than swallowed: a stopped watchdog must still SAY it stopped.
    expect(code).toContain("renderer did not recover")
  })
})
