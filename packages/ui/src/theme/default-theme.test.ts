import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { extname, join, relative, resolve } from "node:path"
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
const SKIP_DIRS = new Set(["node_modules", "dist", "out", ".vite"])
const LEGACY_ID_PATTERN = /\boc-[12]\b/

// ⚠️ Read only files a theme id can actually live in. This scan used to slurp EVERY file under the
// roots as UTF-8 — 2,029 files / 15.4 MB, most of it fonts (.woff2/.ttf) and a 1.4 MB logo.png being
// decoded and thrown away. On a warm cache that cost 215 ms; inside the full gate, cold, it blew the
// 15 s per-test timeout and reported a RED that had found nothing (2026-07-30). A ratchet that fails
// for reasons unrelated to what it guards is worse than no ratchet — it teaches the next person to
// re-run reds instead of reading them. This is a speed fix, not a narrowing: none of the excluded
// types can carry a theme id, the ledgered files are all in this set, and `scannedCount` below fails
// loudly if the filter ever silently matches (almost) nothing.
const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
  ".scss",
  ".html",
  ".svg",
  ".md",
  ".txt",
  ".yml",
  ".yaml",
])

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

function walk(dir: string, out: string[]) {
  // withFileTypes, not statSync: a Dirent describes the entry without following it, so a broken symlink
  // in `public/` cannot throw the whole scan (they are real symlinks on Linux, plain files on Windows).
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) out.push(full)
  }
}

let scanned: string[] | undefined
let scannedCount = 0

function filesNamingALegacyId() {
  if (scanned) return scanned
  const found: string[] = []
  let count = 0
  for (const root of SCAN_ROOTS) {
    const files: string[] = []
    walk(join(REPO_ROOT, root), files)
    for (const file of files) {
      let text: string
      try {
        text = readFileSync(file, "utf8")
      } catch {
        continue // unreadable
      }
      count++
      if (LEGACY_ID_PATTERN.test(text)) found.push(relative(REPO_ROOT, file).replaceAll("\\", "/"))
    }
  }
  scannedCount = count
  scanned = found.sort()
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

  // Guard the INSTRUMENT. The two tests above both pass trivially if the scan reads nothing — an
  // empty `found` makes "nothing unexpected" true, and only the ledger check would notice. Since the
  // walk now filters by extension, a typo in TEXT_EXTENSIONS is the realistic way to silently gut it.
  test("the scan actually read the source tree", () => {
    filesNamingALegacyId()
    // ~1,100 text files across the roots today; the floor is deliberately far below that so ordinary
    // growth or deletion never trips it, while an empty or near-empty scan is loud.
    expect(scannedCount).toBeGreaterThan(400)
  })
})
