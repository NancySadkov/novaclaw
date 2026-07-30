import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { DEFAULT_THEME_ID, LEGACY_THEME_IDS, normalizeThemeId } from "./default-theme"
import novaThemeJson from "./themes/nova.json"
import { resolveThemeVariant } from "./resolve"
import { resolveThemeVariantV2 } from "./v2/resolve"
import type { DesktopTheme } from "./types"

const THEMES_DIR = join(import.meta.dir, "themes")
const REPO_ROOT = resolve(import.meta.dir, "../../../..")

function themeFile(id: string) {
  return JSON.parse(readFileSync(join(THEMES_DIR, `${id}.json`), "utf8")) as { id?: string; name?: string }
}

function themeIds() {
  return readdirSync(THEMES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
}

describe("the brand default theme", () => {
  // visual.md §2.8: "Nova is the fallback, so any failure degrades to brand" / "Nova is the brand;
  // presets are a user preference." The default is the one theme the doc actually names.
  test("is nova, and nova is a real theme file whose own id and name agree", () => {
    expect(DEFAULT_THEME_ID).toBe("nova")
    const theme = themeFile(DEFAULT_THEME_ID)
    expect(theme.id).toBe(DEFAULT_THEME_ID)
    expect(theme.name).toBe("Nova")
  })

  // `loader.ts:getActiveTheme()` compares `activeTheme.id` against the `data-theme` attribute, which is
  // set from the FILENAME-derived id (`context.tsx:themeIDs()`). A theme whose `id` field disagrees with
  // its filename therefore reports "no active theme" forever — and compiles green.
  test("every theme file's id field matches its filename", () => {
    const mismatched = themeIds()
      .map((id) => ({ id, declared: themeFile(id).id }))
      .filter((t) => t.declared !== t.id)
    expect(mismatched).toEqual([])
  })

  // The rename moved a 21 KB file. A truncated or mis-edited variant would still parse as JSON, so
  // resolve it: `desktop/src/main/windows.ts` reads `background-base` off exactly this theme to colour
  // the Electron window BEFORE any renderer exists, and an undefined there paints a black frame.
  test("resolves through both token pipelines, including the token the desktop window needs", () => {
    const theme = novaThemeJson as DesktopTheme
    for (const [variant, isDark] of [
      [theme.light, false],
      [theme.dark, true],
    ] as const) {
      const tokens = resolveThemeVariant(variant, isDark)
      expect(tokens["background-base"]).toMatch(/^#[0-9a-f]{6}$/i)
      expect(Object.keys(tokens).length).toBeGreaterThan(200)
      expect(Object.keys(resolveThemeVariantV2(variant, isDark)).length).toBeGreaterThan(150)
    }
  })
})

// Theme ids that were actually shipped to users before the rename. This is a fact about history, so it
// is written out rather than read from `LEGACY_THEME_IDS` — a test that iterates the constant it is
// testing cannot notice the constant losing an entry.
const SHIPPED_LEGACY_IDS = ["oc-1", "oc-2"]

describe("legacy theme id migration", () => {
  // Ruling 2: a user who chose the old default must not land on an unknown theme after upgrade.
  test("every id that ever shipped resolves to the default", () => {
    for (const legacy of SHIPPED_LEGACY_IDS) {
      expect(normalizeThemeId(legacy)).toBe(DEFAULT_THEME_ID)
    }
  })

  test("the declared legacy list covers every shipped id and nothing that is not a migration", () => {
    expect([...LEGACY_THEME_IDS].sort()).toEqual([...SHIPPED_LEGACY_IDS].sort())
    for (const legacy of LEGACY_THEME_IDS) {
      expect(normalizeThemeId(legacy)).toBe(DEFAULT_THEME_ID)
    }
  })

  test("no legacy id is still a shipped theme file", () => {
    const shipped = new Set(themeIds())
    for (const legacy of SHIPPED_LEGACY_IDS) {
      expect(shipped.has(legacy)).toBe(false)
    }
  })

  test("a live theme id passes through untouched", () => {
    for (const id of themeIds()) expect(normalizeThemeId(id)).toBe(id)
  })

  test("absent ids stay absent, so callers can tell 'nothing stored' from 'stored something unknown'", () => {
    expect(normalizeThemeId(null)).toBeNull()
    expect(normalizeThemeId(undefined)).toBeUndefined()
    expect(normalizeThemeId("")).toBe("")
  })

  test("an unknown id is not rewritten, and Object.prototype keys are not a back door", () => {
    expect(normalizeThemeId("dracula-but-typoed")).toBe("dracula-but-typoed")
    // A plain-object lookup table would answer this with `Object`'s constructor.
    expect(normalizeThemeId("constructor")).toBe("constructor")
    expect(normalizeThemeId("__proto__")).toBe("__proto__")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The ratchet. `oc-1`/`oc-2` are opencode's theme ids; the attribution belongs in `licenses/` + `NOTICE`
// and nowhere else (AGENTS.md). This scan fails if either id reappears in source, and fails just as
// loudly when a ledgered file is cleaned without the ledger being updated — so the list can only shrink.
// ─────────────────────────────────────────────────────────────────────────────

const SCAN_ROOTS = [
  "packages/ui/src",
  "packages/ui/script",
  "packages/app/src",
  "packages/app/public",
  "packages/desktop/src",
  "packages/session-ui/src",
]
/** ERE for `git grep`, not a JS RegExp — `\b` is supported by git's POSIX-ERE engine. */
const LEGACY_ID_PATTERN = "\\boc-[12]\\b"

/** Files allowed to still name a legacy id. SHRINK-ONLY — remove the row in the same change as the fix. */
const LEDGER: { path: string; why: string }[] = [
  {
    path: "packages/ui/src/theme/default-theme.ts",
    why: "by design — it IS the migration table; LEGACY_THEME_IDS is append-only",
  },
  {
    path: "packages/ui/src/theme/default-theme.test.ts",
    why: "by design — this ledger",
  },
  {
    path: "packages/app/src/theme-preload.test.ts",
    why: "by design — it exercises the preload's own legacy migration",
  },
  {
    path: "packages/app/public/oc-theme-preload.js",
    why:
      "by design — it is the first-paint script's own copy of the migration. It runs before any module " +
      "loads, so it cannot import LEGACY_THEME_IDS and must name both legacy ids as literals to map " +
      "them onto the brand default. This row can never be removed while the migration is owed; it " +
      "shrinks only when LEGACY_THEME_IDS itself is retired.",
  },
]

let scanned: string[] | undefined

/**
 * Ask git, rather than walking the tree by hand.
 *
 * ⚠️ This scan hand-rolled a recursive walk that read every file as UTF-8, and it TIMED OUT the gate
 * twice on 2026-07-30 — 16.7 s, then 15.1 s after a first attempt at trimming it by extension. Both
 * reds had found nothing; the failure was the walk. Warm-cache timings hid it (215 ms, then 400 ms),
 * so it passed every time it was run on its own and only failed inside the full gate. **A ratchet that
 * reds for reasons unrelated to what it guards is worse than no ratchet** — it teaches the next person
 * to re-run reds instead of reading them.
 *
 * `git grep` does the whole thing in one process in 0.45 s, startup included, because it greps in C
 * over tracked files instead of doing ~1,900 `readFileSync` calls through Windows Defender. Measured
 * both ways; the extension filter it replaces was still reading 1,106 icon SVGs, none of which has
 * ever contained a theme id.
 *
 * Tracked-only is a DELIBERATE narrowing and the right domain: an untracked scratch file naming
 * `oc-2` is not a source regression, and it cannot reach another clone. If git is missing or errors,
 * this THROWS rather than returning `[]` — an empty result would make both assertions below pass
 * vacuously, which is the one failure mode a guard like this must never have.
 */
function filesNamingALegacyId() {
  if (scanned) return scanned
  const res = spawnSync("git", ["grep", "-lE", LEGACY_ID_PATTERN, "--", ...SCAN_ROOTS], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
  // git grep: 0 = matches, 1 = no matches, >1 = real error. Anything else must be loud.
  if (res.error) throw res.error
  if (res.status !== 0 && res.status !== 1) {
    throw new Error(`git grep failed (status ${res.status}): ${res.stderr?.trim() || "no stderr"}`)
  }
  scanned = res.stdout
    .split("\n")
    .map((l) => l.trim().replaceAll("\\", "/"))
    .filter(Boolean)
    .sort()
  return scanned
}

describe("opencode theme ids stay retired", () => {
  test("no source file outside the ledger names oc-1 or oc-2", () => {
    const ledgered = new Set(LEDGER.map((e) => e.path))
    const unexpected = filesNamingALegacyId().filter((f) => !ledgered.has(f))
    expect(unexpected).toEqual([])
  })

  test("every ledger row is still real, so the list can only shrink", () => {
    const found = new Set(filesNamingALegacyId())
    const stale = LEDGER.filter((e) => !found.has(e.path)).map((e) => e.path)
    expect(stale).toEqual([])
  })

  // Guard the INSTRUMENT. "No source file outside the ledger names a legacy id" passes trivially if
  // the scan returns nothing, so the scan must be shown to work on a case we KNOW matches. A bad
  // pathspec, a pattern typo, or a `git grep` run from the wrong cwd all produce a silent empty set.
  test("the scan is not vacuous — it finds the file that defines the legacy ids", () => {
    // `default-theme.ts` holds LEGACY_THEME_IDS = ["oc-1", "oc-2"], so it must always match while the
    // migration is owed. Asserting a specific known-positive beats a count: a count floor drifts with
    // the tree, this cannot pass unless the grep really ran and really matched.
    expect(filesNamingALegacyId()).toContain("packages/ui/src/theme/default-theme.ts")
  })
})
