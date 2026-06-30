// Recover tool calls that small / local models emit incorrectly, so the agent loop
// keeps going instead of dropping the turn. Two pure, unit-tested concerns:
//
//   1. resolveToolName — canonicalize a model-emitted name against the allowed set
//      (scrub harmony tokens -> exact -> case-insensitive -> fuzzy), or `undefined`
//      if it looks hallucinated (caller routes to a breadcrumb, never a hard throw).
//
//   2. recoverToolCallsFromText — when a model dumps a tool call into assistant TEXT
//      instead of the structured tool_calls channel (gpt-oss / qwen / hermes do this,
//      and the client then reads it as a finished answer and STOPS), pull the call
//      back out. WHITELIST-GATED on the allowed tool names so ordinary prose or code
//      with angle brackets (C++ `<vector>`, HTML, markdown) is never misread as a call.
//
// Mirrors the rules proven in the afpro proxy. Dependency-light (only the shared JSON
// repair) so it runs inside the protocol decoder and is testable without a model.

import { isRecord, repairToolJson } from "../shared"

// 0.85 mirrors afpro's difflib cutoff: high enough that we only remap on a near-
// certain typo, never a coincidental overlap.
const FUZZY_CUTOFF = 0.85

export interface RecoveredCall {
  readonly name: string
  /** A valid compact JSON string for the tool arguments (never malformed). */
  readonly arguments: string
}

// =============================================================================
// Name resolution (A1)
// =============================================================================

/**
 * Resolve a model-emitted tool name to a real one, or `undefined` if it looks
 * hallucinated. Exact -> case-insensitive (`Write` -> `write`) -> fuzzy (a typo
 * within the cutoff), after scrubbing harmony tokens (`write<|channel|>...`).
 */
export function resolveToolName(raw: string, names: ReadonlyArray<string>): string | undefined {
  const scrubbed = scrubName(raw)
  if (names.includes(scrubbed)) return scrubbed
  const insensitive = names.find((name) => name.toLowerCase() === scrubbed.toLowerCase())
  if (insensitive) return insensitive
  return closestName(scrubbed, names)
}

/** Cut at the first harmony channel token and drop any remaining angle-bracket tags. */
export function scrubName(raw: string): string {
  return raw.split("<|")[0].replace(/<[^>]*>/g, "").trim()
}

function closestName(name: string, names: ReadonlyArray<string>): string | undefined {
  const lower = name.toLowerCase()
  let best: string | undefined
  let bestScore = 0
  for (const candidate of names) {
    const score = ratio(lower, candidate.toLowerCase())
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }
  return bestScore >= FUZZY_CUTOFF ? best : undefined
}

/** Normalized edit-distance similarity in [0,1]. */
function ratio(a: string, b: string): number {
  if (a === b) return 1
  if (a.length === 0 || b.length === 0) return 0
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length)
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = current
    }
  }
  return row[b.length]
}

// =============================================================================
// Text recovery (A2)
// =============================================================================

const tolerantJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    /* fall through to repair */
  }
  try {
    return JSON.parse(repairToolJson(raw))
  } catch {
    return undefined
  }
}

/**
 * Coerce a parsed call object's arguments to a compact JSON string, normalizing the
 * common flat hermes form (`{"name":"read","filePath":"x"}`) to its arguments
 * (`{"filePath":"x"}`) when there is no nested `arguments`/`parameters` object.
 */
function normalizeArgs(obj: Record<string, unknown>): string {
  const args = obj["arguments"]
  if (isRecord(args)) return JSON.stringify(args)
  const parameters = obj["parameters"]
  if (isRecord(parameters)) return JSON.stringify(parameters)
  const flat: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (key === "name" || key === "arguments" || key === "parameters") continue
    flat[key] = value
  }
  return JSON.stringify(flat)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// hermes / Qwen: `[preamble] <tool_call>{json}</tool_call>` — possibly unclosed,
// possibly multiple, possibly flat args. The name must resolve to an allowed tool.
function recoverHermes(text: string, names: ReadonlyArray<string>): RecoveredCall[] {
  const out: RecoveredCall[] = []
  const block = /<tool_call>\s*([\s\S]*?)(?:<\/tool_call>|$)/g
  let match: RegExpExecArray | null
  while ((match = block.exec(text))) {
    const segment = match[1]
    const open = segment.indexOf("{")
    if (open < 0) continue
    const close = segment.lastIndexOf("}")
    const obj = tolerantJson(close > open ? segment.slice(open, close + 1) : segment.slice(open))
    if (!isRecord(obj) || typeof obj["name"] !== "string") continue
    const name = resolveToolName(obj["name"], names)
    if (!name) continue
    out.push({ name, arguments: normalizeArgs(obj) })
  }
  return out
}

// bare JSON object / array carrying `"name"` as the entire message content.
function recoverBareJson(text: string, names: ReadonlyArray<string>): RecoveredCall[] {
  const trimmed = text.trim()
  if (!(trimmed.startsWith("{") || trimmed.startsWith("[")) || !trimmed.includes('"name"')) return []
  const parsed = tolerantJson(trimmed)
  const items = Array.isArray(parsed) ? parsed : isRecord(parsed) ? [parsed] : []
  const out: RecoveredCall[] = []
  for (const item of items) {
    if (!isRecord(item) || typeof item["name"] !== "string") continue
    const name = resolveToolName(item["name"], names)
    if (!name) continue
    out.push({ name, arguments: normalizeArgs(item) })
  }
  return out
}

// XML-ish: `<read><filePath>x</filePath></read>`. The OUTER tag must resolve to an
// allowed tool name AND carry `<param>value</param>` children — otherwise it is just
// prose / code with angle brackets and we leave it alone. Returns the first such call.
function recoverXml(text: string, names: ReadonlyArray<string>): RecoveredCall[] {
  const opening = /<([A-Za-z_][\w\-.]*)\s*>/g
  let match: RegExpExecArray | null
  while ((match = opening.exec(text))) {
    const raw = match[1]
    const name = resolveToolName(raw, names)
    if (!name) continue
    let body = text.slice(match.index + match[0].length)
    const closing = new RegExp(`</${escapeRegExp(raw)}\\s*>`).exec(body)
    if (closing) body = body.slice(0, closing.index)
    const args: Record<string, string> = {}
    const param = /<([A-Za-z_][\w\-.]*)\s*>([\s\S]*?)<\/\1\s*>/g
    let pm: RegExpExecArray | null
    while ((pm = param.exec(body))) args[pm[1]] = pm[2].trim()
    if (Object.keys(args).length === 0) continue
    return [{ name, arguments: JSON.stringify(args) }]
  }
  return []
}

/**
 * Pull tool calls out of assistant text. Returns `[]` when nothing structured is
 * present (the common case) or when there is no allowed-tool set to validate
 * against — we NEVER guess a call from unconstrained text.
 */
export function recoverToolCallsFromText(text: string, names: ReadonlyArray<string>): RecoveredCall[] {
  if (names.length === 0 || !text) return []
  const hermes = recoverHermes(text, names)
  if (hermes.length > 0) return hermes
  const bare = recoverBareJson(text, names)
  if (bare.length > 0) return bare
  return recoverXml(text, names)
}
