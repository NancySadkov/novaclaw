import { describe, expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The i18n key-check ratchet (todo.md ruling 1 — an invariant with no mechanical check does not
// exist).
//
// As of 2026-07-29 `context/language.tsx` types the app's translator as
// `(key: keyof Dictionary, params?) => string` — a real ~1862-key union — so a key that is not in
// `i18n/en.ts` (or the ui bundle) is a COMPILE error and can no longer render as raw text at a user.
// That invariant is enforced by the type, and the day-to-day gate runs `typecheck` — so this file
// does NOT re-check it. What it checks is the thing a type cannot: that nobody switches the check
// back off.
//
// There is exactly ONE sanctioned way to translate a key the compiler cannot know:
// `dynamicKey(key)` from `@/context/language`, which is named, documented, and greppable. Everything
// else — `as Parameters<typeof language.t>[0]`, `as TranslationKey`, a local
// `(key: string) => string` wrapper around `language.t` — is a silent bypass that compiles green.
// Nineteen such casts existed before this change, written when the translator took a plain `string`
// and the cast was a harmless no-op; the moment the union became real they turned into live holes.
// Seventeen were closed by narrowing the SOURCE to a union (a `satisfies` constraint, an `as const`,
// a four-member field union); two genuinely cannot be and are pinned below.
//
// THE RULE: this list may only SHRINK. Adding a file fails the test — narrow the source instead.
// Removing one also fails until you delete its line here, which is the point: an escape hatch
// disappearing should be a visible, deliberate edit, not a silent diff.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Every way to hand the translator a key it cannot check. `dynamicKey(` is the sanctioned one and is
 * still ledgered — being sanctioned makes it legible, not unlimited.
 */
const BYPASS_PATTERNS = [/\bdynamicKey\s*\(/, /as\s+Parameters<typeof\s+language\.t>/, /as\s+TranslationKey\b/]

/**
 * The pinned bypass sites, by path relative to `packages/app/src`. Each one states why the source
 * cannot be narrowed. ⚠️ SHRINK ONLY.
 */
const LEDGER: Record<string, string> = {
  // The tool name arrives on the wire — MCP and plugin tools register at runtime, so there is no
  // compile-time set to narrow to. The miss is HANDLED: `session-permission-dock.tsx` compares the
  // result to the key and renders nothing when they match, so a raw key never reaches the user.
  "pages/session/composer/session-permission-dock.tsx": "runtime tool name; missing-key case handled",

  // ✅ `components/settings-v2/parts/theme-swatches.tsx` was here until 2026-07-29, because
  // `APP_THEME_PRESETS[].nameKey` was declared `string`. It is a closed three-row table authored in
  // `context/app-theme.tsx`, so the fix was to narrow the SOURCE to `TranslationKey` — the same
  // remedy that closed 17 of the original 19 casts — and the swatch component now calls
  // `language.t(preset.nameKey)` with no hatch at all. Entry dropped, not silenced.

  // The app-registry bridge: an app manifest is user/agent-authored data, so its label key is open by
  // design. `apps/**` is a separate ownership island; the casts there predate this ratchet.
  "apps/builtins.tsx": "app-registry Translate bridge; manifest labels are open by design",
  "apps/manifest-apps.ts": "app-registry Translate bridge; manifest labels are open by design",
}

const SRC = resolve(import.meta.dir, "..")

/** Where `dynamicKey` is declared — it necessarily contains the pattern that names it. */
const DECLARATION = join("context", "language.tsx")

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue
      out.push(...sourceFiles(full))
      continue
    }
    if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

/** Lines that are pure comment are prose ABOUT a cast, not a cast — this file is full of them. */
function isComment(line: string) {
  const trimmed = line.trimStart()
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")
}

function findBypasses() {
  const hits: Record<string, string[]> = {}
  for (const file of sourceFiles(SRC)) {
    const rel = relative(SRC, file)
    if (rel === DECLARATION) continue
    if (rel === relative(SRC, import.meta.path)) continue
    const lines = readFileSync(file, "utf8").split("\n")
    for (const [index, line] of lines.entries()) {
      if (isComment(line)) continue
      if (!BYPASS_PATTERNS.some((pattern) => pattern.test(line))) continue
      const key = rel.split(sep).join("/")
      ;(hits[key] ??= []).push(`${index + 1}: ${line.trim()}`)
    }
  }
  return hits
}

const declarationLines = () =>
  readFileSync(join(SRC, DECLARATION), "utf8")
    .split("\n")
    .map((line) => line.trimEnd())

describe("i18n key-check ratchet", () => {
  test("the set of unchecked-key sites matches the ledger exactly", () => {
    const found = Object.keys(findBypasses()).sort()
    const pinned = Object.keys(LEDGER).sort()
    // Reported as whole sorted lists so a failure names the offending path, not just a count.
    expect(found).toEqual(pinned)
  })

  test("`dynamicKey` is the only named hatch, and it is documented at its declaration", () => {
    const lines = declarationLines()
    expect(lines.some((line) => line.startsWith("export function dynamicKey("))).toBe(true)
    // The hatch is only defensible if it says why it is unchecked — AGENTS.md, teach-don't-gatekeep.
    expect(lines.some((line) => line.includes("unverified"))).toBe(true)
  })

  // ⚠️ The ratchet above is blind to this one: widen `TranslationKey` back to `string` and every
  // bypass pattern disappears from the tree, so the ledger goes green over a translator that checks
  // nothing. Assert the two declarations by their exact text. Matched line-by-line so a failure
  // prints the offending line, not the whole 300-line file.
  test("the translator is key-typed, not `key: string`", () => {
    const lines = declarationLines()
    expect(lines).toContain("export type TranslationKey = keyof Dictionary")
    expect(lines).toContain("export type Translator = (key: TranslationKey, params?: TranslationParams) => string")
  })
})
