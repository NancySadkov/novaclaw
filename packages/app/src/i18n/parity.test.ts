import { describe, expect, test } from "bun:test"
import { dict as en } from "./en"
import { dict as ar } from "./ar"
import { dict as br } from "./br"
import { dict as bs } from "./bs"
import { dict as da } from "./da"
import { dict as de } from "./de"
import { dict as es } from "./es"
import { dict as fr } from "./fr"
import { dict as ja } from "./ja"
import { dict as ko } from "./ko"
import { dict as no } from "./no"
import { dict as pl } from "./pl"
import { dict as ru } from "./ru"
import { dict as uk } from "./uk"
import { dict as th } from "./th"
import { dict as zh } from "./zh"
import { dict as zht } from "./zht"
import { dict as tr } from "./tr"
import { dict as uiEn } from "@novaclaw/ui/i18n/en"
import { dict as uiAr } from "@novaclaw/ui/i18n/ar"
import { dict as uiBr } from "@novaclaw/ui/i18n/br"
import { dict as uiBs } from "@novaclaw/ui/i18n/bs"
import { dict as uiDa } from "@novaclaw/ui/i18n/da"
import { dict as uiDe } from "@novaclaw/ui/i18n/de"
import { dict as uiEs } from "@novaclaw/ui/i18n/es"
import { dict as uiFr } from "@novaclaw/ui/i18n/fr"
import { dict as uiJa } from "@novaclaw/ui/i18n/ja"
import { dict as uiKo } from "@novaclaw/ui/i18n/ko"
import { dict as uiNo } from "@novaclaw/ui/i18n/no"
import { dict as uiPl } from "@novaclaw/ui/i18n/pl"
import { dict as uiRu } from "@novaclaw/ui/i18n/ru"
import { dict as uiUk } from "@novaclaw/ui/i18n/uk"
import { dict as uiTh } from "@novaclaw/ui/i18n/th"
import { dict as uiZh } from "@novaclaw/ui/i18n/zh"
import { dict as uiZht } from "@novaclaw/ui/i18n/zht"
import { dict as uiTr } from "@novaclaw/ui/i18n/tr"

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The i18n parity ratchet.
//
// 19 locales ship and, until this file, nothing could tell whether they agreed. The non-`en` bundles
// are `satisfies Partial<Record<keyof typeof en, string>>`, which is the RIGHT shape — a partial
// translation is legal and the runtime falls back to `en` key-by-key (`context/language.tsx` spreads
// `en` under every locale). This test re-checks AT RUNTIME everything that clause checks, plus two
// things it cannot (rules 2 and 4 below).
//
// ⚠️ CORRECTION (2026-07-29): this header used to justify the duplication with "a `satisfies` clause
// only bites when someone runs `tsgo`, and this box cannot." Both halves were wrong. `cd packages/app
// && bun run typecheck` runs `tsgo -b` here in ~0.3 s warm, and since 2026-07-29 the day-to-day gate
// (`bun run test`) has a typecheck phase, so the `satisfies` clauses DO bite on every run. The
// duplication is still worth keeping — a runtime check reports every offending key at once instead of
// stopping at the first type error, and rules 2 and 4 have no type equivalent — but it is belt and
// braces now, not the only belt.
//
// THE PARITY RULE, stated so it can be argued with:
//
//   1. EXTRA  — a key in a locale that `en` does not have          → FAIL, by name.
//      Nothing renders it (`t()` is typed to `en`'s keys) and nobody will ever find it to delete.
//      This is the half `Partial<Record<Keys, string>>` catches.
//   2. MISSING — a key in `en` that a locale does not have         → COUNTED, never a failure.
//      That is what `Partial` is FOR. A gate that fails on the first untranslated string makes
//      translating impossible; the counts below are the translation backlog, printed, not enforced.
//   3. SHAPE  — a value that is not a string on either side        → FAIL, by name.
//      `en` is all strings; an object or function in a locale is a crash waiting for one user in
//      one language. The other half of what the `satisfies` clause catches.
//   4. PLACEHOLDERS — `{{name}}` sets must agree                   → FAIL, with the diff.
//      Compared per SIBLING GROUP (the key minus its last dot-segment) and restricted to keys the
//      locale actually has. Both restrictions are load-bearing, see below. `tsgo` cannot see this
//      at all — it is pure string content.
//
// Why placeholders are compared per GROUP and not per KEY. `provider.connect.oauth.code.visit.*` is
// a prefix/link/suffix triple rendered as one sentence with one param object, and `tr` correctly
// moves `{{provider}}` from the suffix into the prefix because Turkish word order puts it there.
// Per-key equality calls that shipped-correct translation a bug; per-group equality sees the group
// is unchanged and reports it as a MOVE instead. The relaxation is real and bounded: two unrelated
// keys under one group prefix could swap a placeholder undetected. That trade buys translators the
// word-order freedom the prefix/suffix idiom exists to give them.
//
// Why restricted to SHARED keys. A locale that has translated `.one` but not `.many` would otherwise
// look like it "lost" the `{{count}}` that only `.many` carries — i.e. rule 4 would smuggle in a
// missing-key failure and break rule 2. Comparing only keys both sides have keeps them independent.
//
// ⚠️ INDEPENDENCE FROM THE 321-DEAD-KEY PRUNE (a separate roadmap item — do not do it here). No rule
// above asks whether a key is USED; every rule compares `en` against a locale. A dead key lives in
// `en`, so its translations are legal under rule 1 and its absence is only a count under rule 2 —
// the two items cannot collide. What this test DOES do is make the prune honest: deleting a dead key
// from `en` alone turns every translation of it into an EXTRA key and fails here by name, so the
// prune has to sweep all 19 bundles. That is a feature; it is also a warning to whoever picks it up.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

type Dict = Record<string, unknown>

const APP_LOCALES: ReadonlyArray<readonly [string, Dict]> = [
  ["ar", ar],
  ["br", br],
  ["bs", bs],
  ["da", da],
  ["de", de],
  ["es", es],
  ["fr", fr],
  ["ja", ja],
  ["ko", ko],
  ["no", no],
  ["pl", pl],
  ["ru", ru],
  ["th", th],
  ["tr", tr],
  ["uk", uk],
  ["zh", zh],
  ["zht", zht],
]

const UI_LOCALES: ReadonlyArray<readonly [string, Dict]> = [
  ["ar", uiAr],
  ["br", uiBr],
  ["bs", uiBs],
  ["da", uiDa],
  ["de", uiDe],
  ["es", uiEs],
  ["fr", uiFr],
  ["ja", uiJa],
  ["ko", uiKo],
  ["no", uiNo],
  ["pl", uiPl],
  ["ru", uiRu],
  ["th", uiTh],
  ["tr", uiTr],
  ["uk", uiUk],
  ["zh", uiZh],
  ["zht", uiZht],
]

// Both bundle families the product merges at runtime. `ui` is a different package and a different
// `en`; it is covered here because `language.tsx` spreads the two into ONE dictionary, so a drift in
// either reaches the same screen. (This test cannot fix `packages/ui` — it can only refuse to let it
// rot silently. It is green over both families today.)
const FAMILIES: ReadonlyArray<readonly [string, Dict, ReadonlyArray<readonly [string, Dict]>]> = [
  ["app", en, APP_LOCALES],
  ["ui", uiEn, UI_LOCALES],
]

/** `{{name}}` / `{{ name }}` — the template syntax `i18n.resolveTemplate` resolves. */
function placeholders(value: string): Set<string> {
  const out = new Set<string>()
  for (const match of value.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) out.add(match[1]!)
  return out
}

/** The sibling group a key belongs to: everything before its last dot (a dotless key is its own group). */
function siblingGroup(key: string): string {
  const cut = key.lastIndexOf(".")
  return cut === -1 ? key : key.slice(0, cut)
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((x) => b.has(x))
const show = (set: ReadonlySet<string>) => (set.size === 0 ? "none" : [...set].sort().join(","))

interface Report {
  readonly extra: string[]
  readonly shape: string[]
  readonly placeholder: string[]
  readonly missing: number
  readonly translated: number
  readonly moves: number
}

function compare(base: Dict, locale: Dict): Report {
  const baseKeys = Object.keys(base)
  const localeKeys = Object.keys(locale)
  const extra: string[] = []
  const shape: string[] = []
  const placeholder: string[] = []

  for (const key of localeKeys) {
    if (!(key in base)) extra.push(key)
    else if (typeof locale[key] !== "string") shape.push(`${key} is ${typeof locale[key]}, expected string`)
  }

  // Rule 4, over shared keys only, grouped by sibling prefix.
  const shared = localeKeys.filter(
    (key) => key in base && typeof locale[key] === "string" && typeof base[key] === "string",
  )
  const groups = new Map<string, string[]>()
  for (const key of shared) {
    const group = siblingGroup(key)
    const bucket = groups.get(group)
    if (bucket) bucket.push(key)
    else groups.set(group, [key])
  }
  let moves = 0
  for (const [group, keys] of groups) {
    const baseSet = new Set<string>()
    const localeSet = new Set<string>()
    for (const key of keys) {
      for (const name of placeholders(base[key] as string)) baseSet.add(name)
      for (const name of placeholders(locale[key] as string)) localeSet.add(name)
    }
    if (!sameSet(baseSet, localeSet))
      placeholder.push(`${group}.* — en {{${show(baseSet)}}} vs locale {{${show(localeSet)}}}`)
    else if (keys.some((key) => !sameSet(placeholders(base[key] as string), placeholders(locale[key] as string))))
      moves++
  }

  return {
    extra,
    shape,
    placeholder,
    missing: baseKeys.filter((key) => !(key in locale)).length,
    translated: shared.length,
    moves,
  }
}

describe("i18n parity", () => {
  for (const [family, base, locales] of FAMILIES) {
    describe(family, () => {
      test("`en` itself is a flat map of strings", () => {
        const bad = Object.entries(base)
          .filter(([, value]) => typeof value !== "string")
          .map(([key]) => key)
        expect(bad).toEqual([])
      })

      for (const [name, dict] of locales) {
        // Rules 1 and 3 — the two halves `satisfies Partial<Record<Keys, string>>` also catches. Kept
        // at runtime because this reports EVERY offending key at once; a type error stops at the first.
        test(`${name}: no key absent from en, no non-string value`, () => {
          const report = compare(base, dict)
          expect({ extra: report.extra, shape: report.shape }).toEqual({ extra: [], shape: [] })
        })

        // Rule 4 — beyond what any type can see.
        test(`${name}: interpolation placeholders agree with en`, () => {
          expect(compare(base, dict).placeholder).toEqual([])
        })
      }

      // Rule 2 — a REPORT, not a gate. It must never fail, or partial translation becomes impossible.
      test("translation coverage (report only — missing keys are legal)", () => {
        const total = Object.keys(base).length
        const lines = locales.map(([name, dict]) => {
          const report = compare(base, dict)
          const pct = ((report.translated / total) * 100).toFixed(1)
          const moved = report.moves > 0 ? `  moved=${report.moves}` : ""
          return `  ${name.padEnd(4)} ${String(report.translated).padStart(5)}/${total}  ${pct.padStart(5)}%  missing=${String(report.missing).padStart(5)}${moved}`
        })
        console.log(`\ni18n coverage — ${family} (${total} keys in en)\n${lines.join("\n")}`)
        expect(lines.length).toBe(locales.length)
      })
    })
  }

  // Kept from the original file: these two keys were added for a specific feature and every locale is
  // expected to carry a real translation, not the English fallback. A targeted assertion, not a rule.
  test("non-English locales translate the targeted unseen-session keys", () => {
    for (const [name, dict] of APP_LOCALES) {
      for (const key of ["command.session.previous.unseen", "command.session.next.unseen"] as const) {
        expect(typeof dict[key], `${name} ${key}`).toBe("string")
        expect(dict[key], `${name} ${key}`).not.toBe(en[key])
      }
    }
  })

  // The same shape, for the session-fault taxonomy (`session-error-keys.test.ts` pins the other half —
  // that every key the taxonomy returns exists in `en`). Rule 2 above makes a MISSING key legal, and
  // for almost every key that is right. Not for these: a failed turn is the single most likely first
  // thing a lay user sees — a model server that is off, a key that expired — and AGENTS.md's *it never
  // breaks in your hands* clause is not satisfied by falling back to a language they do not read. So
  // these carry a real translation in every locale or the gate says which one does not.
  //
  // ⚠️ The cost is deliberate: a new arm in `session-error.ts` is not shippable until all 17 bundles
  // carry it. That is the point — a half-translated fault surface is exactly what this catches — but
  // translate it properly. An English string pasted into `de.ts` passes this check while LYING about
  // the backlog, which is worse than leaving the key out; the honest short-term answer to "I cannot
  // translate this" is to say so, not to make the assertion green.
  test("non-English locales translate every session-fault headline", () => {
    const keys = Object.keys(en).filter((key) => key.startsWith("session.error."))
    expect(keys.length, "no session.error.* keys in en — has the taxonomy moved?").toBeGreaterThan(0)
    const untranslated: string[] = []
    for (const [name, dict] of APP_LOCALES) {
      for (const key of keys) {
        const value = dict[key]
        if (typeof value !== "string") untranslated.push(`${name}.ts is missing ${key}`)
        else if (value === en[key as keyof typeof en]) untranslated.push(`${name}.ts leaves ${key} in English`)
      }
    }
    expect(untranslated, "add a real translation for each line below, in that locale's bundle").toEqual([])
  })
})
