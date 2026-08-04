import { describe, expect, test } from "bun:test"
import { SessionInput } from "./input"
import { isSteerText, stripSteerProvenance } from "./steer-provenance"

describe("applySteerProvenance (1N/A1)", () => {
  test("prepends the provenance prefix to a bare nudge", () => {
    const out = SessionInput.applySteerProvenance("Stop repeating that call.")
    expect(out.startsWith(SessionInput.STEER_PROVENANCE_PREFIX)).toBe(true)
    expect(out).toContain("Stop repeating that call.")
  })

  test("does not double-prefix an already-tagged message", () => {
    const once = SessionInput.applySteerProvenance("do X")
    const twice = SessionInput.applySteerProvenance(once)
    expect(twice).toBe(once)
  })

  test("the prefix names the note as an automated check, not the user", () => {
    expect(SessionInput.STEER_PROVENANCE_PREFIX.toLowerCase()).toContain("automated")
    expect(SessionInput.STEER_PROVENANCE_PREFIX.toLowerCase()).toContain("not a message from your user")
  })
})

describe("steer detection (the renderer's fold marker)", () => {
  test("isSteerText detects a tagged steer and nothing else", () => {
    expect(isSteerText(SessionInput.applySteerProvenance("act now"))).toBe(true)
    expect(isSteerText("act now")).toBe(false)
    expect(isSteerText("")).toBe(false)
  })

  test("stripSteerProvenance recovers the bare body and passes plain text through", () => {
    expect(stripSteerProvenance(SessionInput.applySteerProvenance("act now"))).toBe("act now")
    expect(stripSteerProvenance("hello")).toBe("hello")
  })
})
