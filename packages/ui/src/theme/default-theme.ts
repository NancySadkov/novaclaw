// The brand theme and the migration off the ids we inherited from upstream.
//
// `visual.md` §2.8 names it: "**Nova is the fallback**, so any failure degrades to brand" and "Nova is
// the brand; presets are a user preference." So the theme every user gets before they choose anything
// is `nova`, and every other `themes/*.json` is a preset. (`app/src/context/app-theme.tsx` already
// spells the app-level colour preset the same way — one brand name across both layers, ruling 13.)
//
// ⚠️ Kept as its own module — free of `solid-js`, of `import.meta.glob` and of any DOM — so the
// invariants below can be exercised by a plain `bun test` from more than one package. Importing
// `./context` for them would drag in Vite-only globs.

/** The theme a fresh install lands on, and the fallback for any id that no longer exists. */
export const DEFAULT_THEME_ID = "nova"

/**
 * Theme ids that shipped before the rename and may still be sitting in a user's `localStorage`.
 * `oc-1`/`oc-2` are opencode's ids; NovaClaw's attribution lives in `licenses/` + `NOTICE` and nowhere
 * else. Append-only: an id removed from here strands whoever still has it stored, which is ruling 2 —
 * an unavailable subsystem names itself, it does not silently render an unknown theme.
 */
export const LEGACY_THEME_IDS: readonly string[] = ["oc-1", "oc-2"]

const LEGACY = new Set(LEGACY_THEME_IDS)

/**
 * Resolve a stored/requested theme id to the id that exists today. `null`/`undefined` pass through so
 * callers can keep distinguishing "nothing stored" from "stored something unknown".
 */
export function normalizeThemeId(id: string | null | undefined): string | null | undefined {
  if (id === null || id === undefined) return id
  // Set lookup, not an object map: `normalizeThemeId("constructor")` must return "constructor".
  return LEGACY.has(id) ? DEFAULT_THEME_ID : id
}
