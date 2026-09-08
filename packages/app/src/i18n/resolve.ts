import * as i18n from "@solid-primitives/i18n"

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// How a key becomes text — and the two things the library does that a call site must never have to
// know about.
//
// 1. A MISS RETURNS `undefined`, NOT THE KEY. `@solid-primitives/i18n@2.2.1`'s `translator()` reads
//    `dict()?.[path]`, switches on `typeof value`, and its `default:` arm returns `value` — so a key
//    the dictionary does not hold comes back as `undefined`. It never echoes the path. Solid renders
//    `undefined` as nothing, so the miss reaches a user as a BLANK label rather than as a visible
//    fault: `notes/reports/decisions-v0.2.0.md` ruling 2's *an unavailable subsystem names itself
//    instead of rendering empty*, inverted. And `Translator` promises `string`, so that promise was
//    a cast standing over a lie.
//
//    ⚠️ Comments at four sites in this tree used to state the OPPOSITE — that a miss renders
//    `some.raw.key` at the user — and one call site built a `if (value === key) return ""` guard on
//    it that could never fire. Prose asserting a protection that does not exist is worse than no
//    prose, because the next reader stops checking. Both halves are closed here instead:
//
//      · a key the active locale lacks falls back to ENGLISH, as a property of THIS function rather
//        than of how the dictionaries happen to be merged in `context/language.tsx`;
//      · a key neither dictionary holds resolves to `""` — never `undefined`, and never the key id,
//        which is the other way a broken lookup reaches a user's screen.
//
//    So a call site CANNOT detect a miss by comparing the result to the key, and does not need to:
//    test the result for BLANKNESS, the way `apps/app-label.ts` already does.
//
// 2. ENGLISH PLURAL RULES ARE NOT EVERY LANGUAGE'S. `n === 1 ? "x.one" : "x.other"` at a call site
//    bakes a two-form rule into code no translator can reach. Russian, Ukrainian, Polish and Bosnian
//    need one/few/many; Arabic needs six categories. `pluralKey` below picks the form from
//    `Intl.PluralRules` for the locale actually in force, so the grammar lives in the locale data.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A dictionary as this module reads it. Deliberately `object` rather than `Record<string, unknown>`:
 * the merged `Dictionary` in `context/language.tsx` is a mapped intersection, and this way it needs
 * no cast to be passed in. The lookup casts once, here, where the miss is handled.
 */
export type Dict = object

const read = (dict: Dict, key: string): unknown => (dict as Record<string, unknown>)[key]

/**
 * Resolve `key` against the active dictionary, then English, then nothing — and always to a string.
 * See the two notes at the top of this file for why neither `undefined` nor the key id may escape.
 */
export function resolveTranslation(
  active: Dict,
  english: Dict,
  key: string,
  params?: Record<string, string | number | boolean>,
): string {
  // Tested for STRINGNESS, not for `undefined`: a locale that somehow holds a non-string under this
  // key (parity rule 3 forbids it, and a type cannot see a bundle authored elsewhere) must fall to
  // English rather than hand a renderer something that is not text.
  const localized = read(active, key)
  const value = typeof localized === "string" ? localized : read(english, key)
  if (typeof value !== "string") return ""
  return params ? i18n.resolveTemplate(value, params) : value
}

/** The CLDR plural categories `Intl.PluralRules` can select. */
export const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"] as const
export type PluralCategory = (typeof PLURAL_CATEGORIES)[number]

/**
 * The categories a language may declare BEYOND the two English has.
 *
 * `en.ts` carries `.one` and `.other` for every plural group because those are English's own
 * categories. A locale that needs more adds them to its own bundle, and `parity.test.ts`'s
 * no-key-absent-from-`en` rule exempts exactly these — without that exemption the ratchet that keeps
 * the bundles honest is what forbids a correct Slavic or Arabic translation.
 */
export const EXTRA_PLURAL_CATEGORIES = ["zero", "two", "few", "many"] as const

/**
 * The plural groups a dictionary declares: every base carrying BOTH `.one` and `.other`.
 *
 * Derived, never hand-listed — a hand-kept subset of a key set goes stale the first time the key set
 * moves. `context.breakdown.other` has no `.one` and is correctly not a plural group.
 */
export function pluralGroups(dict: Dict): Set<string> {
  const out = new Set<string>()
  const record = dict as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!key.endsWith(".other")) continue
    const group = key.slice(0, -".other".length)
    if (`${group}.one` in record) out.add(group)
  }
  return out
}

const rules = new Map<string, Intl.PluralRules>()

/**
 * The category `count` takes in `intl`. Falls back to the English two-form rule if the runtime has
 * no `Intl.PluralRules` for that tag — a wrong plural is a bad label, never a crash.
 */
export function pluralCategory(intl: string, count: number): PluralCategory {
  try {
    let rule = rules.get(intl)
    if (!rule) {
      rule = new Intl.PluralRules(intl)
      rules.set(intl, rule)
    }
    return rule.select(count) as PluralCategory
  } catch {
    return count === 1 ? "one" : "other"
  }
}

/**
 * The key `group` resolves to for `count` in `intl`.
 *
 * Degrades to `<group>.other` when the dictionary in force has no entry for the selected category —
 * which is the normal case, since `en` only ships `one`/`other` and a locale adds its extra forms
 * one at a time. That degrade is what lets a translator land `few` without also landing `many`.
 */
export function pluralKey(dict: Dict, intl: string, group: string, count: number): string {
  const key = `${group}.${pluralCategory(intl, count)}`
  return key in (dict as Record<string, unknown>) ? key : `${group}.other`
}
