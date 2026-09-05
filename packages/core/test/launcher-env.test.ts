import { describe, expect, test } from "bun:test"
import fs from "fs"
import { Flag } from "@novaclaw/core/flag/flag"
import { DESKTOP_SERVER_TS, LAUNCHER_ENV_SCRUB, launcherInjectedNames } from "./fixture/launcher-env"

/**
 * 🔴 **The ratchet on "a test run inherited the running instance's environment".**
 *
 * `fixture/launcher-env.ts` records why nine `core` tests failed on a clean `main` on 2026-09-04: the
 * suite was launched from inside a live desktop instance, so it inherited that installation's variables
 * and the code under test answered correctly about the machine while the assertion described a bare
 * checkout. The scrub fixes today's nine. This file is what stops the class from coming back, because a
 * scrub list nobody can prove is COMPLETE is the "the guard exists, one site over" shape this repo already
 * has too much of: the launcher adds one line, and every test silently starts describing a different
 * machine again.
 */
describe("the test environment is not the launcher's environment", () => {
  test("no install-shape variable survives the preload", () => {
    for (const name of LAUNCHER_ENV_SCRUB) {
      // `toBe(undefined)` and not `toBeFalsy`: an EMPTY value is still a value the code under test sees,
      // and `env(...) ?? "cli"` treats "" as present.
      expect(process.env[name]).toBeUndefined()
    }
  })

  test("the flag that the inherited environment moves reads as a bare checkout", () => {
    // The behavioural consequence, not just the env shape: `models-dev.ts` puts this in the User-Agent,
    // so an inherited `desktop` silently changes an outbound request header inside a test.
    expect(Flag.NOVACLAW_CLIENT).toBe("cli")
  })

  test("every variable the launcher injects is in the scrub list", () => {
    // Read from the injector itself rather than from a copy of its list, so the check cannot rot into a
    // second source of truth that agrees with itself.
    const injected = launcherInjectedNames(fs.readFileSync(DESKTOP_SERVER_TS, "utf8"))
    expect(injected.length).toBeGreaterThan(0)
    for (const name of injected) {
      expect((LAUNCHER_ENV_SCRUB as readonly string[]).includes(name)).toBe(true)
    }
  })
})
