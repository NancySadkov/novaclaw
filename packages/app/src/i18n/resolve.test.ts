import { describe, expect, test } from "bun:test"
import * as i18n from "@solid-primitives/i18n"
import { dict as en } from "./en"
import {
  EXTRA_PLURAL_CATEGORIES,
  PLURAL_CATEGORIES,
  pluralCategory,
  pluralGroups,
  pluralKey,
  resolveTranslation,
} from "./resolve"

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Two invariants, both of which used to be asserted only in prose — and the prose was backwards.
//
//   A. A key the dictionaries do not hold resolves to the defined fallback and NEVER to the key id.
//   B. A counted phrase takes the form the LOCALE's grammar selects, not English's.
//
// The first test below is the control on invariant A's premise: it exercises the library directly,
// so if `@solid-primitives/i18n` ever starts echoing the path back, this file says so instead of
// `resolve.ts` silently guarding against a thing that no longer happens.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const ACTIVE = { greeting: "Hallo {{name}}", blank: "" }
const ENGLISH = { greeting: "Hello {{name}}", "only.in.english": "Only here", blank: "en blank" }

describe("the library's own miss behaviour — the premise this module is built on", () => {
  test("`translator()` returns undefined for an absent key, and does NOT return the key", () => {
    // Loosened deliberately: the point is what the LIBRARY returns for a key it does not hold, and
    // its own key type makes an absent key unspellable — which is the very thing being measured.
    const t = i18n.translator(() => ({ present: "here" }), i18n.resolveTemplate) as unknown as (
      key: string,
    ) => string | undefined
    expect(t("present")).toBe("here")
    const miss: unknown = t("absent.key")
    expect(miss).toBeUndefined()
    expect(miss).not.toBe("absent.key")
  })
})

describe("resolveTranslation", () => {
  test("a present key renders its copy, with params interpolated", () => {
    expect(resolveTranslation(ACTIVE, ENGLISH, "greeting", { name: "Ada" })).toBe("Hallo Ada")
  })

  test("a key the active locale lacks falls back to English", () => {
    expect(resolveTranslation(ACTIVE, ENGLISH, "only.in.english")).toBe("Only here")
  })

  test("🔴 a key NEITHER dictionary holds renders the fallback, never the raw key id", () => {
    const value = resolveTranslation(ACTIVE, ENGLISH, "settings.no.such.key")
    expect(value).toBe("")
    expect(value).not.toBe("settings.no.such.key")
    // The type says `string`; the point of this module is that the type is now true.
    expect(typeof value).toBe("string")
  })

  test("a deliberately empty translation is kept, not treated as a miss", () => {
    expect(resolveTranslation(ACTIVE, ENGLISH, "blank")).toBe("")
  })

  test("a non-string value in a locale falls through instead of reaching a renderer", () => {
    expect(resolveTranslation({ odd: 42 }, ENGLISH, "odd")).toBe("")
    expect(resolveTranslation({ odd: 42 }, { odd: "English copy" }, "odd")).toBe("English copy")
  })
})

describe("plural selection", () => {
  test("English still gets one/other", () => {
    expect(pluralCategory("en", 1)).toBe("one")
    expect(pluralCategory("en", 0)).toBe("other")
    expect(pluralCategory("en", 2)).toBe("other")
  })

  // The failure the hardcoded ternary cannot express: Russian has three forms, and `n !== 1` puts
  // 2 and 5 in the same bucket.
  test("Russian selects one/few/many, so 2 and 5 differ", () => {
    expect(pluralCategory("ru", 1)).toBe("one")
    expect(pluralCategory("ru", 2)).toBe("few")
    expect(pluralCategory("ru", 5)).toBe("many")
    expect(pluralCategory("ru", 21)).toBe("one")
  })

  test("Polish and Arabic agree with CLDR too", () => {
    expect(pluralCategory("pl", 2)).toBe("few")
    expect(pluralCategory("pl", 5)).toBe("many")
    expect(pluralCategory("ar", 0)).toBe("zero")
    expect(pluralCategory("ar", 2)).toBe("two")
    expect(pluralCategory("ar", 3)).toBe("few")
  })

  test("an unusable locale tag degrades to the two-form rule instead of throwing", () => {
    expect(pluralCategory("not a tag", 1)).toBe("one")
    expect(pluralCategory("not a tag", 7)).toBe("other")
  })

  test("every category `Intl` can select is one this module declares", () => {
    const seen = new Set<string>()
    for (const tag of ["en", "ru", "pl", "ar", "cy", "ja"])
      for (let n = 0; n <= 120; n++) seen.add(pluralCategory(tag, n))
    const declared: readonly string[] = PLURAL_CATEGORIES
    expect([...seen].filter((category) => !declared.includes(category))).toEqual([])
    expect(EXTRA_PLURAL_CATEGORIES.every((category) => declared.includes(category))).toBe(true)
  })
})

describe("pluralKey", () => {
  const RU_DICT = {
    "x.one": "{{count}} штука",
    "x.few": "{{count}} штуки",
    "x.many": "{{count}} штук",
    "x.other": "{{count}} штук",
  }
  const EN_ONLY = { "x.one": "{{count}} item", "x.other": "{{count}} items" }

  test("picks the locale's own form when the bundle carries it", () => {
    expect(pluralKey(RU_DICT, "ru", "x", 1)).toBe("x.one")
    expect(pluralKey(RU_DICT, "ru", "x", 2)).toBe("x.few")
    expect(pluralKey(RU_DICT, "ru", "x", 5)).toBe("x.many")
  })

  test("degrades to `.other` when the bundle has not landed that form yet", () => {
    // This is what lets a translator add `few` without also having to add `many` in the same commit.
    expect(pluralKey(EN_ONLY, "ru", "x", 2)).toBe("x.other")
    expect(pluralKey(EN_ONLY, "ru", "x", 1)).toBe("x.one")
  })

  test("0, 1 and 2 all resolve to a real string in English and in Russian", () => {
    for (const [tag, dict] of [
      ["en", EN_ONLY],
      ["ru", RU_DICT],
    ] as const)
      for (const n of [0, 1, 2, 5]) {
        const rendered = resolveTranslation(dict, EN_ONLY, pluralKey(dict, tag, "x", n), { count: n })
        expect(rendered, `${tag} ${n}`).toContain(String(n))
        expect(rendered, `${tag} ${n}`).not.toContain("{{")
      }
    // The whole point, stated as an assertion: Russian 2 and 5 do NOT read the same.
    const two = resolveTranslation(RU_DICT, EN_ONLY, pluralKey(RU_DICT, "ru", "x", 2), { count: 2 })
    const five = resolveTranslation(RU_DICT, EN_ONLY, pluralKey(RU_DICT, "ru", "x", 5), { count: 5 })
    expect(two.replace("2", "")).not.toBe(five.replace("5", ""))
  })
})

describe("pluralGroups", () => {
  test("a base needs BOTH forms — `.other` alone is not a plural group", () => {
    expect([...pluralGroups({ "a.one": "", "a.other": "", "b.other": "", "c.one": "" })]).toEqual(["a"])
  })

  test("derived from `en`, and `context.breakdown` is correctly not one", () => {
    const groups = pluralGroups(en)
    expect(groups.size).toBeGreaterThan(0)
    expect(groups.has("context.breakdown")).toBe(false)
    expect(groups.has("session.revertDock.summary")).toBe(true)
    // Guards the guard: every group it found really does have both forms in `en`.
    const record = en as Record<string, unknown>
    for (const group of groups) {
      expect(typeof record[`${group}.one`], group).toBe("string")
      expect(typeof record[`${group}.other`], group).toBe("string")
    }
  })
})
