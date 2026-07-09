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
}

export type ExtractResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly failure: ExtractFailure }

interface ScanResult {
  readonly objects: ReadonlyArray<string>
  readonly sawOpenBrace: boolean
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
  return { objects, sawOpenBrace }
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

/** Try JSON.parse, then apply ONLY the two allowed repairs (rule 3), retrying after each. */
function tryParse(candidate: string): { ok: true; value: unknown } | { ok: false; error: string } {
  let lastError = ""
  try {
    return { ok: true, value: JSON.parse(candidate) }
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e)
  }
  // Repair 3b: remove trailing commas before } or ].
  const noTrailingCommas = candidate.replace(/,(\s*[}\]])/g, "$1")
  if (noTrailingCommas !== candidate) {
    try {
      return { ok: true, value: JSON.parse(noTrailingCommas) }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
    }
  }
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
      return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, failure: { reason: "invalid_json", detail: parsed.error } }
    }
  }

  // 2. Whole-text scan — the LAST balanced top-level object.
  const scan = scanBalanced(text)
  if (scan.objects.length > 0) {
    const candidate = scan.objects[scan.objects.length - 1]!
    const parsed = tryParse(candidate)
    return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, failure: { reason: "invalid_json", detail: parsed.error } }
  }

  if (scan.sawOpenBrace) {
    return { ok: false, failure: { reason: "unbalanced", detail: "found an opening brace but no balanced object" } }
  }
  return { ok: false, failure: { reason: "no_json", detail: "no JSON object found in model output" } }
}
