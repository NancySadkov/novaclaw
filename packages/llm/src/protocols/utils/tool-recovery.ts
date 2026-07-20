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
  // A derailed model prefixes the vocabulary word: `tool_write` -> `write` (observed live).
  // Only applies when the remainder resolves against the whitelist, so it can never invent.
  if (/^tool[_-]/i.test(scrubbed)) {
    const stripped = resolveToolName(scrubbed.replace(/^tool[_-]/i, ""), names)
    if (stripped) return stripped
  }
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

// XML-ish: `<read><filePath>x</filePath></read>`, plus the qwen3_coder shapes the server
// parser misses when the wrapper is malformed: `<function=write>` openers and
// `<parameter=path>value</parameter>` children (observed live: a bare
// `<write><parameter=path>…</parameter></write>` streamed as text). The OUTER tag must
// resolve to an allowed tool name AND carry parameter children — otherwise it is just
// prose / code with angle brackets and we leave it alone. Returns the first such call.
function recoverXml(text: string, names: ReadonlyArray<string>): RecoveredCall[] {
  // `<|` openers: a derailed model fuses its special-token prefix onto the tag
  // (`<|bash><|command>…</|command>`, observed live) — tolerate the pipe everywhere.
  const opening = /<\|?(?:function=)?([A-Za-z_][\w\-.]*)\s*>/g
  let match: RegExpExecArray | null
  while ((match = opening.exec(text))) {
    const raw = match[1]
    const name = resolveToolName(raw, names)
    if (!name) continue
    let body = text.slice(match.index + match[0].length)
    const viaFunction = match[0].includes("function=")
    const closing = new RegExp(`</\\|?${viaFunction ? "function" : escapeRegExp(raw)}\\s*>`).exec(body)
    if (closing) body = body.slice(0, closing.index)
    const args: Record<string, string> = {}
    let pm: RegExpExecArray | null
    // qwen3_coder form first — its param NAME lives in the tag (`<parameter=path>`), so the
    // generic same-tag-closes pattern below can never match it.
    const paramEq = /<\|?parameter=([A-Za-z_][\w\-.]*)\s*>([\s\S]*?)(?:<\/\|?parameter\s*>|$)/g
    while ((pm = paramEq.exec(body))) args[pm[1]] = pm[2].trim()
    if (Object.keys(args).length === 0) {
      const param = /<\|?([A-Za-z_][\w\-.]*)\s*>([\s\S]*?)<\/\|?\1\s*>/g
      while ((pm = param.exec(body))) args[pm[1]] = pm[2].trim()
    }
    if (Object.keys(args).length === 0) {
      // Mismatched close tags (`<file_path>…</file_content>`, observed live): inside an
      // already-whitelisted call block, accept `<tag>value</whatever>` pairs — the outer
      // name gate has done the safety work by this point.
      const sloppy = /<([A-Za-z_][\w\-.]*)\s*>([\s\S]*?)<\/[A-Za-z_][\w\-.]*\s*>/g
      while ((pm = sloppy.exec(body))) args[pm[1]] = pm[2].trim()
    }
    if (Object.keys(args).length === 0) continue
    return [{ name, arguments: JSON.stringify(args) }]
  }
  return []
}

// Paren-call syntax: `write(path="a", content="b")` — qwen falls back to this prose-ish
// form when its structured emission derails (observed live wrapped in MTP mask tokens).
// Whitelist-gated AND every argument must be a fully-quoted key="value" pair with nothing
// else between the parens, so `call write(path, content)` in prose never matches.
function recoverCallSyntax(text: string, names: ReadonlyArray<string>): RecoveredCall[] {
  const call = /\b([A-Za-z_][\w\-.]*)\s*\(\s*([^()]*?)\s*\)/g
  let match: RegExpExecArray | null
  while ((match = call.exec(text))) {
    const name = resolveToolName(match[1], names)
    if (!name) continue
    const inner = match[2]
    if (!inner.trim()) continue
    const pair = /([A-Za-z_][\w\-.]*)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g
    const args: Record<string, string> = {}
    let pm: RegExpExecArray | null
    while ((pm = pair.exec(inner))) {
      const quoted = pm[2]
      args[pm[1]] = quoted.slice(1, -1).replace(/\\(.)/g, "$1")
    }
    if (Object.keys(args).length === 0) continue
    // Everything between the parens must be consumed by pairs + separators — leftovers
    // mean this was prose or code, not a call.
    const leftover = inner.replace(pair, "").replace(/[,\s]/g, "")
    if (leftover.length > 0) continue
    return [{ name, arguments: JSON.stringify(args) }]
  }
  return []
}

// Drop doubled identical calls — a model that emits the SAME (name, arguments) twice in
// one dump meant it once. Different args (e.g. read a, read b) are preserved.
function dedupeCalls(calls: RecoveredCall[]): RecoveredCall[] {
  const seen = new Set<string>()
  return calls.filter((call) => {
    const key = `${call.name} ${call.arguments}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Pull tool calls out of assistant text. Returns `[]` when nothing structured is
 * present (the common case) or when there is no allowed-tool set to validate
 * against — we NEVER guess a call from unconstrained text.
 */
export function recoverToolCallsFromText(text: string, names: ReadonlyArray<string>): RecoveredCall[] {
  if (names.length === 0 || !text) return []
  // MTP mask special tokens (`<|mask_start|>`, `<|mask_end|>`) leak into text around
  // structural boundaries and hide an otherwise-recoverable call — strip them for RECOVERY
  // only (the displayed text upstream is untouched). ONLY the mask pair: harmony channel
  // tokens inside hermes names are scrubName's job, and a blanket `<|…|>` strip would
  // corrupt them before it runs.
  const cleaned = text.replace(/<\|mask_[a-z]+\|>/g, " ")
  const hermes = recoverHermes(cleaned, names)
  if (hermes.length > 0) return dedupeCalls(hermes)
  const bare = recoverBareJson(cleaned, names)
  if (bare.length > 0) return dedupeCalls(bare)
  const xml = recoverXml(cleaned, names)
  if (xml.length > 0) return dedupeCalls(xml)
  return dedupeCalls(recoverCallSyntax(cleaned, names))
}
