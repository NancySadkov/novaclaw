export * as SessionExtract from "./extract"

import { createHash } from "node:crypto"
import type { SessionMessage } from "../message"

// Auto-extraction (notes/kb-graph-plan.md §1.3.3): at each drain end a model pass reads the latest
// exchange and records durable facts into SESSION-scope memory (staged), so memory fills WITHOUT the
// agent calling `remember`. Pure helpers here (the runner does the model call + the writes). Idempotent
// by content hash — re-extracting the same fact collides on id and dedups. Extracted memory is imperfect
// → always `staged` + provenance (§4.6), never masquerading as curated.

// `name` is the graph NODE's identity, so its wording is load-bearing twice over: vague names cannot be
// linked (stage 2 below picks endpoints from these) and cannot match across sessions. Measured
// 2026-07-20 (tests/kb-relation-extraction-eval.ts): the earlier "<short subject>" wording produced
// "User Identity" / "Employment" / "Sofia's Responsibility", capping linkable pairs at 5%; demanding a
// CONCRETE thing copied from the conversation lifted that ceiling to 76% with entity recall unchanged
// at 100%. Do not soften this back into a generic "subject" without re-running that gate.
export const SYSTEM =
  "You extract durable MEMORIES from a conversation for later recall. Output ONLY a JSON array of " +
  'objects like {"name":"<the specific thing this fact is ABOUT>","text":"<one standalone fact worth ' +
  'remembering>"}. The `name` must be the CONCRETE thing itself, copied from the conversation as it ' +
  "appears there — a person, company, place, product, technology, or a named service or component " +
  '(e.g. "Acme Robotics", "Berlin", "TypeScript", "the auth service"). NEVER write a role, a ' +
  'possessive, or a description as the name (not "User\'s Role", not "Employment", not "Sofia\'s ' +
  'Responsibility") — name the thing, not its relationship to someone. Emit a SEPARATE object for ' +
  "EVERY such thing the conversation mentions, including ones mentioned only in passing. Record " +
  "lasting facts about the user, their preferences, their projects, the people and things they " +
  "mention, and decisions made — anything useful to recall in a FUTURE, unrelated conversation. Write " +
  "each `text` as a self-contained sentence that makes sense with no other context. EXCLUDE greetings, " +
  "momentary task chatter, the user's questions, and anything ephemeral. If nothing is worth " +
  "remembering, output exactly []."

// Stage 2 — RELATIONSHIPS (KB-D (a)). A second pass over the same exchange that links only among the
// names stage 1 produced. The list is CLOSED on purpose: handing the model a fixed set to choose from
// beats trusting it to re-derive names, and anything off-list is dropped mechanically before any write,
// so an auto-extracted edge can never dangle. MEASURED N=5 (same eval): writable pair recall 57% vs 30%
// for a one-shot entities+links prompt, 0 spurious links across 25 co-occurring-but-unrelated pairs
// (incl. an explicitly negated relation), 1/43 dangling. Without edges the graph accumulates
// disconnected nodes and the multi-hop win (P7a: graph 100% vs flat 13%) never materialises.
export const LINK_SYSTEM =
  "You connect already-extracted facts from a conversation. You are given the conversation and a LIST " +
  "OF SUBJECTS that were extracted from it. Output ONLY a JSON array of links like " +
  '[{"from":"<a subject from the list>","to":"<a DIFFERENT subject from the list>",' +
  '"type":"<short verb phrase, e.g. works_at>"}]. RULES: (1) `from` and `to` must be COPIED EXACTLY ' +
  "from the list — never invent a name, never write a role or description, never use a subject that is " +
  "not on the list. (2) Only link two subjects when the conversation actually states a relationship " +
  "between them. (3) Do not link a subject to itself. If no two subjects on the list are related, " +
  "output exactly []."

/** The stage-2 user message: the same exchange stage 1 saw, plus the closed list of its names. */
export const buildLinkPrompt = (exchange: string, names: ReadonlyArray<string>): string =>
  `${exchange}\n\nSUBJECTS:\n${names.map((n) => `- ${n}`).join("\n")}`

export interface Extracted {
  readonly name?: string
  readonly text: string
}

/** Serialize the latest exchange (the last user message + the assistant text that followed it) as the
 *  extraction input. Undefined if there's no user message to anchor on. */
export const buildExchange = (context: ReadonlyArray<SessionMessage.Message>): string | undefined => {
  let userText: string | undefined
  const assistantMessages: string[] = []
  for (let i = context.length - 1; i >= 0; i--) {
    const message = context[i]
    if (message.type === "assistant") {
      const parts: string[] = []
      for (const part of message.content) if (part.type === "text" && part.text) parts.push(part.text)
      if (parts.length) assistantMessages.unshift(parts.join(" ")) // whole message, kept in forward order
    } else if (message.type === "user") {
      userText = message.text?.trim()
      break
    }
  }
  if (!userText) return undefined
  const lines = [`User: ${userText}`]
  const assistant = assistantMessages.join(" ").replace(/\s+/g, " ").trim()
  if (assistant) lines.push(`Assistant: ${assistant}`)
  return lines.join("\n")
}

/** Parse the model's output into facts. Tolerant: strips ``` fences and any prose around the JSON
 *  array, keeps only well-formed {text} entries, trims + caps. Never throws. */
export const parseExtraction = (raw: string, max = 10): Extracted[] => {
  const stripped = raw.replace(/```(?:json)?/gi, "").trim()
  const start = stripped.indexOf("[")
  const end = stripped.lastIndexOf("]")
  if (start < 0 || end <= start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: Extracted[] = []
  const seen = new Set<string>()
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue
    const text = typeof (item as { text?: unknown }).text === "string" ? (item as { text: string }).text.trim() : ""
    if (text.length < 3) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const nameRaw = (item as { name?: unknown }).name
    const name = typeof nameRaw === "string" && nameRaw.trim() ? nameRaw.trim() : undefined
    out.push(name === undefined ? { text } : { name, text })
    if (out.length >= max) break
  }
  return out
}

export interface ExtractedLink {
  /** Canonical name from the supplied list — NOT the model's spelling. */
  readonly from: string
  readonly to: string
  readonly type: string
}

/** Resolve a model-written endpoint against the closed list. Case-insensitive exact match first, then
 *  containment both ways so "Acme" ↔ "Acme Robotics" still lands. Undefined = off-list ⇒ the link is
 *  dropped rather than written as a dangling edge. */
const resolveName = (raw: unknown, names: ReadonlyArray<string>): string | undefined => {
  if (typeof raw !== "string") return undefined
  const needle = raw.trim().toLowerCase()
  if (!needle) return undefined
  const exact = names.find((n) => n.toLowerCase() === needle)
  if (exact) return exact
  return names.find((n) => n.toLowerCase().includes(needle) || needle.includes(n.toLowerCase()))
}

/** Normalize a relation label into a compact edge type. Free-form model wording ("is the manager of")
 *  becomes `is_the_manager_of`; anything unusable falls back to `related_to` so an edge with a good
 *  pair is never lost to a bad label. */
const linkType = (raw: unknown): string => {
  if (typeof raw !== "string") return "related_to"
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
  return cleaned.length === 0 ? "related_to" : cleaned.slice(0, 40)
}

/** Parse stage 2's output into links whose endpoints are CANONICAL names from `names`. Tolerant like
 *  parseExtraction (strips fences/prose). Drops: malformed entries, off-list endpoints (the dangling
 *  guard), self-links, and duplicate pairs. Never throws. */
export const parseLinks = (raw: string, names: ReadonlyArray<string>, max = 20): ExtractedLink[] => {
  if (names.length < 2) return []
  const stripped = raw.replace(/```(?:json)?/gi, "").trim()
  const start = stripped.indexOf("[")
  const end = stripped.lastIndexOf("]")
  if (start < 0 || end <= start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: ExtractedLink[] = []
  const seen = new Set<string>()
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue
    const from = resolveName((item as { from?: unknown }).from, names)
    const to = resolveName((item as { to?: unknown }).to, names)
    if (from === undefined || to === undefined || from === to) continue
    const key = `${from} ${to}`.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ from, to, type: linkType((item as { type?: unknown }).type) })
    if (out.length >= max) break
  }
  return out
}

/** Deterministic id from scope + normalized text → idempotent: re-extracting the same fact yields the
 *  same id, so the CREATE collides and the write is a no-op (dedup). */
export const memoryID = (scope: string, text: string): string =>
  "mem_x" + createHash("sha256").update(`${scope}\n${text.trim().toLowerCase()}`).digest("hex").slice(0, 24)
