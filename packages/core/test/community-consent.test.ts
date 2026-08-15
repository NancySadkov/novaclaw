import { describe, expect, test } from "bun:test"
import { CommunityConsent } from "@novaclaw/core/community/consent"

/**
 * 🔴 The gate in front of the whole P2P module. Off on a fresh install, and these pin why.
 *
 * Joining exposes two things the user has to accept first, both properties of the architecture:
 * the network is UNMODERATED (nobody can delete what a stranger writes), and a direct connection
 * reveals this machine's IP to the other end, because there is no central server to hide behind.
 */
const gate = (config: unknown, airgap = false) =>
  CommunityConsent.resolveGate({ config, policy: { enabled: airgap } })

describe("CommunityConsent", () => {
  test("🔴 a fresh install does NOT participate — absence means never asked", () => {
    // ⚠️ The opposite default from telemetry, which is on until refused. Here absence means the
    // question has never been put to anyone, and answering it for them is what this exists to stop.
    expect(CommunityConsent.participates(gate(undefined))).toBe(false)
    expect(CommunityConsent.participates(gate({}))).toBe(false)
    expect(CommunityConsent.refusals(gate({}))).toEqual(["never_consented"])
  })

  test("🔴 consent alone turns it on — a second switch would be a puzzle, not a safeguard", () => {
    expect(CommunityConsent.participates(gate({ community: { consented: true } }))).toBe(true)
    expect(CommunityConsent.refusals(gate({ community: { consented: true } }))).toEqual([])
  })

  test("the settings switch turns it off again, reversibly, without un-reading the warning", () => {
    const off = gate({ community: { consented: true, enabled: false } })
    expect(CommunityConsent.participates(off)).toBe(false)
    expect(CommunityConsent.refusals(off)).toEqual(["switched_off"])
    // STICKY: consent survives the switch, so re-enabling does not re-ask.
    expect(off.consented).toBe(true)
  })

  test("🔴 config edited by hand to skip the warning does not run", () => {
    // `enabled` without `consented` is not a state the UI can produce — it means somebody wrote it
    // into the file. The gate refuses it rather than treating the switch as implied consent.
    const forged = gate({ community: { enabled: true } })
    expect(CommunityConsent.participates(forged)).toBe(false)
    expect(CommunityConsent.refusals(forged)).toEqual(["never_consented"])
  })

  test("🔴 the airgap forces it off INDEPENDENTLY, and both refusals are reported", () => {
    const airgapped = gate({ community: { consented: true } }, true)
    expect(CommunityConsent.participates(airgapped)).toBe(false)
    expect(CommunityConsent.refusals(airgapped)).toEqual(["airgap"])

    /**
     * ⚠️ An ARRAY, not a first match. Never-consented AND airgapped is a real state, and a surface
     * reporting only one would send the user to fix a thing that would not help — the reason
     * telemetry's gate returns a list too.
     */
    const both = gate({}, true)
    expect(CommunityConsent.refusals(both)).toEqual(["never_consented", "airgap"])
  })

  test("changing only the config never moves airgap, and only the policy never moves consent", () => {
    // The two conditions are read from different sources with no cross-reference; this is what makes
    // "the airgap overrides INDEPENDENTLY" a checked fact rather than a sentence in a comment.
    expect(gate({ community: { consented: true } }, false).airgap).toBe(false)
    expect(gate({ community: { consented: true } }, true).airgap).toBe(true)
    expect(gate({}, true).consented).toBe(false)
    expect(gate({ community: { consented: true } }, true).consented).toBe(true)
  })
})
