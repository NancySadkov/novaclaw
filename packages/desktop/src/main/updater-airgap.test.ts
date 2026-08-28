import { describe, expect, test } from "bun:test"

import { updaterIsAirgapped } from "./updater-airgap"

/**
 * 🔴 **NC-SEC-001 — the startup poll raced the policy it obeys.**
 *
 * The airgap force-off asks the sidecar, which is authoritative: offline mode is a STORE setting and
 * is true independently of `NOVACLAW_OFFLINE`. But the probe is only assigned once the sidecar has
 * spawned, and the startup poll fires first — so the first check of every launch evaluated the probe
 * as absent, concluded "not airgapped", and went to the network. `updater.start()` downloads when a
 * release exists, so this was a fetch, not just a ping.
 *
 * A/B: change `if (!input.probe) return true` to `return false` and "an UNKNOWN policy is treated as
 * airgapped" fails — which is the entire finding, one character wide.
 */
describe("the updater's airgap check", () => {
  const never = async () => false
  const always = async () => true

  test("🔴 an UNKNOWN policy is treated as airgapped — the startup race", async () => {
    // The probe is undefined for the whole window between launch and the sidecar coming up, which is
    // exactly when the startup poll runs.
    expect(await updaterIsAirgapped({ env: undefined, probe: undefined })).toBe(true)
  })

  test("the env var short-circuits, so it works before any sidecar exists", async () => {
    expect(await updaterIsAirgapped({ env: "true", probe: never })).toBe(true)
    expect(await updaterIsAirgapped({ env: "1", probe: never })).toBe(true)
  })

  test("once the sidecar answers, the STORE decides", async () => {
    // The control: without this the guard could simply always return true and the tests above would
    // still pass, while the updater never checked again.
    expect(await updaterIsAirgapped({ env: undefined, probe: never })).toBe(false)
    expect(await updaterIsAirgapped({ env: undefined, probe: always })).toBe(true)
  })

  test("an unset or unrelated env value defers to the probe rather than deciding", async () => {
    expect(await updaterIsAirgapped({ env: "", probe: never })).toBe(false)
    expect(await updaterIsAirgapped({ env: "false", probe: always })).toBe(true)
  })
})
