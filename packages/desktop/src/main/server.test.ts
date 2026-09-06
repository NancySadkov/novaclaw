import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

/**
 * `preferAppEnv` is the packaging seam that shipped v0.1.0 unusable (AGENTS.md → Known pitfalls #0).
 * `Object.assign(process.env, { KEY: undefined })` does NOT skip the key — Node coerces env values to
 * strings, so XDG_DATA_HOME, XDG_CONFIG_HOME and XDG_CACHE_HOME each became
 * the literal text "undefined". The value was non-empty, so every `??`/`||` fallback downstream
 * accepted it, the server resolved its data directory to `undefined\novaclaw`, and every session
 * create answered 500.
 *
 * Which is why these assertions are about a key's PRESENCE, not only its value: the bug was a key
 * that EXISTED holding a poison string, and only `"KEY" in process.env === false` tells "correctly
 * left unset" apart from "set to garbage". A value-only assertion (`!== "undefined"`) is passed by a
 * wrong fix that coalesces to `""` — which would break the same fallbacks in the same way.
 */

// `server.ts` imports electron directly and pulls electron-store / electron-log in through ./store
// and ./logging at module load; `preferAppEnv`'s non-win32 arm additionally SPAWNS a login shell
// through ./shell-env, which on Linux/macOS would both break hermeticity and merge that shell's real
// XDG_* values into the assertions below. Stub those edges, then import the module under test
// dynamically so the mocks are registered first — the convention in
// packages/novaclaw/test/mcp/oauth-browser.test.ts and app/src/components/prompt-input/submit.test.ts.
//
// The shell-env stub keeps every OTHER export real: bun module mocks are process-global and
// `bun test src` runs shell-env.test.ts in the same process against this same module.
const realShellEnv = { ...(await import("./shell-env")) }

// ⚠️ Must stay EQUIVALENT to the stub in supervise-faults.test.ts, which mocks the same specifier in
// the same process. Bun module mocks are process-global and the last registration wins, so if these
// two disagreed the winner would be decided by test-file ordering — i.e. by whatever filename
// someone adds next. Neither file uses `app`/`utilityProcess` from here directly: the fork defers to
// a `globalThis` slot that only the fault-injection file ever fills.
const FORK_SLOT = Symbol.for("novaclaw.desktop.test.sidecar-fork")
const forkSlot = globalThis as unknown as Record<symbol, (() => unknown) | undefined>
void mock.module("electron", () => ({
  default: {},
  app: { on: () => {}, off: () => {}, isPackaged: false },
  utilityProcess: {
    fork: () => {
      const hook = forkSlot[FORK_SLOT]
      if (!hook) throw new Error("no sidecar fork hook installed for this test")
      return hook()
    },
  },
}))
void mock.module("./logging", () => ({
  getLogger: () => ({ log: () => {} }),
}))
void mock.module("./store", () => ({
  getStore: () => {
    throw new Error("getStore() is unreachable from preferAppEnv")
  },
}))
void mock.module("./shell-env", () => ({
  ...realShellEnv,
  getUserShell: () => "/bin/sh",
  loadShellEnv: () => null,
}))

const { preferAppEnv } = await import("./server")

const XDG_HOMES = ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"] as const
const MANAGED_KEYS = [
  "NOVACLAW_DEV_ISOLATED",
  "NOVACLAW_CLIENT",
  "NOVACLAW_EXPERIMENTAL_ICON_DISCOVERY",
  "NOVACLAW_EXPERIMENTAL_FILEWATCHER",
  ...XDG_HOMES,
] as const

const clearManaged = () => {
  for (const key of MANAGED_KEYS) delete process.env[key]
}

describe("preferAppEnv", () => {
  // preferAppEnv mutates the REAL process.env via Object.assign, so every case has to hand the
  // process back exactly as it found it — a leaked XDG_* would poison every sibling suite in this
  // package's single `bun test` process (and the core suites once desktop joins the default tier).
  let saved: ReadonlyArray<readonly [string, string | undefined]> = []

  beforeEach(() => {
    saved = MANAGED_KEYS.map((key) => [key, process.env[key]] as const)
    clearManaged()
  })

  afterEach(() => {
    for (const [key, value] of saved) {
      // Absent keys are DELETED, never restored as "" — the distinction this whole file is about.
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  test("leaves the XDG homes unset outside dev-isolated mode (the v0.1.0 regression)", () => {
    preferAppEnv()

    // Names the historical bug: in v0.1.0 all three held the literal text "undefined".
    expect(XDG_HOMES.filter((key) => process.env[key] === "undefined")).toEqual([])
    // And the actual invariant — an unset variable stays ABSENT, which is what lets the server fall
    // back to the documented $HOME/.local/share layout instead of accepting a poisoned value.
    expect(XDG_HOMES.filter((key) => key in process.env)).toEqual([])
  })

  test("dev isolation does not manufacture four alternate instance roots", () => {
    process.env.NOVACLAW_DEV_ISOLATED = "1"

    preferAppEnv()

    expect(XDG_HOMES.filter((key) => key in process.env)).toEqual([])
  })

  test("never overwrites an XDG home the environment already provides", () => {
    process.env.XDG_CONFIG_HOME = "/existing/config"

    preferAppEnv()

    expect(process.env.XDG_CONFIG_HOME).toBe("/existing/config")
    expect(["XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"].filter((key) => key in process.env)).toEqual([])
  })

  test("dev isolation leaves an inherited XDG value untouched without filling its siblings", () => {
    process.env.NOVACLAW_DEV_ISOLATED = "1"
    process.env.XDG_DATA_HOME = "/existing/data"

    preferAppEnv()

    expect(process.env.XDG_DATA_HOME).toBe("/existing/data")
    expect(["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"].filter((key) => key in process.env)).toEqual([])
  })

  test("keeps default state and data paths consistent between desktop and CLI", () => {
    preferAppEnv()

    // State and auth files follow the same CLI-compatible XDG defaults.
    expect("XDG_STATE_HOME" in process.env).toBe(false)

    clearManaged()
    process.env.XDG_STATE_HOME = "/existing/state"
    preferAppEnv()
    expect(process.env.XDG_STATE_HOME).toBe("/existing/state")
  })

  test("stamps the desktop client marker and the experimental flags", () => {
    preferAppEnv()

    expect({
      client: process.env.NOVACLAW_CLIENT,
      icons: process.env.NOVACLAW_EXPERIMENTAL_ICON_DISCOVERY,
      filewatcher: process.env.NOVACLAW_EXPERIMENTAL_FILEWATCHER,
    }).toEqual({ client: "desktop", icons: "true", filewatcher: "true" })
  })
})
