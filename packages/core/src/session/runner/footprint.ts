export * as RequestFootprint from "./footprint"

import type { Message } from "@novaclaw/llm"
import { Token } from "../../util/token"
import { MediaSize } from "./media-size"

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
  /**
   * ⚠️ `Token.estimate` — the ONE shared heuristic, not a tokenizer. Trend only.
   * ⚠️ **Text only.** Base64 media payloads are excluded — see `mediaCount` and `mediaFreeJson`.
   */
  readonly estimatedTokens: number
  /**
   * How many base64 media payloads the messages carry.
   *
   * A COUNT, not a size, because the size is the wrong unit: an image's cost is set by its pixels
   * and the model's patch size, and its base64 length predicts neither. Numeric, so the
   * content-free contract is unaffected.
   */
  readonly mediaCount: number
  /**
   * Total PIXELS across those payloads — the unit an image's cost is actually in.
   *
   * 🔴 Measured 2026-08-19 on `holo3.1`: `tokens = 2 + max(64, floor(w/32) × floor(h/32))`, exact on
   * ten sizes, and IDENTICAL for a 2–3× larger file at the same dimensions. So pixels are the fact
   * and bytes are noise. ⚠️ The divisor (32 there) is a property of the MODEL, so it is deliberately
   * not applied here — this reports what the request carries, not what a particular model will
   * charge for it. 0 when nothing could be read: an unparsed container adds nothing rather than a
   * false zero-sized image.
   */
  readonly mediaPixels: number
  /**
   * The single largest tool schema, so the number has an address.
   *
   * ⚠️ The only field that can carry a user-authored string (a `define_tool` name). Everything else
   * is numeric.
   */
  readonly largestTool?: { readonly name: string; readonly bytes: number }
}

/**
 * How many characters a base64 `data:` payload contributes to the PROSE estimate: none.
 *
 * 🔴 **Measured 2026-08-19** (`notes/reports/vision-on-disk-2026-08-19.md`). The first run in which
 * a model actually read a folder of images grew this estimate by **~2,890 tokens per glyph** while
 * the server charged **~66** — the payload was being counted as if it were text, ~40× over. It is
 * not text: a vision model turns an image into patches, and the count depends on its pixels and the
 * model's patch size, not on how many characters its base64 spelling takes.
 *
 * ⚠️ **Excluded rather than estimated, and that is the honest choice.** Two measured points
 * (7.9 KB → 66 tokens, 718 KB → 2,302) do not establish a law — they do not even agree on a
 * bytes-per-token ratio — and this file's own history says what a wrong-by-construction reading
 * costs: the first draft measured `JSON.stringify(section)` and reported 33% tools for an empty
 * request, because "a diagnostic whose zero is not zero cannot be trusted at any other value." A
 * 40× skew is that failure at the other end of the scale. So the payload leaves the prose number and
 * arrives as its own COUNT, which is a fact we actually have.
 *
 * ⚠️ **What this changes downstream, stated rather than discovered later:** `ProjectGrounding.decide`
 * keys its cadence on `estimatedTokens`, so a visual session now re-grounds LESS often than it did
 * this morning. That is the correct direction — it was re-grounding on phantom growth — but it does
 * mean image growth is currently invisible to that trigger. Giving images a real cost needs a
 * per-model token rule, which is unbuilt and not a number to guess here.
 */
const DATA_URI = /"(data:[^";,]*;base64,[A-Za-z0-9+/=]+)"/g
const mediaFreeJson = (json: string): { readonly text: string; readonly media: number; readonly pixels: number } => {
  let media = 0
  let pixels = 0
  const text = json.replace(DATA_URI, (_match, uri: string) => {
    media++
    // ⚠️ `undefined` — a container we do not parse, a truncated header — adds NOTHING rather than
    // zero. A total that silently absorbed unreadable images would understate by an unknown amount
    // while looking precise, which is the failure this whole file is a monument to.
    pixels += MediaSize.pixelsFromDataUri(uri) ?? 0
    return '""'
  })
  return { text, media, pixels }
}

/** Bytes with every base64 `data:` payload removed, plus how many there were and their pixels. */
const measureValue = (
  value: unknown,
): { readonly bytes: number; readonly media: number; readonly pixels: number } => {
  try {
    const json = JSON.stringify(value)
    if (json === undefined) return { bytes: 0, media: 0, pixels: 0 }
    const stripped = mediaFreeJson(json)
    return { bytes: Buffer.byteLength(stripped.text, "utf8"), media: stripped.media, pixels: stripped.pixels }
  } catch {
    return { bytes: 0, media: 0, pixels: 0 }
  }
}

/** Tool NAMES only, never descriptions or schemas — see the content-free note above. */
const nameOf = (tool: { readonly name?: string }): string => tool.name ?? "(unnamed)"

/**
 * Measure each element once. Keeping the result lets callers report both bytes and media facts
 * without serializing the same message again for the second projection.
 */
type ElementMeasurement = { readonly bytes: number; readonly media: number; readonly pixels: number }

const measureElements = (elements: ReadonlyArray<unknown>): ElementMeasurement =>
  elements.reduce<ElementMeasurement>(
    (total, element) => {
      const measured = measureValue(element)
      return {
        bytes: total.bytes + measured.bytes,
        media: total.media + measured.media,
        pixels: total.pixels + measured.pixels,
      }
    },
    { bytes: 0, media: 0, pixels: 0 },
  )

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
export const measure = (input: Input): Footprint => {
  const system = measureElements(input.system)
  const messages = measureElements(input.messages)
  const tools = input.tools.map((tool) => ({ tool, measured: measureValue(tool) }))
  const systemBytes = system.bytes
  const messageBytes = messages.bytes
  const toolBytes = tools.reduce((total, entry) => total + entry.measured.bytes, 0)
  const totalBytes = systemBytes + messageBytes + toolBytes
  let largestTool: Footprint["largestTool"]
  for (const entry of tools) {
    const bytes = entry.measured.bytes
    if (largestTool === undefined || bytes > largestTool.bytes) largestTool = { name: nameOf(entry.tool), bytes }
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
    mediaCount: messages.media,
    mediaPixels: messages.pixels,
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
  "request.count.media": footprint.mediaCount,
  "request.media.pixels": footprint.mediaPixels,
  "request.tools.largest.bytes": footprint.largestTool?.bytes ?? 0,
})
