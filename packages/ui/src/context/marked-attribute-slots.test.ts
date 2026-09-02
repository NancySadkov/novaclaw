import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

/**
 * 🔴 **A RENDERER MAY NOT INTERPOLATE A RAW VALUE INTO AN ATTRIBUTE IT OPENED.**
 *
 * `marked-attributes.test.ts` proves the two renderers that exist today are safe against two
 * payloads. This file proves the property for the renderers that do not exist yet, which is the half
 * a payload test structurally cannot reach: it reads the source, finds every `${...}` that lands
 * INSIDE a quoted attribute value in an HTML template literal, and requires it to be a call to the
 * escaper.
 *
 * ⚠️ **This is the rung above "escape the two call sites", and the reason to climb it is the
 * subsystem's own history.** The escape was opt-in at each interpolation, so it was forgotten twice
 * in the same object literal — once on a `title`, once on an `href` — and each time the neighbouring
 * line was already correct. "The guard exists, one site over" is not a coincidence to be fixed
 * instance by instance; it is what an opt-in guard produces. The renderers now emit whole attributes
 * through one helper, and this test is what keeps the next author from writing `name="${value}"`
 * again.
 *
 * ⚠️ **Comments are stripped before anything is matched**, by the same scanner that finds the
 * template literals — a regex over raw source counts prose, and the prose around this very fix
 * quotes the defective line verbatim.
 *
 * ⚠️ **The scanner is itself under test.** Two fixtures below carry the exact shape of the defect
 * (the real pre-fix line) and the exact shape of the fix, so a scanner that silently stopped finding
 * anything — the commonest way a source-reading test goes green — fails here first.
 */

type Interpolation = {
  /** The source text of the expression between the braces. */
  readonly expression: string
  /** 1-based line in the file, for an error a reader can act on. */
  readonly line: number
  /** True when an odd number of unescaped quotes precede it inside the same template literal. */
  readonly insideQuotes: boolean
  /** True when the enclosing template literal builds markup or an attribute at all. */
  readonly html: boolean
}

/** A template literal is markup if it opens a tag or an attribute. */
function marks(source: string, at: number): boolean {
  const char = source[at]
  return char === "<" || char === ">" || (char === "=" && source[at + 1] === '"')
}

/**
 * Walk TypeScript source once, skipping comments and strings, and report every interpolation that
 * appears in a template literal — with the quote parity of the literal text before it.
 *
 * Hand-written rather than regex-driven because the three things that must not be confused with each
 * other — `//` inside a URL string, a `"` inside a comment, and a nested template inside `${}` — are
 * exactly what a regex cannot tell apart.
 */
export function scanInterpolations(source: string): Interpolation[] {
  const found: Interpolation[] = []
  let index = 0
  /** The last significant character, which is what decides whether a `/` opens a regex. */
  let previous = ""

  const lineOf = (at: number) => {
    let count = 1
    for (let i = 0; i < at; i += 1) if (source[i] === "\n") count += 1
    return count
  }

  /** Read one template literal, starting just after its opening backtick. Returns the end index. */
  const template = (start: number): number => {
    let i = start
    let quotes = 0
    let apostrophes = 0
    let markup = false
    const pending: { expression: string; at: number; insideQuotes: boolean }[] = []
    while (i < source.length) {
      const char = source[i]
      if (char === "\\") {
        i += 2
        continue
      }
      if (char === "`") {
        for (const item of pending)
          found.push({
            expression: item.expression,
            line: lineOf(item.at),
            insideQuotes: item.insideQuotes,
            html: markup,
          })
        return i + 1
      }
      if (marks(source, i)) markup = true
      if (char === '"') quotes += 1
      if (char === "'") apostrophes += 1
      if (char === "$" && source[i + 1] === "{") {
        const open = i + 2
        let depth = 1
        let j = open
        while (j < source.length && depth > 0) {
          if (source[j] === "{") depth += 1
          else if (source[j] === "}") depth -= 1
          else if (source[j] === "`") j = template(j + 1) - 1
          j += 1
        }
        pending.push({
          expression: source.slice(open, j - 1).trim(),
          at: open,
          insideQuotes: quotes % 2 === 1 || apostrophes % 2 === 1,
        })
        i = j
        continue
      }
      i += 1
    }
    return i
  }

  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1
      continue
    }
    if (char === "/" && next === "*") {
      index += 2
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1
      index += 2
      continue
    }
    if (char === '"' || char === "'") {
      const quote = char
      index += 1
      while (index < source.length && source[index] !== quote) index += source[index] === "\\" ? 2 : 1
      index += 1
      previous = quote
      continue
    }
    // ⚠️ Regular expressions must be skipped, not merely walked past. `marked.tsx` contains
    // `/<pre><code(?:\s+class="language-([^"]*)")?>…/`, which holds an ODD number of quotes: a
    // scanner that treated them as string delimiters would open a string here and close it several
    // statements later, swallowing real code — and it would have reported no offenders at all, which
    // is the shape of a source test that is green because it stopped looking.
    if (char === "/" && REGEX_MAY_START.has(previous)) {
      index += 1
      let inClass = false
      while (index < source.length) {
        const at = source[index]
        if (at === "\\") index += 2
        else if (at === "[") ((inClass = true), (index += 1))
        else if (at === "]") ((inClass = false), (index += 1))
        else if (at === "/" && !inClass) break
        else index += 1
      }
      index += 1
      previous = "/"
      continue
    }
    if (char === "`") {
      index = template(index + 1)
      previous = "`"
      continue
    }
    if (!/\s/.test(char)) previous = char
    index += 1
  }
  return found
}

/**
 * After one of these, a `/` opens a regular expression rather than dividing. The standard
 * disambiguation, and every regex in this package sits after `=`, `(` or `,`.
 */
const REGEX_MAY_START = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "*", "%"])

/** Every expression allowed to land inside a quoted attribute value. */
const ESCAPERS = ["escapeAttribute(", "escapeHtml("]

/**
 * The interpolations that are NOT escaped and are allowed not to be, each with the reason.
 *
 * 🔴 **Keyed by the expression, never by a line number.** A file:line ledger is wrong the first time
 * anything above it moves, and a ledger that is wrong is a ledger nobody trusts. Keyed this way it
 * survives every edit that does not change what is being interpolated — and the last test in this
 * file fails on a DEAD entry, so an exemption cannot outlive the code it excuses either.
 *
 * ⚠️ The bar for an entry is that the value cannot come from a model, a peer or a file: a literal
 * table compiled into this package, or a constant. "It is sanitized later" is not a reason — that is
 * the argument this whole file exists to refuse.
 */
const ALLOWED_RAW: Record<string, string> = {
  "symbol(name as keyof typeof icons)":
    "the key of `icons`, a literal table in this module; the sprite is built from it and nothing else",
  "icon.viewBox": "a value of that same literal table",
  themeId:
    "a shipped theme id, and the string is CSS assigned to `style.textContent` — not markup. " +
    "It is still the weakest entry here: `applyTheme` takes the id from its caller.",
}

const offenders = (source: string, file: string) =>
  scanInterpolations(source)
    .filter((item) => item.html && item.insideQuotes)
    .filter((item) => !ESCAPERS.some((escaper) => item.expression.startsWith(escaper)))
    .filter((item) => ALLOWED_RAW[item.expression] === undefined)
    .map((item) => `${file}:${item.line}  \${${item.expression}}`)

const UI_SRC = join(import.meta.dir, "..")

function sources(directory: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) {
      out.push(...sources(path))
      continue
    }
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue
    out.push(path)
  }
  return out
}

describe("no renderer interpolates a raw value into an attribute it opened", () => {
  test("the scanner reports the defect this rule exists for", () => {
    // The real pre-fix line, character for character.
    const defect =
      'const x = () => `<a href="${href}"${titleAttr} class="external-link" ' +
      'target="_blank" rel="noopener noreferrer">${text}</a>`'
    expect(offenders(defect, "fixture")).toEqual(["fixture:1  ${href}"])
  })

  test("the scanner passes the shape that replaced it, and is not blinded by comments or URLs", () => {
    const fixed = [
      '// href="${href}" is what this used to say, and a regex over source would count this line.',
      '/* `<img src="${src}">` in a block comment is prose too. */',
      'const url = "https://example.com/a?b=1"',
      'const x = () => `<a${attr("href", href)}${attr("title", title)} class="external-link">${text}</a>`',
      'const attr = (name: string, value: string) => ` ${name}="${escapeAttribute(value)}"`',
    ].join("\n")
    expect(offenders(fixed, "fixture")).toEqual([])
  })

  test("🔴 every attribute built anywhere in this package goes through the escaper", () => {
    const flagged = sources(UI_SRC).flatMap((path) => offenders(readFileSync(path, "utf8"), path))
    // Print the LINES, never a count: a bare number tells the next reader nothing about what to fix.
    expect(flagged).toEqual([])
  })

  test("no exemption outlives the code it excuses", () => {
    const live = new Set(
      sources(UI_SRC)
        .flatMap((path) => scanInterpolations(readFileSync(path, "utf8")))
        .filter((item) => item.html && item.insideQuotes)
        .map((item) => item.expression),
    )
    expect(Object.keys(ALLOWED_RAW).filter((expression) => !live.has(expression))).toEqual([])
  })

  test("the rule is measuring the file it claims to — the renderers are reached and non-empty", () => {
    // Without this, the assertion above is satisfied by a scanner that returns nothing at all.
    const renderer = readFileSync(join(import.meta.dir, "marked.tsx"), "utf8")
    const interpolations = scanInterpolations(renderer).filter((item) => item.html)
    expect(interpolations.length).toBeGreaterThan(4)
  })
})
