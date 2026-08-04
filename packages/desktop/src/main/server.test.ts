import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

/**
 * `preferAppEnv` is the packaging seam that shipped v0.1.0 unusable (AGENTS.md → Known pitfalls #0).
 * `Object.assign(process.env, { KEY: undefined })` does NOT skip the key — Node coerces env values to
 * strings, so outside dev-isolated mode XDG_DATA_HOME, XDG_CONFIG_HOME and XDG_CACHE_HOME each became
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

void mock.module("electron", () => ({
  default: {},
  app: {},
  utilityProcess: {},
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

// Nothing in this file touches the filesystem — userDataPath is only ever compared as a string.
const USER_DATA = "/novaclaw-test/userData"
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
    preferAppEnv(USER_DATA)

    // Names the historical bug: in v0.1.0 all three held the literal text "undefined".
    expect(XDG_HOMES.filter((key) => process.env[key] === "undefined")).toEqual([])
    // And the actual invariant — an unset variable stays ABSENT, which is what lets the server fall
    // back to the documented $HOME/.local/share layout instead of accepting a poisoned value.
    expect(XDG_HOMES.filter((key) => key in process.env)).toEqual([])
  })

  test("redirects every XDG home to userDataPath in dev-isolated mode", () => {
    process.env.NOVACLAW_DEV_ISOLATED = "1"

    preferAppEnv(USER_DATA)

    expect(XDG_HOMES.filter((key) => key in process.env)).toEqual([...XDG_HOMES])
    expect(XDG_HOMES.map((key) => process.env[key])).toEqual([USER_DATA, USER_DATA, USER_DATA, USER_DATA])
  })

  test("never overwrites an XDG home the environment already provides", () => {
    process.env.XDG_CONFIG_HOME = "/existing/config"

    preferAppEnv(USER_DATA)

    expect(process.env.XDG_CONFIG_HOME).toBe("/existing/config")
    expect(["XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"].filter((key) => key in process.env)).toEqual([])
  })

  test("an existing XDG home outranks the dev-isolated default", () => {
    process.env.NOVACLAW_DEV_ISOLATED = "1"
    process.env.XDG_DATA_HOME = "/existing/data"

    preferAppEnv(USER_DATA)

    expect(process.env.XDG_DATA_HOME).toBe("/existing/data")
    expect(process.env.XDG_CONFIG_HOME).toBe(USER_DATA)
    expect(process.env.XDG_CACHE_HOME).toBe(USER_DATA)
  })

  test("does not split the production credential key from the CLI instance", () => {
    preferAppEnv(USER_DATA)

    // auth.json lives under the CLI-compatible default XDG data path. Leaving state absent makes the
    // sidecar resolve its credential.key through the matching CLI-compatible default too; assigning
    // USER_DATA here creates two keys for one auth file and makes provider reload fail after either
    // surface writes credentials.
    expect("XDG_STATE_HOME" in process.env).toBe(false)

    clearManaged()
    process.env.XDG_STATE_HOME = "/existing/state"
    preferAppEnv(USER_DATA)
    expect(process.env.XDG_STATE_HOME).toBe("/existing/state")
  })

  test("stamps the desktop client marker and the experimental flags", () => {
    preferAppEnv(USER_DATA)

    expect({
      client: process.env.NOVACLAW_CLIENT,
      icons: process.env.NOVACLAW_EXPERIMENTAL_ICON_DISCOVERY,
      filewatcher: process.env.NOVACLAW_EXPERIMENTAL_FILEWATCHER,
    }).toEqual({ client: "desktop", icons: "true", filewatcher: "true" })
  })
})
