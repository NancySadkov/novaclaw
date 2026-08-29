import { describe, expect, test } from "bun:test"

import { updaterAirgapFromManifest, updaterNetworkPolicy } from "./updater-airgap"

/**
 * 🔴 **NC-SEC-001 — the startup poll raced the policy it obeys.**
 *
 * The airgap force-off asks the sidecar, which is authoritative: offline mode is a STORE setting and
 * is true independently of `NOVACLAW_OFFLINE`. But the probe is only assigned once the sidecar has
 * spawned, and the startup poll fires first — so the first check of every launch evaluated the probe
 * as absent, concluded "not airgapped", and went to the network. `updater.start()` downloads when a
 * release exists, so this was a fetch, not just a ping.
 *
 * A/B: remove the `!input.probe` refusal and the UNKNOWN-policy test fails. The controller tests
 * then prove that neither backend network method runs under that result.
 */
describe("the updater's airgap check", () => {
  const never = async () => false
  const always = async () => true

  test("🔴 an UNKNOWN policy is treated as airgapped — the startup race", async () => {
    // The probe is undefined for the whole window between launch and the sidecar coming up, which is
    // exactly when the startup poll runs.
    expect(await updaterNetworkPolicy({ env: undefined, probe: undefined })).toEqual({
      allowed: false,
      reason: "policy-unavailable",
    })
  })

  test("the env var short-circuits, so it works before any sidecar exists", async () => {
    expect(await updaterNetworkPolicy({ env: "true", probe: never })).toEqual({ allowed: false, reason: "airgap" })
    expect(await updaterNetworkPolicy({ env: "1", probe: never })).toEqual({ allowed: false, reason: "airgap" })
  })

  test("once the sidecar answers, the STORE decides", async () => {
    // The control: without this the guard could simply always return true and the tests above would
    // still pass, while the updater never checked again.
    expect(await updaterNetworkPolicy({ env: undefined, probe: never })).toEqual({ allowed: true })
    expect(await updaterNetworkPolicy({ env: undefined, probe: always })).toEqual({
      allowed: false,
      reason: "airgap",
    })
  })

  test("an unset or unrelated env value defers to the probe rather than deciding", async () => {
    expect(await updaterNetworkPolicy({ env: "", probe: never })).toEqual({ allowed: true })
    expect(await updaterNetworkPolicy({ env: "false", probe: always })).toEqual({
      allowed: false,
      reason: "airgap",
    })
  })

  test("a failed or undecodable policy probe fails closed", async () => {
    expect(await updaterNetworkPolicy({ env: undefined, probe: async () => undefined })).toEqual({
      allowed: false,
      reason: "policy-unavailable",
    })
    expect(
      await updaterNetworkPolicy({
        env: undefined,
        probe: async () => {
          throw new Error("sidecar unavailable")
        },
      }),
    ).toEqual({ allowed: false, reason: "policy-unavailable" })
  })

  test("reads the updater's named manifest layer, not the aggregate enabled bit", () => {
    expect(
      updaterAirgapFromManifest({
        enabled: false,
        layers: [{ layer: 6, name: "auto-update", active: true }],
      }),
    ).toBe(true)
    expect(
      updaterAirgapFromManifest({
        enabled: true,
        layers: [{ layer: 6, name: "auto-update", active: false }],
      }),
    ).toBeUndefined()
    expect(
      updaterAirgapFromManifest({
        enabled: false,
        layers: [{ layer: 6, name: "auto-update", active: false }],
      }),
    ).toBe(false)
    expect(updaterAirgapFromManifest({ enabled: true })).toBeUndefined()
    expect(updaterAirgapFromManifest({ layers: [{ layer: 6, name: "something-else", active: true }] })).toBeUndefined()
  })
})
