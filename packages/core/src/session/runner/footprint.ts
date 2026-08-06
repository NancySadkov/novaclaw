export * as RequestFootprint from "./footprint"

import type { Message } from "@novaclaw/llm"
import { Token } from "../../util/token"

/**
 * How big is this turn's request, and which part of it grew? — a per-turn, CONTENT-FREE measurement.
 *
 * 🔴 **Why this exists, from a case that had just happened.** On 2026-08-06 the `computer` tool's
 * schema was costing ~2.4 KB of EVERY request in EVERY session, to advertise a capability that is
 * unconfigured on most machines and so could not run at all. Nothing reported that. It surfaced only
 * because an unrelated change pushed a test over a 32 KB ceiling, and the ceiling's first lesson to
 * its author is "trim 148 bytes and move on" — the 2,400-byte question is one nobody is prompted to
 * ask. A ceiling fires once, at the boundary; a per-turn number makes growth visible while it is
 * still small, which is the only time it is cheap to fix.
 *
 * ⚠️ **CONTENT-FREE is the requirement, not a nicety.** Every field here is a NUMBER. The one string
 * is `largestTool.name`, and that is deliberate — a size with no name is an alarm with no address —
 * but it means exactly one class of user-authored text can appear: the name of a tool created through
 * `define_tool`. Nothing else in this output can carry a prompt, a file, a transcript or a secret,
 * and `content-free.test.ts` is the mechanical check that keeps it that way.
 *
 * ⚠️ **These are LOGICAL bytes, not wire bytes, and the difference is not small.** This measures the
 * `LLMRequest` — before protocol lowering, before schema projection for a model's compatibility
 * quirks, before transport framing. The real OpenAI-compatible body for a literal `hi` measured
 * 47,104 bytes when this layer would have reported less. So: **compare these numbers to each other,
 * across turns, never to a provider's byte count.** They answer "what grew and by how much", which is
 * the question, and they do it in the one place that knows the whole request.
 */

/** The pieces of a request this measures. Structural on purpose — it borrows no protocol's shape. */
export interface Input {
  readonly system: ReadonlyArray<{ readonly text?: string }>
  readonly messages: ReadonlyArray<Message>
  readonly tools: ReadonlyArray<{ readonly name?: string }>
}

export interface Footprint {
  readonly totalBytes: number
  readonly systemBytes: number
  readonly messageBytes: number
  readonly toolBytes: number
  readonly systemPartCount: number
  readonly messageCount: number
  readonly toolCount: number
  /**
   * Share of the request the TOOL schemas occupy, 0–100, rounded.
   *
   * The headline number, because it is the one that goes wrong quietly. Messages growing is a
   * conversation getting longer — expected, and compaction already owns it. Tools growing is a
   * fixed cost added to every future turn by a change made somewhere else entirely.
   */
  readonly toolSharePercent: number
  /** ⚠️ `Token.estimate` — the ONE shared heuristic, not a tokenizer. Trend only. */
  readonly estimatedTokens: number
  /**
   * The single largest tool schema, so the number has an address.
   *
   * ⚠️ The only field that can carry a user-authored string (a `define_tool` name). Everything else
   * is numeric.
   */
  readonly largestTool?: { readonly name: string; readonly bytes: number }
}

/**
 * `JSON.stringify` can throw on a cycle and returns `undefined` for `undefined`.
 *
 * ⚠️ A diagnostic that throws takes down the turn it was measuring, which trades a real conversation
 * for a number nobody asked for. Every failure here degrades to 0 and the reading stays honest by
 * being low rather than absent.
 */
const bytesOf = (value: unknown): number => {
  try {
    const json = JSON.stringify(value)
    return json === undefined ? 0 : Buffer.byteLength(json, "utf8")
  } catch {
    return 0
  }
}

/** Tool NAMES only, never descriptions or schemas — see the content-free note above. */
const nameOf = (tool: { readonly name?: string }): string => tool.name ?? "(unnamed)"

/**
 * Sum of the ELEMENTS, not the serialized array.
 *
 * 🔴 **The first draft measured `JSON.stringify(section)` and its own test refuted it.** An empty
 * array serialises to `"[]"` — 2 bytes — so a request with nothing in it reported **33% tools**, and
 * every real reading carried a constant skew of brackets and commas. Punctuation is not content, and
 * a diagnostic whose zero is not zero cannot be trusted at any other value.
 *
 * The trade is deliberate: these no longer sum to the byte length of the serialized request. They
 * were never wire bytes (see the header) and a per-element sum is the more honest thing to compare
 * across turns — it moves when the request's CONTENT moves, and not otherwise.
 */
const sumBytes = (elements: ReadonlyArray<unknown>): number =>
  elements.reduce<number>((total, element) => total + bytesOf(element), 0)

export const measure = (input: Input): Footprint => {
  const systemBytes = sumBytes(input.system)
  const messageBytes = sumBytes(input.messages)
  const toolBytes = sumBytes(input.tools)
  const totalBytes = systemBytes + messageBytes + toolBytes

  let largestTool: Footprint["largestTool"]
  for (const tool of input.tools) {
    const bytes = bytesOf(tool)
    if (largestTool === undefined || bytes > largestTool.bytes) largestTool = { name: nameOf(tool), bytes }
  }

  return {
    totalBytes,
    systemBytes,
    messageBytes,
    toolBytes,
    systemPartCount: input.system.length,
    messageCount: input.messages.length,
    toolCount: input.tools.length,
    // Guard the divide: a request with no parts at all is a legitimate state during boot probes, and
    // NaN in a log attribute is worse than 0 — it renders, it sorts, and it means nothing.
    toolSharePercent: totalBytes === 0 ? 0 : Math.round((toolBytes / totalBytes) * 100),
    estimatedTokens: Token.estimateFromChars(totalBytes),
    ...(largestTool === undefined ? {} : { largestTool }),
  }
}

/**
 * The footprint as log attributes — **numbers only, so the event is `content: "none"` and may
 * egress.**
 *
 * 🔴 **`largestTool.name` is deliberately NOT here, and the reason is the log-events contract rather
 * than caution.** `log-events.ts` classes every attribute, and `derivedContent()` computes an event's
 * content class from those classes so intent cannot diverge from fact. A tool name would have to be
 * declared `id` — "an identifier we minted, or a value from a closed vocabulary" — and that would be
 * a false claim: a tool created through `define_tool` carries a USER-AUTHORED name. Declaring it
 * `text` instead is honest but makes the whole event non-egressable, which destroys the point of a
 * growth trend nobody can look at.
 *
 * So the struct is richer than the event, on purpose. The name is available in-process, to whatever
 * renders the footprint locally; the wire carries the sizes. If the name is ever wanted in telemetry,
 * the way to get it is to emit it only when it matches the closed set of registered core tool names —
 * making it genuinely an `id` — and not by reclassifying an open one.
 *
 * ⚠️ Flat, dotted, and a FIXED set of keys — every attribute is always present, `largest.bytes`
 * included, falling to 0 when the request carries no tools at all. A nested object silently becomes
 * `[object Object]` at the sink, and an attribute that comes and goes breaks the naive `grep`/`cut`
 * mining `log-events.ts` exists to keep working: a column that is absent on some lines shifts every
 * column after it.
 */
export const attributes = (footprint: Footprint) => ({
  "request.bytes.total": footprint.totalBytes,
  "request.bytes.system": footprint.systemBytes,
  "request.bytes.messages": footprint.messageBytes,
  "request.bytes.tools": footprint.toolBytes,
  "request.count.system": footprint.systemPartCount,
  "request.count.messages": footprint.messageCount,
  "request.count.tools": footprint.toolCount,
  "request.tools.share.percent": footprint.toolSharePercent,
  "request.tokens.estimated": footprint.estimatedTokens,
  "request.tools.largest.bytes": footprint.largestTool?.bytes ?? 0,
})
