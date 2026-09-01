import { describe, expect, test } from "bun:test"
import { KbAbsorbEval } from "../script/absorb-eval"

/**
 * 🔴 The defect this instrument replaces: a HAND-LISTED scaffolding set reported "99% concrete", and a
 * later run gained `racial hit dice`, `grapple check` and `lifting and carrying limit` — all field
 * labels, all scored concrete, purely because they were not on the list. Fixing a rule before an
 * experiment stops scoring-to-flatter; it does nothing about coverage.
 */
const STAT_BLOCK = (name: string) => `
${name}
Medium Monstrous Humanoid
Hit Dice:
5d8+15
Initiative:
+3
Armor Class:
18
Special Qualities:
Darkvision 60 ft.
Challenge Rating:
4
Treasure:
Standard
Advancement:
By character class
Abilities:
Str 11, Dex 17, Con 17, Int 10, Wis 10, Cha 10
`

const DOC =
  [1, 2, 3, 4, 5, 6].map((n) => STAT_BLOCK(`Creature${n}`)).join("\n") + "\nCause Avalanche (Su):\nOnce per day.\n"

describe("KbAbsorbEval.deriveScaffolding", () => {
  test("field labels are found by REPETITION, without being listed", () => {
    const scaffolding = KbAbsorbEval.deriveScaffolding(DOC)
    for (const label of ["hit dice", "challenge rating", "treasure", "advancement", "special qualities"])
      expect(scaffolding.has(label), `${label} should be scaffolding`).toBe(true)
  })

  test("a one-off named ability is NOT scaffolding, even though it is also a colon line", () => {
    // ⚠️ The discipline: a label repeated across records is structure; a one-off is content. Too low a
    // threshold scores real abilities as scaffolding, which would flatter a prompt that dropped them.
    expect(KbAbsorbEval.deriveScaffolding(DOC).has("cause avalanche (su)")).toBe(false)
  })

  test("ability-score names are derived too, not hard-coded as a d20 assumption", () => {
    const scaffolding = KbAbsorbEval.deriveScaffolding(DOC)
    for (const name of ["str", "dex", "con"]) expect(scaffolding.has(name), name).toBe(true)
  })

  test("an empty document yields an empty set rather than a default list", () => {
    // A scorer that falls back to a built-in list would silently resume measuring what its author
    // remembered — the exact defect this replaces.
    expect(KbAbsorbEval.deriveScaffolding("").size).toBe(0)
  })
})

describe("KbAbsorbEval.canonical", () => {
  test("collapses the variant shapes actually observed", () => {
    const c = KbAbsorbEval.canonical
    expect(c("Armands")).toBe(c("Armand"))
    expect(c("[ARMAND]")).toBe(c("Armand"))
    expect(c("Darkvision 60 ft.")).toBe(c("Darkvision 120 ft."))
    expect(c("Weapon Focus (claws)")).toBe(c("Weapon Focus"))
  })

  test("does NOT collapse different things that merely look alike", () => {
    const c = KbAbsorbEval.canonical
    expect(c("Chaos")).toBe("chaos") // not "chao" — trailing-s stripping must respect `ss`
    expect(c("Mercury")).not.toBe(c("Mercury Project"))
  })
})

describe("KbAbsorbEval.score", () => {
  test("counts surplus ids as the cost of fragmentation", () => {
    const scaffolding = KbAbsorbEval.deriveScaffolding(DOC)
    const result = KbAbsorbEval.score(["Armand", "Armands", "Darkvision 60 ft.", "Treasure"], scaffolding)
    expect(result.surplusIds).toBe(1) // Armand/Armands are one thing
    expect(result.scaffolding).toEqual(["Treasure"])
    expect(result.concrete).toHaveLength(3)
  })
})
