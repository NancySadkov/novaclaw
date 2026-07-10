export * as JhExtract from "./extract"

// jh — tolerant extraction of the model's JSON Step out of free-form prose (jh.md §3, wire-format
// mode A: reason in free text, then emit one fenced JSON object). Small models bury the object in
// reasoning, wrap it in fences, or add a trailing comma; this finds it WITHOUT ever eval-ing,
// JSON5-ing, or "healing" quotes/newlines — the only repairs are stripping fence remnants and
// trailing commas (rule 4). The brace scanner is a single linear pass so a 20k-token reply can't
// trigger catastrophic backtracking.

export interface ExtractFailure {
  readonly reason: "no_json" | "unbalanced" | "invalid_json"
  readonly detail: string
  // improve3 P2b: locate the failure so the retry reminder is actionable (not just "unparseable").
  readonly position?: number // char index into the reply (best-effort; reliable for `unbalanced`)
  readonly snippet?: string // ±80 chars of the raw reply around the failure, bounded ≤ ~200
  readonly cause?: string // a likely-cause hint the model can act on (truncation / bad escape / …)
}

export type ExtractResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly failure: ExtractFailure }

interface ScanResult {
  readonly objects: ReadonlyArray<string>
  readonly sawOpenBrace: boolean
  readonly lastOpenIndex: number // index of the last top-level `{` left unclosed (−1 if none) — for `unbalanced`
}

/** ±radius chars of `text` around `pos`, collapsed to one line, bounded to ~2·radius+ellipsis. */
function snippetAround(text: string, pos: number, radius = 80): string {
  const from = Math.max(0, pos - radius)
  const to = Math.min(text.length, pos + radius)
  const s = text.slice(from, to).replace(/\s+/g, " ").trim()
  return `${from > 0 ? "…" : ""}${s}${to < text.length ? "…" : ""}`
}

/** Build a LOCATED invalid_json failure: parser position (best-effort — V8 gives it, JSC/Bun usually doesn't),
 *  a bounded snippet of the failing object, and a likely-cause hint the model can act on. */
function invalidJsonFailure(candidate: string, error: string): ExtractFailure {
  const m = error.match(/position (\d+)/i)
  const position = m ? Number(m[1]) : undefined
  const lower = error.toLowerCase()
  const cause = lower.includes("unterminated string")
    ? 'an unescaped quote or newline inside a JSON string — escape them (\\" and \\n) and use forward slashes in paths'
    : lower.includes("escape")
      ? "an invalid backslash escape inside a JSON string — use forward slashes in paths, and write any literal backslash as \\\\"
      : lower.includes("eof") || lower.includes("end of") || lower.includes("unexpected end")
        ? "the reply looks TRUNCATED — emit a SHORTER object (fewer, higher-level steps)"
        : "malformed JSON — check for a missing comma, quote, or brace"
  return { reason: "invalid_json", detail: error, position, snippet: snippetAround(candidate, position ?? 0), cause }
}

/**
 * Single linear pass. Records every TOP-LEVEL balanced `{...}` substring in order, respecting
 * "strings" and \-escapes so braces/quotes inside string values never confuse the depth count.
 * `sawOpenBrace` distinguishes "no JSON at all" (no_json) from "opened but never balanced" (unbalanced).
 */
function scanBalanced(s: string): ScanResult {
  const objects: string[] = []
  let sawOpenBrace = false
  let depth = 0
  let start = -1
  let inString = false
  let escape = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inString) {
      if (escape) escape = false
      else if (ch === "\\") escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === "{") {
      sawOpenBrace = true
      if (depth === 0) start = i
      depth++
    } else if (ch === "}") {
      if (depth > 0) {
        depth--
        if (depth === 0 && start >= 0) {
          objects.push(s.slice(start, i + 1))
          start = -1
        }
      }
    }
  }
  // If depth > 0 at the end, `start` marks the last top-level `{` that never balanced (the truncation point).
  return { objects, sawOpenBrace, lastOpenIndex: depth > 0 ? start : -1 }
}

/** Split the text into fenced-block inner contents (``` ... ```), in document order. The balanced
 *  scanner tolerates a leading `json` language tag, so we don't strip it here. An unterminated final
 *  fence still yields its content. */
function findFences(text: string): ReadonlyArray<string> {
  const parts = text.split("```")
  const fences: string[] = []
  // Fenced contents are the odd-indexed segments (part 0 is before the first fence).
  for (let i = 1; i < parts.length; i += 2) fences.push(parts[i]!)
  return fences
}

/** Double any backslash that does NOT begin a valid JSON escape — the file-write wall (jh.md §12): weak
 *  models put code/paths in a JSON string with C escapes (`\0`, `\x41`) or Windows paths (`C:\soft`)
 *  whose `\s`/`\0`/`\x` are INVALID JSON escapes. Correctly-escaped `\\` is protected first, so it stays. */
function fixInvalidEscapes(s: string): string {
  const SENTINEL = "\x00"
  return s
    .replace(/\\\\/g, SENTINEL) // protect valid escaped backslashes
    .replace(/\\(?!["/bfnrtu])/g, "\\\\") // double stray backslashes (invalid escapes)
    .replaceAll(SENTINEL, "\\\\") // restore
}

/** Try JSON.parse, then apply tolerance repairs (jh.md §12) — trailing commas + invalid backslash
 *  escapes — retrying after each. Still NEVER: eval, JSON5, quote-style conversion, newline healing. */
function tryParse(candidate: string): { ok: true; value: unknown } | { ok: false; error: string } {
  let lastError = ""
  const tryOne = (s: string): boolean | undefined => {
    try {
      value = JSON.parse(s)
      return true
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      return undefined
    }
  }
  let value: unknown
  if (tryOne(candidate)) return { ok: true, value }
  // Repair 3b: remove trailing commas before } or ].
  const noTrailingCommas = candidate.replace(/,(\s*[}\]])/g, "$1")
  if (noTrailingCommas !== candidate && tryOne(noTrailingCommas)) return { ok: true, value }
  // Repair 3c: fix invalid backslash escapes (Windows paths / C escapes stuffed into a JSON string).
  const escaped = fixInvalidEscapes(noTrailingCommas)
  if (escaped !== noTrailingCommas && tryOne(escaped)) return { ok: true, value }
  return { ok: false, error: lastError }
}

/**
 * Find the model's JSON object in free text. Strategy, in order:
 *  1. All ```json ... ``` (or bare ```) fenced blocks — take the LAST one that yields a balanced
 *     object, and commit to it.
 *  2. Otherwise scan the whole text for the LAST balanced top-level {...}.
 *  3. Apply ONLY these repairs (retrying JSON.parse after each): strip trailing-fence/language-tag
 *     remnants (implicit — the scanner isolates pure {...}), remove trailing commas before } or ].
 *  4. Never: eval, JSON5, quote-style conversion, newline "healing".
 */
export function extractJsonObject(text: string): ExtractResult {
  // 1. Fenced blocks — the LAST fence with a balanced object wins.
  const fences = findFences(text)
  for (let i = fences.length - 1; i >= 0; i--) {
    const objects = scanBalanced(fences[i]!).objects
    if (objects.length > 0) {
      const candidate = objects[objects.length - 1]!
      const parsed = tryParse(candidate)
      return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, failure: invalidJsonFailure(candidate, parsed.error) }
    }
  }

  // 2. Whole-text scan — the LAST balanced top-level object.
  const scan = scanBalanced(text)
  if (scan.objects.length > 0) {
    const candidate = scan.objects[scan.objects.length - 1]!
    const parsed = tryParse(candidate)
    return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, failure: invalidJsonFailure(candidate, parsed.error) }
  }

  if (scan.sawOpenBrace) {
    return {
      ok: false,
      failure: {
        reason: "unbalanced",
        detail: "found an opening brace but no balanced object",
        position: scan.lastOpenIndex >= 0 ? scan.lastOpenIndex : undefined,
        snippet: snippetAround(text, text.length, 120), // the tail — where a truncated reply cut off
        cause: "the reply may be TRUNCATED — emit a SHORTER plan (fewer, higher-level steps), and make sure every { has a matching }",
      },
    }
  }
  return { ok: false, failure: { reason: "no_json", detail: "no JSON object found in model output", cause: "emit exactly ONE fenced ```json { … } ``` object and nothing after it" } }
}
