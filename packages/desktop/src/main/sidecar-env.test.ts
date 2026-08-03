import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { prepareSidecarEnv } from "./sidecar-env"

const KEYS = ["NOVACLAW_SERVER_USERNAME", "NOVACLAW_SERVER_PASSWORD", "XDG_STATE_HOME"] as const

describe("prepareSidecarEnv", () => {
  let saved: ReadonlyArray<readonly [string, string | undefined]> = []

  beforeEach(() => {
    saved = KEYS.map((key) => [key, process.env[key]] as const)
    for (const key of KEYS) delete process.env[key]
  })

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  test("does not split the production credential key from the default instance", () => {
    prepareSidecarEnv("secret")

    expect("XDG_STATE_HOME" in process.env).toBe(false)
  })

  test("preserves an explicit state home", () => {
    process.env.XDG_STATE_HOME = "C:\\existing\\state"

    prepareSidecarEnv("secret")

    expect(process.env.XDG_STATE_HOME).toBe("C:\\existing\\state")
  })
})
