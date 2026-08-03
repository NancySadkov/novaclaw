import { describe, expect, test } from "bun:test"
import { SESSION_ERROR_TEXT, type SessionErrorKey } from "@novaclaw/core/session/session-error"
import { HOST_I18N_KEYS, type UiI18nKey } from "@novaclaw/ui/context/i18n"
import { dict as en } from "./en"

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The session-fault taxonomy ↔ i18n ratchet (todo.md ruling 1 — an invariant with no mechanical
// check does not exist).
//
// `@novaclaw/core/session/session-error` is THE chokepoint that turns a `Session.Error.Unknown`
// into display text. It answers with a `key` + `params` so the headline can be translated, and
// carries an English string beside every key as the fallback for surfaces that have no translator
// (the headless CLI). That design creates three invariants which all compile green when broken,
// and no one file can see all of them — they live in three packages:
//
//   1. EVERY key the taxonomy can return exists in `en.ts`, and `en.ts` holds no `session.error.*`
//      key the taxonomy cannot return. A missing key does not fail to build. ⚠️ It also does NOT
//      render the key at the user, as an earlier version of this comment claimed — measured
//      2026-07-30 against `@solid-primitives/i18n@2.2.1`, `translator()` returns the looked-up
//      value, i.e. **`undefined`** on a miss, which Solid renders as NOTHING. So the failure mode
//      is an empty error box: ruling 2's *an unavailable subsystem names itself instead of
//      rendering empty*, which is worse than a raw key, not better. An orphan key is the mirror:
//      an arm was deleted and its translation rotted in 18 bundles.
//   2. The two English strings AGREE. If they drift, one fault reads one way in the app and another
//      way in the CLI — the "second formatter" divergence session-error.ts's own header says it
//      exists to prevent. Pinning them equal makes the module's table and this dictionary one fact.
//   3. `packages/ui`'s `HOST_I18N_KEYS` — the keys the UI layer declares the HOST provides, which
//      is what lets a `session-ui` component pass one to a key-typed translator — matches the
//      taxonomy exactly. Without this, widening `UiI18nKey` would be an unchecked promise.
//
// ⚠️ **This file used to read `session-error.ts` as SOURCE TEXT and regex the keys out of it,**
// because `packages/app` could not import it: it lived in `packages/session-ui`, whose `exports`
// map sends `./v2/*` to `*.tsx`. The module moved to `packages/core` on 2026-07-30 precisely so all
// three consumers could reach it, so the parsing is gone — a real import cannot pass vacuously,
// needs no "did the regex still match?" guards, and fails at COMPILE time if the module moves
// again.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The compile-time half of invariant 3: every key the taxonomy can hand a renderer must be a key
 * the UI layer is allowed to pass to `useI18n().t`. If `HOST_I18N_KEYS` stops covering the
 * taxonomy, `native-transcript.tsx` stops compiling — this line says so in one place instead.
 */
type TaxonomyKeysAreHostKeys = SessionErrorKey extends UiI18nKey ? true : never
const taxonomyKeysAreHostKeys: TaxonomyKeysAreHostKeys = true

/** `{{name}}` — the template syntax `i18n.resolveTemplate` resolves. */
function placeholders(value: string): string[] {
  return [...value.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)].map((match) => match[1]!).sort()
}

function sessionErrorKeysIn(dict: Record<string, unknown>) {
  return new Set(Object.keys(dict).filter((key) => key.startsWith("session.error.")))
}

const sorted = (values: Iterable<string>) => [...values].sort()

/** Every templated arm and the exact structured parameter its producer must supply. */
const INTERPOLATING = {
  "session.error.gatewayTimeout": ["status"],
  "session.error.offlineBlockedEndpoint": ["endpoint"],
  "session.error.transportEndpoint": ["endpoint"],
} as const

describe("session error taxonomy ↔ i18n", () => {
  test("every key the taxonomy returns exists in en.ts, and en.ts holds no orphan", () => {
    const keys = Object.keys(SESSION_ERROR_TEXT)
    expect(keys.length, "the taxonomy declares no keys — the import is wrong").toBeGreaterThan(0)
    // Whole sorted lists, so a failure names the offending key rather than printing a count.
    expect(sorted(sessionErrorKeysIn(en))).toEqual(sorted(keys))
  })

  test("the taxonomy's English fallback text matches en.ts word for word", () => {
    for (const [key, text] of Object.entries(SESSION_ERROR_TEXT)) expect(en[key as keyof typeof en], key).toBe(text)
  })

  test("packages/ui's declared host keys are exactly the taxonomy's keys", () => {
    // The runtime half of invariant 3. The type above proves the taxonomy is a SUBSET; this proves
    // there is no surplus either — a `HOST_I18N_KEYS` entry no arm can produce is a promise the
    // app is never asked to keep, and it would rot silently.
    expect(sorted(HOST_I18N_KEYS)).toEqual(sorted(Object.keys(SESSION_ERROR_TEXT)))
    for (const key of HOST_I18N_KEYS) expect(typeof en[key], `${key} is declared host-provided`).toBe("string")
    expect(taxonomyKeysAreHostKeys).toBe(true)
  })

  test("only declared arms interpolate, with their exact structured parameter", () => {
    for (const key of sessionErrorKeysIn(en)) {
      const expected = key in INTERPOLATING ? [...INTERPOLATING[key as keyof typeof INTERPOLATING]] : []
      expect(placeholders(en[key as keyof typeof en]), key).toEqual(expected)
    }
    // …and the list above is not stale: every arm named here really is in the dictionary.
    for (const key of Object.keys(INTERPOLATING)) expect(sessionErrorKeysIn(en).has(key), key).toBe(true)
  })
})
