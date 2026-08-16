import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

/**
 * 🔴 The community moves no money, asserted mechanically.
 *
 * `notes/spec/honesty-ledger.md` §1(e) says settlement stays between people, and §1(j) leans on that
 * far harder than it looks: an information auction is enforceable *because the seller's standing is
 * the only collateral*. If this software ever settled, that argument would quietly stop being true —
 * the ledger would be adjudicating trades rather than pricing trust, and the whole reason a
 * stochastic currency can carry a deal without escrow would be gone.
 *
 * ⚠️ Verified by hand once, which is why this exists. A hand-run grep proves a fact about one
 * afternoon; this proves it about every afternoon after.
 */

const SRC = path.resolve(import.meta.dir, "..", "src", "community")

/**
 * ⚠️ Comments FIRST — the standing rule that a regex over raw source counts PROSE. This subject is
 * discussed by name throughout these modules ("this software never pays it", "a payment address
 * lands on somebody's clipboard"), so an unstripped scan would fail on the very comments that
 * promise the behaviour being checked.
 */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")

const sources = fs
  .readdirSync(SRC)
  .filter((name) => name.endsWith(".ts") && !name.includes(".test."))
  .map((name) => ({ name, code: stripComments(fs.readFileSync(path.join(SRC, name), "utf8")) }))

describe("the community settles nothing", () => {
  test("🔴 no module reaches for payment machinery", () => {
    // Names a payment integration would have to use. Deliberately broad: the point is to fail when
    // somebody starts, not to enumerate one library.
    const machinery = /\b(invoice|lnurl|payInvoice|sendPayment|makePayment|settle[A-Z]|wallet|balance)\b/i
    const offenders = sources.filter((file) => machinery.test(file.code)).map((file) => file.name)
    expect(offenders, "a community module reached for payment machinery").toEqual([])
  })

  test("⚠️ and the control: the guard can still SEE this directory", () => {
    // A scan that matches nothing has not proved absence — it may simply be looking nowhere. `payTo`
    // is declared, validated, signed and stored here, so it must be found.
    const seen = sources.filter((file) => /payTo/.test(file.code)).map((file) => file.name)
    expect(seen.length, "the scan found no payTo at all — it is looking at the wrong place").toBeGreaterThan(0)
    expect(sources.length).toBeGreaterThan(5)
  })

  test("⚠️ a payment address is only ever carried, never acted on", () => {
    // Every use in `offer.ts`: declared on the type, length-checked, pushed into the signed bytes,
    // stored, read back. None of them does anything WITH it.
    const offer = sources.find((file) => file.name === "offer.ts")
    expect(offer).toBeDefined()
    expect(/payTo/.test(offer!.code)).toBe(true)
    expect(/fetch\([^)]*payTo|await[^\n]*payTo\s*\(/.test(offer!.code)).toBe(false)
  })
})
