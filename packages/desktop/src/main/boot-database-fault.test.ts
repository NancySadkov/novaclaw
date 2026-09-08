import { describe, expect, test } from "bun:test"
import { Cause } from "effect"

import { describeSidecarFailure } from "./boot"

/**
 * 🔴 NC-REL-024 — the database's own classification was thrown away at the dialog.
 *
 * `database.ts` distinguishes unreadable / corrupt / foreign / migration faults, writes a
 * non-developer `summary` and a concrete `repair` list, and packages both into the defect ON PURPOSE.
 * Its comment names this function as the intended consumer — *"so a caller that catches the cause
 * (the desktop's `describeSidecarFailure` shape, a future Recovery surface) gets the classification
 * rather than a re-parse of an English sentence."* Nothing ever caught it, so a user whose database
 * came from a newer NovaClaw got a pretty-printed Effect cause in an error box while the sentence
 * explaining it sat unused in the payload.
 *
 * A/B: remove the `isDatabaseUnusable` branch and the summary becomes the generic
 * "could not start" wording with a stack trace for detail.
 */
const unusable = (summary: string, repair: readonly string[]) =>
  Cause.die({
    _tag: "DatabaseUnusable",
    message: summary,
    fault: { kind: "foreign", path: "C:/data/novaclaw.db", summary, repair, detail: "pretty cause here" },
  })

describe("a sidecar that refused because the database is unusable", () => {
  test("🔴 reports the database's OWN summary, not a pretty-printed cause", () => {
    const failure = describeSidecarFailure(unusable("This database belongs to a newer NovaClaw.", []), "health")
    expect(failure.summary).toBe("This database belongs to a newer NovaClaw.")
  })

  test("🔴 carries the repair steps — the actionable half the Fault exists for", () => {
    const failure = describeSidecarFailure(
      unusable("This database belongs to a newer NovaClaw.", ["Update NovaClaw.", "Or point it elsewhere."]),
      "health",
    )
    expect(failure.detail).toContain("Update NovaClaw.")
    expect(failure.detail).toContain("Or point it elsewhere.")
  })

  test("it is an `error`, never a `timeout` — the sidecar answered, it refused", () => {
    // Reporting a refusal as a timeout is the "fault described falsely" this function's own comment
    // was written against.
    expect(describeSidecarFailure(unusable("x", []), "health").kind).toBe("error")
  })

  test("an ordinary failure is untouched", () => {
    // The control: without it, the branch could swallow every cause and still pass the tests above.
    const failure = describeSidecarFailure(Cause.die(new Error("something else")), "health")
    expect(failure.summary).not.toBe("x")
    expect(failure.code).toContain("health")
  })
})
