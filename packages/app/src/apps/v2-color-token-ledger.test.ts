import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * EVERY `*-v2-*` COLOUR CLASS MUST NAME A TOKEN THAT EXISTS.
 *
 * 🔴 A Tailwind colour utility whose token is undefined is DROPPED at compile time — silently. There
 * is no error, no warning and nothing in the type system that can see it, because the class is a
 * string in a `class=` attribute. Two ways that hurts, and the first is the one that made this
 * ledger worth writing:
 *
 *   1. **`border-*` is VISIBLE, not merely dead.** `border-t` emits `border-top-style` and
 *      `border-top-width` and no colour, and preflight sets `border: 0 solid`, so the colour falls
 *      back to `currentColor`. `border-t border-v2-border-border-faint` therefore drew a 1px line in
 *      the element's TEXT colour — near-white on the dark skin — right beside correctly-styled
 *      hairlines in the same component.
 *   2. **`bg-*` / `text-*` are inert.** Whole hover states did nothing: the composer's colleague
 *      chip had no hover feedback at all, and nobody noticed for a month.
 *
 * Measured 2026-08-23 (review `notes/reports/named-agents-and-home-review-2026-08-23.md`, D7):
 * five undefined token names across fourteen sites, one of them
 * (`border-v2-border-border-faint`) shipped since 2026-07-19 and confirmed absent from the built
 * stylesheet. The whole class is mechanical to catch and invisible to every other instrument we
 * have, which is exactly what a source ledger is for.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const appSrc = path.resolve(here, "..")
const uiSrc = path.resolve(appSrc, "../../ui/src")
const sessionUiSrc = path.resolve(appSrc, "../../session-ui/src")
const colorsCss = path.join(uiSrc, "styles/tailwind/colors.css")

/** The utility prefixes that take a COLOUR token. A `size-`/`p-` class named `v2-…` is not one. */
const COLOR_UTILITIES = ["text", "bg", "border", "ring", "fill", "stroke", "outline", "decoration", "shadow", "accent"]

/**
 * `hover:bg-v2-x`, `md:text-v2-y`, `!border-v2-z` — a class can carry any number of variants and a
 * leading `!`, and the token is what follows the utility. Anchored on a word boundary so
 * `data-bg-v2-…` in an attribute name is not mistaken for a class.
 */
const CLASS_RE = new RegExp(String.raw`(?:^|[\s"'\`:!])(${COLOR_UTILITIES.join("|")})-(v2-[a-z0-9-]+)`, "g")

function sourceFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.(tsx|ts)$/.test(entry)) continue
      if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) continue
      out.push(full)
    }
  }
  walk(root)
  return out
}

/** The token names Tailwind will actually generate a utility for. */
function definedTokens(): Set<string> {
  const css = readFileSync(colorsCss, "utf8")
  const names = new Set<string>()
  for (const match of css.matchAll(/--color-(v2-[a-z0-9-]+)\s*:/g)) names.add(match[1]!)
  return names
}

/**
 * ⚠️ Comments are STRIPPED before matching. A regex over source counts prose: this file's own
 * header names five dead tokens on purpose, and without this it would fail itself.
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
}

describe("v2 colour token ledger", () => {
  const tokens = definedTokens()

  test("colors.css actually parsed", () => {
    // A guard on the instrument: an empty token set would make every assertion below vacuous.
    expect(tokens.size).toBeGreaterThan(50)
    expect(tokens.has("v2-border-border-base")).toBe(true)
  })

  test("every v2 colour class in the UI tree names a defined token", () => {
    const offenders: string[] = []
    for (const root of [appSrc, uiSrc, sessionUiSrc]) {
      for (const file of sourceFiles(root)) {
        const text = code(readFileSync(file, "utf8"))
        for (const match of text.matchAll(CLASS_RE)) {
          const token = match[2]!
          if (tokens.has(token)) continue
          const line = text.slice(0, match.index).split("\n").length
          offenders.push(`${path.relative(appSrc, file)}:${line} → ${match[1]}-${token}`)
        }
      }
    }
    // Named, not counted: the point of the ledger is that the failure tells you which class and where.
    expect(offenders).toEqual([])
  })
})
