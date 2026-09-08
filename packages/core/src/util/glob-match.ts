/**
 * Glob matching, owned. Replaces `minimatch` (2026-09-03, AGENTS.md principle 2) for the three
 * consumers in this tree: `util/glob.ts` (`Glob.match` and the scan filter), `filesystem/ignore.ts`
 * and `filesystem/watcher.ts` (both through `Glob.match`), and `project-exclusion.ts` (the privacy
 * guard, `dot` and `nocase`).
 *
 * 🔴 Why not `path.matchesGlob`. Measured 2026-09-03: Bun answers `**\/*.md` ⊇ `.forge/README.md`
 * TRUE and Node answers FALSE, and core runs under BOTH (bun in the CLI and the tests, Node in
 * the desktop sidecar). A privacy guard whose verdict depends on the runtime is not a guard.
 * Neither runtime exposes `dot` or `nocase` either. So the semantics are written down here, once,
 * and `test/glob-match.test.ts` holds them to a corpus recorded from minimatch on the day it left.
 *
 * The dialect, which is minimatch's for everything this tree passes:
 * - `*` matches any run of characters within one segment; `?` matches one; neither crosses `/`.
 * - `**` as a whole segment matches zero or more segments. Anywhere else it is two `*`.
 * - `[abc]`, `[a-z]`, `[!abc]` / `[^abc]` are character classes; `[[:digit:]]` and friends are the
 *   POSIX classes.
 * - `{a,b}` expands to alternatives (nested; `{1..3}` is a numeric range); a brace without a comma
 *   or range is literal.
 * - `\` escapes the next character.
 * - `dot: false` (the default) hides dot segments from `*`, `?`, `**` and classes: a path segment
 *   that starts with `.` matches only a pattern segment that starts with a literal `.`.
 * - `nocase` compares case-insensitively, classes included.
 * - Nothing is normalised. `a//b` and `a/b` are different, `./a` and `a` are different, and a
 *   trailing slash is an (empty) segment of its own — exactly as minimatch answered.
 */
export * as GlobMatch from "./glob-match"

export interface Options {
  readonly dot?: boolean
  readonly nocase?: boolean
}

export type Matcher = (path: string) => boolean

const MAGIC = /[*?[\]{}]/

/** True when the pattern contains anything a literal path would not. */
export function hasMagic(pattern: string): boolean {
  return MAGIC.test(pattern) || pattern.includes("\\")
}

/**
 * The leading DIRECTORY segments of a pattern that contain no magic — where a scan can start
 * walking instead of at the root. `src/**\/*.ts` → `["src"]`; `**\/*.ts` → `[]`; `a/b.txt` → `["a"]`.
 * A pattern with brace alternatives at the top level answers the empty prefix rather than a wrong
 * one.
 */
export function staticPrefix(pattern: string): ReadonlyArray<string> {
  const alternatives = expandBraces(pattern)
  if (alternatives.length !== 1) return []
  const segments = splitSegments(alternatives[0]!)
  const out: string[] = []
  // The last segment names the entry itself, never a directory to start in.
  for (const segment of segments.slice(0, -1)) {
    if (segment.length === 0 || hasMagic(segment)) break
    out.push(segment)
  }
  return out
}

/** True when some segment is a bare `**`, i.e. the pattern can reach any depth. */
export function hasGlobstar(pattern: string): boolean {
  return expandBraces(pattern).some((alternative) => splitSegments(alternative).includes("**"))
}

const cache = new Map<string, Matcher>()
const CACHE_MAX = 256

/** A compiled matcher for `pattern`. Cached by pattern and options; the cache is bounded. */
export function compile(pattern: string, options: Options = {}): Matcher {
  const dot = options.dot === true
  const nocase = options.nocase === true
  const key = `${dot ? "d" : "-"}${nocase ? "i" : "-"} ${pattern}`
  const held = cache.get(key)
  if (held) return held
  const alternatives = expandBraces(pattern).map((alternative) => compileOne(alternative, dot, nocase))
  const matcher: Matcher = (path) => alternatives.some((match) => match(path))
  cache.set(key, matcher)
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  return matcher
}

/** One-shot `compile(pattern, options)(path)`. */
export function match(pattern: string, path: string, options: Options = {}): boolean {
  return compile(pattern, options)(path)
}

// ─── brace expansion ─────────────────────────────────────────────────────────────────────────────

/**
 * `{a,b}` → `["a", "b"]`, nested and combined with the surrounding text; `{1..3}` → `1`, `2`, `3`.
 * A brace pair with neither a comma nor a range at its top level is literal. Escaped braces are
 * literal. The result keeps escapes intact for `compileOne` to interpret.
 */
export function expandBraces(pattern: string): string[] {
  const open = findBrace(pattern)
  if (open === undefined) return [pattern]
  const close = matchingClose(pattern, open)
  if (close === undefined) return [pattern]
  const before = pattern.slice(0, open)
  const body = pattern.slice(open + 1, close)
  const after = pattern.slice(close + 1)
  const parts = splitTopLevel(body)
  const range = parts.length === 1 ? numericRange(parts[0]!) : undefined
  if (parts.length === 1 && range === undefined) {
    // Literal braces: keep them, escaped so `compileOne` never re-reads them as syntax.
    return expandBraces(after).map((rest) => `${before}\\{${body}\\}${rest}`)
  }
  const middles = range ?? parts.flatMap((part) => expandBraces(part))
  const rests = expandBraces(after)
  const out: string[] = []
  for (const middle of middles) for (const rest of rests) out.push(`${before}${middle}${rest}`)
  return out
}

function findBrace(pattern: string): number | undefined {
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === "\\") {
      i++
      continue
    }
    if (ch === "{") return i
  }
  return undefined
}

function matchingClose(pattern: string, open: number): number | undefined {
  let depth = 0
  for (let i = open; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === "\\") {
      i++
      continue
    }
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return i
    }
  }
  return undefined
}

function splitTopLevel(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ""
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!
    if (ch === "\\") {
      current += ch + (body[i + 1] ?? "")
      i++
      continue
    }
    if (ch === "{") depth++
    else if (ch === "}") depth--
    if (ch === "," && depth === 0) {
      parts.push(current)
      current = ""
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts
}

function numericRange(part: string): string[] | undefined {
  const m = /^(-?\d+)\.\.(-?\d+)$/.exec(part)
  if (!m) return undefined
  const from = Number(m[1])
  const to = Number(m[2])
  const step = from <= to ? 1 : -1
  const out: string[] = []
  for (let n = from; step > 0 ? n <= to : n >= to; n += step) out.push(String(n))
  return out
}

// ─── one alternative → a segment matcher ─────────────────────────────────────────────────────────

type Segment =
  | { readonly kind: "globstar" }
  | { readonly kind: "literal"; readonly text: string; readonly nocase: boolean }
  | { readonly kind: "regex"; readonly test: RegExp; readonly leadingDot: boolean }

function compileOne(pattern: string, dot: boolean, nocase: boolean): Matcher {
  // `a//b` is `a/b` (minimatch collapses a doubled separator inside a pattern); a leading or a
  // trailing empty segment is kept, because `/a` and `a/` mean something.
  const raw = splitSegments(pattern)
  const collapsed = raw.filter((segment, index) => segment.length > 0 || index === 0 || index === raw.length - 1)
  const segments = collapsed.map((segment) => compileSegment(segment, nocase))
  return (path) => matchFrom(segments, 0, path.split("/"), 0, dot)
}

/** Split on unescaped `/`. Escapes stay in the segment text. */
export function splitSegments(pattern: string): string[] {
  const out: string[] = []
  let current = ""
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!
    if (ch === "\\") {
      current += ch + (pattern[i + 1] ?? "")
      i++
      continue
    }
    if (ch === "/") {
      out.push(current)
      current = ""
      continue
    }
    current += ch
  }
  out.push(current)
  return out
}

function compileSegment(segment: string, nocase: boolean): Segment {
  if (segment === "**") return { kind: "globstar" }
  if (!hasMagic(segment)) return { kind: "literal", text: segment, nocase }
  let source = ""
  let leadingDot = false
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!
    if (i === 0 && ch === ".") leadingDot = true
    if (ch === "\\") {
      const next = segment[i + 1]
      if (next !== undefined) {
        if (i === 0 && next === ".") leadingDot = true
        source += escapeRegex(next)
        i++
      } else source += "\\\\"
      continue
    }
    if (ch === "*") {
      source += "[^/]*"
      continue
    }
    if (ch === "?") {
      source += "[^/]"
      continue
    }
    if (ch === "[") {
      const cls = characterClass(segment, i)
      if (cls !== undefined) {
        source += cls.source
        i = cls.end
        continue
      }
      source += "\\["
      continue
    }
    source += escapeRegex(ch)
  }
  return { kind: "regex", test: new RegExp(`^${source}$`, nocase ? "i" : ""), leadingDot }
}

const POSIX_CLASSES: Record<string, string> = {
  alnum: "a-zA-Z0-9",
  alpha: "a-zA-Z",
  digit: "0-9",
  lower: "a-z",
  upper: "A-Z",
  space: " \\t\\r\\n\\v\\f",
  blank: " \\t",
  punct: "!-\\/:-@\\[-`{-~",
  xdigit: "0-9A-Fa-f",
  word: "\\w",
}

/** A bracket expression starting at `open`, or undefined when it never closes (then `[` is literal). */
function characterClass(segment: string, open: number): { source: string; end: number } | undefined {
  let i = open + 1
  let negated = false
  if (segment[i] === "!" || segment[i] === "^") {
    negated = true
    i++
  }
  let body = ""
  let first = true
  for (; i < segment.length; i++) {
    const ch = segment[i]!
    if (ch === "]" && !first) return { source: `[${negated ? "^" : ""}${body}]`, end: i }
    first = false
    if (ch === "[" && segment[i + 1] === ":") {
      const close = segment.indexOf(":]", i + 2)
      const name = close === -1 ? undefined : segment.slice(i + 2, close)
      if (name !== undefined && name in POSIX_CLASSES) {
        body += POSIX_CLASSES[name]
        i = close + 1
        continue
      }
    }
    if (ch === "\\") {
      body += "\\" + (segment[i + 1] ?? "\\")
      i++
      continue
    }
    if (ch === "]" || ch === "^" || ch === "\\") body += "\\" + ch
    else body += ch
  }
  return undefined
}

function escapeRegex(ch: string): string {
  return /[.*+?^${}()|[\]\\/]/.test(ch) ? `\\${ch}` : ch
}

/** minimatch's dot rule: without `dot`, a `.`-led path segment only matches a `.`-led pattern segment. */
function segmentMatches(segment: Segment, part: string, dot: boolean): boolean {
  switch (segment.kind) {
    case "literal":
      return segment.nocase ? segment.text.toLowerCase() === part.toLowerCase() : segment.text === part
    case "regex":
      if (!dot && part.startsWith(".") && !segment.leadingDot) return false
      return segment.test.test(part)
    case "globstar":
      return dot || !part.startsWith(".")
  }
}

function matchFrom(
  segments: ReadonlyArray<Segment>,
  i: number,
  parts: ReadonlyArray<string>,
  j: number,
  dot: boolean,
): boolean {
  if (i === segments.length) return j === parts.length
  const segment = segments[i]!
  if (segment.kind === "globstar") {
    // A TRAILING `**` stands for "something beneath": `a/**` matches `a/x` and `a/` but not `a`
    // itself, which is what makes an exclusion's `<dir>/**` rule directory-only and lets `a/**/b`
    // still match `a/b`. So the zero-segment reading is only for a `**` that is not last.
    const trailing = i === segments.length - 1
    if (!trailing && matchFrom(segments, i + 1, parts, j, dot)) return true
    // One more segment, as long as it is not a hidden segment `**` may not cross.
    if (j < parts.length && segmentMatches(segment, parts[j]!, dot)) {
      return trailing
        ? matchFrom(segments, i + 1, parts, j + 1, dot) || matchFrom(segments, i, parts, j + 1, dot)
        : matchFrom(segments, i, parts, j + 1, dot)
    }
    return false
  }
  if (j >= parts.length) return false
  return segmentMatches(segment, parts[j]!, dot) && matchFrom(segments, i + 1, parts, j + 1, dot)
}
