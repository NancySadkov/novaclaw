import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { stripComments } from "./lib/source-scan"

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

const sources = fs
  .readdirSync(SRC)
  .filter((name) => name.endsWith(".ts") && !name.includes(".test."))
  .map((name) => ({ name, code: stripComments(fs.readFileSync(path.join(SRC, name), "utf8")) }))

describe("the community settles nothing", () => {
  test("🔴 no module reaches for payment machinery", () => {
    // Names a payment integration would have to use. Deliberately broad: the point is to fail when
    // somebody starts, not to enumerate one library.
    const machinery = /\b(invoice|lnurl|payInvoice|sendPayment|makePayment|wallet|balance)\b/i

    /**
     * 🔴 CASE-SENSITIVE, and separate for that reason alone. This alternative used to live in the
     * pattern above as `settle[A-Z]`, where the `/i` flag quietly nullified its own anchor: `[A-Z]`
     * under `/i` matches any letter, so it flagged the ordinary word **`settled`**. It fired on
     * `dht.ts`, whose `defaultRun` uses `let settled = false` as a promise guard — code with no
     * relationship to payment at all.
     *
     * ⚠️ A guard that fires on normal code is not a guard: the only ways out are to rename innocent
     * variables around it or to stop believing it, and both end with it deleted. The camelCase intent
     * (`settleInvoice`, `settleUp`) is real, so it is kept — expressed so it means what it says.
     */
    const settlementCall = /\bsettle[A-Z]/

    const offenders = sources
      .filter((file) => machinery.test(file.code) || settlementCall.test(file.code))
      .map((file) => file.name)
    expect(offenders, "a community module reached for payment machinery").toEqual([])
  })

  test("🔴 the guard still CATCHES what it is for — and no longer catches what it is not", () => {
    /**
     * ⚠️ Both halves, because this test exists to stop a fix from becoming a hole. Deleting the
     * `settle` rule would have made the suite green too, and nothing would have noticed until
     * somebody landed `settleInvoice`.
     */
    const machinery = /\b(invoice|lnurl|payInvoice|sendPayment|makePayment|wallet|balance)\b/i
    const settlementCall = /\bsettle[A-Z]/
    const flags = (code: string) => machinery.test(code) || settlementCall.test(code)

    expect(flags("const x = settleInvoice(peer)"), "settleInvoice must still be caught").toBe(true)
    expect(flags("await wallet.pay(1)"), "wallet must still be caught").toBe(true)
    expect(flags("if (lnurl !== undefined) return"), "lnurl must still be caught").toBe(true)
    expect(flags("let settled = false"), "an ordinary `settled` flag is not payment machinery").toBe(false)
    expect(flags("promise.settled ?? resolve()"), "`settled` stays innocent in any casing").toBe(false)
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
