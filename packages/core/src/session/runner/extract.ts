export * as SessionExtract from "./extract"

import { createHash } from "node:crypto"
import type { SessionMessage } from "../message"

// Auto-extraction (notes/kb-graph-plan.md §1.3.3): at each drain end a model pass reads the latest
// exchange and records durable facts into SESSION-scope memory (staged), so memory fills WITHOUT the
// agent calling `remember`. Pure helpers here (the runner does the model call + the writes). Idempotent
// by content hash — re-extracting the same fact collides on id and dedups. Extracted memory is imperfect
// → always `staged` + provenance (§4.6), never masquerading as curated.

export const SYSTEM =
  "You extract durable MEMORIES from a conversation for later recall. Output ONLY a JSON array of " +
  'objects like {"name":"<short subject>","text":"<one standalone fact worth remembering>"}. ' +
  "Record lasting facts about the user, their preferences, their projects, the people and things they " +
  "mention, and decisions made — anything useful to recall in a FUTURE, unrelated conversation. Write " +
  "each `text` as a self-contained sentence that makes sense with no other context. EXCLUDE greetings, " +
  "momentary task chatter, the user's questions, and anything ephemeral. If nothing is worth " +
  "remembering, output exactly []."

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

/** Deterministic id from scope + normalized text → idempotent: re-extracting the same fact yields the
 *  same id, so the CREATE collides and the write is a no-op (dedup). */
export const memoryID = (scope: string, text: string): string =>
  "mem_x" + createHash("sha256").update(`${scope}\n${text.trim().toLowerCase()}`).digest("hex").slice(0, 24)
