import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { UnknownReason } from "@novaclaw/schema/unknown-reason"

/**
 * The vocabulary from `notes/reports/receipt-unknowns-vocabulary-2026-08-12.md`.
 *
 * 🔴 What is being pinned is not the spelling of four strings — it is that each one prescribes a
 * DIFFERENT action, and that the mapping from the tree's existing spellings does not quietly drift
 * onto the one term that tells a reader to stop asking.
 */

const decode = Schema.decodeUnknownSync(UnknownReason.Reason)

describe("the unknowns vocabulary", () => {
  test("carries exactly the four reasons, and rejects an invented fifth", () => {
    for (const reason of ["not-applicable", "not-measured", "measurement-failed", "incomplete"] as const)
      expect(decode(reason)).toBe(reason)
    // A fifth spelling is how a vocabulary stops being one: the next subsystem invents `unknown` and
    // the mapping silently loses whichever action it meant. ⚠️ Cast because the point is precisely
    // that the TYPE already forbids this — what is under test is that the RUNTIME refuses it too,
    // which is what protects a value arriving from a database column or the wire.
    expect(() => decode("unknown" as UnknownReason.Reason)).toThrow()
  })

  test("🔴 only `not-measured` is obtainable — the reader can run something", () => {
    expect(UnknownReason.isObtainable("not-measured")).toBe(true)
    expect(UnknownReason.isObtainable("measurement-failed")).toBe(false)
    expect(UnknownReason.isObtainable("not-applicable")).toBe(false)
    expect(UnknownReason.isObtainable("incomplete")).toBe(false)
  })

  test("🔴 only `incomplete` leaves a usable value, and it is a FLOOR", () => {
    // A caller that averages an `incomplete` beside finished ones is averaging floors with totals —
    // the same mistake as reading a 2-tick peak sample as a peak.
    expect(UnknownReason.isFloor("incomplete")).toBe(true)
    for (const reason of ["not-applicable", "not-measured", "measurement-failed"] as const)
      expect(UnknownReason.isFloor(reason)).toBe(false)
  })

  test("`not-applicable` is the one that stops the reader", () => {
    expect(UnknownReason.STOPS_THE_READER).toBe("not-applicable")
  })

  test("🔴 the two easiest to get backwards map the way the report argued", () => {
    // `unsampled` never ran; `discarded` ran and its answer was thrown away. Both are obtainable
    // quantities, so NEITHER may be `not-applicable`.
    expect(UnknownReason.FROM_EXISTING_SPELLING["unsampled"]).toBe("not-measured")
    expect(UnknownReason.FROM_EXISTING_SPELLING["discarded"]).toBe("measurement-failed")
  })

  test("🔴 the win32 enclosure is NOT-MEASURED, never not-applicable", () => {
    // The worked example the report calls the dangerous one: there is no probe IN THIS BUILD. Filing
    // it `not-applicable` would assert that a Windows host cannot be in a VM — false, and unasked.
    expect(UnknownReason.FROM_EXISTING_SPELLING["enclosure:win32"]).toBe("not-measured")
  })

  test("a refusal's null exit code IS not-applicable — the blank is correct", () => {
    // The one place the dangerous term is EARNED: no process ran, so no exit code can exist.
    expect(UnknownReason.FROM_EXISTING_SPELLING["exit_code:null-on-refusal"]).toBe("not-applicable")
  })

  test("every mapped spelling decodes as a real reason", () => {
    // Guards the mapping against a typo that would otherwise sit there looking like a decision.
    for (const [spelling, reason] of Object.entries(UnknownReason.FROM_EXISTING_SPELLING))
      expect(decode(reason), `${spelling} maps to something outside the vocabulary`).toBe(reason)
  })
})
