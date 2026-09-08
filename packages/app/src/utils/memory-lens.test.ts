import { describe, expect, test } from "bun:test"
import { applyLens, defaultLens, forgottenIDs, LENSES, lensAdmits, lensByID, statusBadge } from "./memory-lens"

const rows = [
  { id: "a", status: "active" },
  { id: "b", status: "needs_review" },
  { id: "c", status: "superseded" },
  { id: "d", status: "archived" },
]

describe("lensByID", () => {
  test("an unknown or absent id falls back to the default rather than showing nothing", () => {
    expect(lensByID(undefined).id).toBe(defaultLens())
    expect(lensByID("whatever").id).toBe(defaultLens())
    expect(lensByID("history").id).toBe("history")
  })

  test("the default is Current — the app opens on what it treats as true", () => {
    expect(defaultLens()).toBe("current")
  })
})

describe("lensAdmits", () => {
  test("🔴 Current includes needs_review, because RECALL does", () => {
    // Dropping a flagged-but-uncontradicted claim from `Current` would make the lens disagree with
    // what Nova is actually working from — a renamed file would read as amnesia.
    const current = lensByID("current")
    expect(lensAdmits(current, "active")).toBe(true)
    expect(lensAdmits(current, "needs_review")).toBe(true)
    expect(lensAdmits(current, "superseded")).toBe(false)
    expect(lensAdmits(current, "archived")).toBe(false)
  })

  test("History admits everything, including statuses this build has never heard of", () => {
    const history = lensByID("history")
    for (const status of ["active", "superseded", "archived", "needs_review", "invented_later"])
      expect(lensAdmits(history, status)).toBe(true)
  })

  test("⚠️ a row with NO status reads as active — a filter may narrow, never erase", () => {
    // An older instance predates the column. Dropping its rows would empty the whole cabinet behind
    // a lens, which is the empty-cabinet lie wearing a filter.
    expect(lensAdmits(lensByID("current"), undefined)).toBe(true)
    expect(lensAdmits(lensByID("current"), "")).toBe(true)
  })

  test("Needs review is exactly the flagged ones", () => {
    const lens = lensByID("needs-review")
    expect(rows.filter((row) => lensAdmits(lens, row.status)).map((row) => row.id)).toEqual(["b"])
  })
})

describe("applyLens", () => {
  test("a measured lens filters and claims nothing else", () => {
    const result = applyLens(lensByID("current"), rows)
    expect(result.rows.map((row) => row.id)).toEqual(["a", "b"])
    expect(result.unmeasured).toBeUndefined()
  })

  test("🔴 an UNMEASURED lens reports that it cannot answer, rather than answering 'none'", () => {
    // The branch an instance without the P3 usage routes falls into. An empty list under `Never
    // used` would be a confident claim about a measurement nobody has taken.
    const result = applyLens({ ...lensByID("never-used"), measured: false }, rows)
    expect(result.unmeasured).toBeTruthy()
    expect(result.unmeasured).toContain("not recording")
  })

  test("🔴 every lens whose source is not `list` names a DISTINCT route, and none is left unreachable", () => {
    // The three ledger lenses each read their own endpoint, and each of those endpoints spent a
    // while answering correctly with nobody calling it. A lens whose `source` collided with
    // another's would put one of them back in that state while the tab strip still showed it.
    const ledgerLenses = LENSES.filter((lens) => lens.source !== "list")
    expect(ledgerLenses.map((lens) => lens.source).toSorted()).toEqual(["corrections", "never-used", "useful"])
    for (const lens of ledgerLenses) expect(lens.statuses).toBeUndefined()
  })

  test("⚠️ Never used reads its OWN route — it is a fact about the ledger, not about the claim", () => {
    // A status set can never express "nothing has ever recalled this", so the lens names the
    // endpoint instead of leaving the list to infer it from the id.
    expect(lensByID("never-used").source).toBe("never-used")
    expect(lensByID("never-used").statuses).toBeUndefined()
    for (const id of ["current", "needs-review", "history"]) expect(lensByID(id).source).toBe("list")
  })

  test("every lens in the row of tabs is reachable and carries a one-line hint", () => {
    expect(LENSES.map((lens) => lens.id)).toEqual([
      "current",
      "needs-review",
      "never-used",
      "useful",
      "corrections",
      "history",
    ])
    for (const lens of LENSES) {
      expect(lens.hint.length).toBeGreaterThan(0)
      expect(lens.hint.length).toBeLessThan(90)
    }
  })
})

describe("forgottenIDs / includeInvalid", () => {
  test("🔴 only History asks for forgotten memories — measured: a status set can never reach them", () => {
    // `POST /memory/invalidate` closes a row's validity bitemporally and leaves `status` reading
    // `active`. Verified on a live instance 2026-08-25: the row vanished from `statuses=` reads AND
    // from an unfiltered one, and came back only with `includeInvalid=1`.
    expect(lensByID("history").includeInvalid).toBe(true)
    for (const id of ["current", "needs-review", "never-used", "useful"]) expect(lensByID(id).includeInvalid).toBe(false)
    // ⚠️ `corrections` is the exception, and deliberately: its groups are built from claim
    // IDENTITIES and a superseded claim is exactly what they are about, so filtering retired rows
    // out from under them would empty the lens of the thing it exists to show.
    expect(lensByID("corrections").includeInvalid).toBe(true)
  })

  test("the forgotten rows are the DIFFERENCE between the two reads", () => {
    const all = [{ id: "a" }, { id: "b" }, { id: "c" }]
    const stillValid = [{ id: "a" }, { id: "c" }]
    expect([...forgottenIDs(all, stillValid)]).toEqual(["b"])
    expect(forgottenIDs(all, all).size).toBe(0)
  })

  test("a failed second read marks NOTHING rather than marking everything forgotten", () => {
    // The caller falls back to `valid = rows` when the second fetch rejects; the diff must then be
    // empty. Marking every row "Forgotten" because a request failed would be a far louder lie than
    // marking none.
    expect(forgottenIDs([{ id: "a" }], [{ id: "a" }]).size).toBe(0)
  })
})

describe("statusBadge", () => {
  test("⚠️ an ORDINARY status gets no badge — a tag on every row hides the rare one", () => {
    expect(statusBadge("active")).toBeUndefined()
    expect(statusBadge(undefined)).toBeUndefined()
  })

  test("the words are the user's, not the schema's", () => {
    expect(statusBadge("superseded")?.label).toBe("Corrected")
    expect(statusBadge("needs_review")?.label).toBe("Needs review")
    expect(statusBadge("archived")?.label).toBe("Archived")
  })

  test("every badge explains itself on demand", () => {
    for (const status of ["superseded", "needs_review", "archived"])
      expect(statusBadge(status)!.title.length).toBeGreaterThan(20)
  })
})
