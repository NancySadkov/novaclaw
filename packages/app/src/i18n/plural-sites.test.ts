import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import { dict as en } from "./en"
import { dict as uiEn } from "@novaclaw/ui/i18n/en"
import { PLURAL_CATEGORIES, pluralGroups } from "./resolve"
// Type-only: `context/language.tsx` reads `localStorage` and warms a dictionary at module scope, and
// none of that should run to check a type.
import type { PluralGroup } from "@/context/language"

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The hardcoded-plural ratchet (ruling 1 — an invariant with no mechanical check does not exist).
//
// A counted phrase written as `t(n === 1 ? "x.one" : "x.other", { count: n })` bakes the
// English/Germanic TWO-FORM rule into a call site, where no translator can reach it. Russian,
// Ukrainian, Polish and Bosnian need one/few/many; Arabic needs six categories. So in every Slavic
// locale one of {2–4, 5+} is always grammatically wrong — Polish `session.revertDock.summary.other`
// is the *few* form, so a revert of 5 reads "5 cofnięte wiadomości" instead of "5 cofniętych
// wiadomości" — and the bundle cannot fix it, because the ternary decided before the bundle was
// consulted.
//
// `useLanguage().plural(group, count, params)` is the way that works: it picks the form from
// `Intl.PluralRules` for the locale in force and degrades to `.other` for a form a bundle has not
// landed yet. `resolve.ts` holds the mechanism, `resolve.test.ts` proves 0/1/2/5 in English and in
// Russian, and `parity.test.ts` lets a locale carry the extra categories its language actually has.
//
// WHAT THIS TEST DOES. It derives every plural GROUP from the shipped dictionaries — a base with
// both a `.one` and a `.other` — and then looks for a source file that writes one of those keys out
// with a category suffix. A `plural()` call names the group alone, so it does not match; only a
// hand-rolled selection does.
//
// THE RULE: this list may only SHRINK. Adding a file fails the test — call `plural()` instead.
// Removing one also fails until you delete its line here, which is the point: a site leaving the
// ledger should be a visible, deliberate edit.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The remaining hand-rolled plural sites, by path relative to `packages/`. ⚠️ SHRINK ONLY.
 *
 * 🔴 **It is EMPTY, and that is the whole point.** Every site the ratchet was built for has been
 * converted, so this stopped being a worklist and became a ban: a hand-rolled `n === 1 ? "x.one" :
 * "x.other"` anywhere under `ROOTS` now fails this test with nowhere to be written down. Converting
 * is mechanical — swap the ternary for `language.plural(<group>, n, …)` and drop the explicit
 * `count` param, which `plural` supplies.
 *
 * ⚠️ Do NOT add a line here to make a red go green. The entry that would go in it is the defect.
 */
const LEDGER: Record<string, string> = {}

/** `packages/`. */
const PACKAGES = resolve(import.meta.dir, "..", "..", "..")

/** Where rendering code lives. A bundle is data, not a call site, and is excluded below. */
const ROOTS = ["app/src", "ui/src", "session-ui/src"]

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "i18n") continue
      out.push(...sourceFiles(full))
      continue
    }
    if (!/\.tsx?$/.test(entry.name)) continue
    if (/\.test\.tsx?$/.test(entry.name)) continue
    out.push(full)
  }
  return out
}

const GROUPS = [...pluralGroups(en), ...pluralGroups(uiEn)]

/**
 * The COMPILE-TIME half, and the only place it can be asserted.
 *
 * `PluralGroup` is derived from `TranslationKey` by a distributive conditional. If that ever stopped
 * reducing to real literals — the same accident that collapses `TranslationKey` itself to `string`,
 * one layer down — it would become `never`, `plural()` would be uncallable, and every runtime check
 * in this file would still pass. This annotation is what turns that into a typecheck failure.
 */
const A_REAL_GROUP: PluralGroup = "session.revertDock.summary"

/** Every `"<group>.<category>"` literal a hand-rolled selection has to write out. */
const HARDCODED = GROUPS.flatMap((group) => PLURAL_CATEGORIES.map((category) => `"${group}.${category}"`))

function findSites() {
  const hits: Record<string, string[]> = {}
  let scanned = 0
  for (const root of ROOTS) {
    for (const file of sourceFiles(join(PACKAGES, root))) {
      scanned += 1
      const text = readFileSync(file, "utf8")
      const found = HARDCODED.filter((literal) => text.includes(literal))
      if (found.length === 0) continue
      hits[relative(PACKAGES, file).split(sep).join("/")] = found
    }
  }
  return { hits, scanned }
}

describe("hardcoded plurals", () => {
  // Guards the guard: if the group derivation or the file walk breaks, every test below would pass
  // by finding nothing at all.
  test("the scan sees the dictionaries and the tree", () => {
    const { scanned } = findSites()
    expect(GROUPS.length).toBeGreaterThanOrEqual(12)
    expect(GROUPS).toContain(A_REAL_GROUP)
    expect(scanned).toBeGreaterThan(300)
  })

  test("the set of hand-rolled plural sites matches the ledger exactly", () => {
    const found = Object.keys(findSites().hits).sort()
    expect(found).toEqual(Object.keys(LEDGER).sort())
  })
})
