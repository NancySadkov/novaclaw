// 1M (codehamr A6) — context-window discipline: the deterministic fail-safe packing layer.
//
// THE local-model killer: Ollama-class /v1 servers report no window and on overflow silently
// FRONT-truncate — the agent loses its system prompt and earlier tool results mid-task with no
// error. Compaction (the semantic first line) needs a working summary model call; this layer is
// the zero-cost guarantee underneath it: pack every outgoing request to the server's HONORED
// window so the server never truncates for us.
//
// Pure and unit-testable (config-resolve style); the runner calls `packRequest` from request
// assembly AFTER the compaction check. History stays intact in the DB — a bigger window
// instantly restores evicted turns; no summarization happens here.
//
// What the window ALREADY SAYS goes before what is merely old: pass 1.5 eagerly collapses an exact
// repeated tool result to a one-line notice, and also reclaims safe near-duplicates on overflow
// (`context-redundancy.ts`, A2.1 ①), so a page fetched three times cannot cost the original task.
//
// The window packed to is the server's HONORED window (`model.limit.context` from config /
// catalog), NOT the model's theoretical max — qwen does 256k only if vLLM `--max-model-len` /
// OLLAMA_CONTEXT_LENGTH says so. When no window is configured we assume a conservative default:
// silently losing the system prompt is strictly worse than evicting old turns early.

import { Message } from "@novaclaw/llm"
import type { LLMRequest, SystemPart, ToolDefinition, ToolResultPart, ToolResultValue } from "@novaclaw/llm"
import type { SessionMessage } from "@novaclaw/schema/session-message"
import { Token } from "../../util/token"
import { applySteerProvenance, isSteerText } from "../steer-provenance"
import { ContextRedundancy } from "./context-redundancy"
import { ContextBudget } from "./context-budget"

export * as ContextPack from "./context-pack"

/** Safe default when the model config reports no honored window (the Ollama-class case). */
export const DEFAULT_CONTEXT_SIZE = 32_000
/** Reasoning models need room to answer: reserve max(contextSize/8, this). */
export const MIN_RESPONSE_RESERVE = 8_192
/** Flat per-tool-call token overhead the chars/4 estimate can't see (ids, wire framing). */
export const TOOL_CALL_OVERHEAD = 8
/** chars/4 UNDERcounts code/JSON-heavy history — keep 10% headroom (pack to 90% of available). */
export const BUDGET_KEEP_FRACTION = 0.9
/** ctx_pressure tripwire: reported prompt tokens at ≥95% of the window flags the estimator. */
export const PRESSURE_THRESHOLD = 0.95

const toolCallCount = (message: Message) =>
  message.content.filter((part) => part.type === "tool-call" || part.type === "tool-result").length

/** tokens(msg) ≈ chars/4 (+8 per tool call/result) — tokenizer-free by design. */
export const estimateMessage = (message: Message): number => {
  let text: string
  try {
    text = JSON.stringify(message.content) ?? ""
  } catch {
    text = String(message.content)
  }
  return Token.estimate(text) + toolCallCount(message) * TOOL_CALL_OVERHEAD
}

export const estimateMessages = (messages: ReadonlyArray<Message>): number =>
  messages.reduce((total, message) => total + estimateMessage(message), 0)

const estimateJson = (value: unknown): number => {
  try {
    return Token.estimate(JSON.stringify(value) ?? "")
  } catch {
    return 0
  }
}

/**
 * Budget = contextSize − system − tools − responseReserve − headroom.
 * Never negative — a degenerate window still packs the newest message (always kept).
 */
export const budget = (input: {
  readonly contextSize: number
  readonly system: ReadonlyArray<SystemPart>
  readonly tools: ReadonlyArray<ToolDefinition>
  readonly maxTokens?: number | undefined
}): number => {
  const systemTokens = input.system.reduce((total, part) => total + Token.estimate(part.text), 0)
  const toolTokens = estimateJson(input.tools)
  const reserve = Math.max(Math.floor(input.contextSize / 8), MIN_RESPONSE_RESERVE, input.maxTokens ?? 0)
  const available = input.contextSize - systemTokens - toolTokens - reserve
  return Math.max(0, Math.floor(available * BUDGET_KEEP_FRACTION))
}

const firstTextPart = (message: Message): string | undefined => {
  for (const part of message.content) if (part.type === "text") return part.text
  return undefined
}

/**
 * A REAL user message — not a harness steer (A1 provenance prefix) riding the user role. The
 * anchor pass and the "since last user message" semantics both key off this.
 *
 * This is the WIRE-shaped twin of `session/steer-provenance.ts`'s `isRealUserTurn`: the same
 * question asked of an `@novaclaw/llm` message, whose text lives in parts rather than a flat field.
 * It delegates to the shared `isSteerText` (B2) so only one place knows what a steer looks like.
 * Deliberately does NOT require non-empty text — an image-only user message still anchors.
 */
export const isRealUserMessage = (message: Message): boolean =>
  message.role === "user" && !isSteerText(firstTextPart(message) ?? "")

const localToolCallIds = (message: Message): string[] =>
  message.role === "assistant"
    ? message.content.flatMap((part) => (part.type === "tool-call" && part.providerExecuted !== true ? [part.id] : []))
    : []

const toolResultIds = (messages: ReadonlyArray<Message>): Set<string> => {
  const ids = new Set<string>()
  for (const message of messages) {
    if (message.role !== "tool") continue
    for (const part of message.content) if (part.type === "tool-result") ids.add(part.id)
  }
  return ids
}

/**
 * True when a stripped-down assistant remainder carries nothing the wire can render, so the
 * message must be dropped rather than sent.
 *
 * ⚠️ "Nothing meaningful" is NOT "nothing at all" — an earlier `remaining.length === 0` test was
 * the bug. `[reasoning, tool-call]` is the NORMAL assistant shape for a thinking model (our
 * canonical `dgx-spark/qwen3.6-35b` is one): `to-llm-message.ts` emits the reasoning part whenever
 * the turn came from the same model. Strip the unanswered call and a reasoning-ONLY message
 * survives the length test — chain-of-thought narrating a call and a result that have both been
 * deleted.
 *
 * ⚠️ That remainder is no longer wire-illegal on every route, and this pass is NOT redundant
 * because of it. `openai-chat` / `openai-compatible-chat` now OMIT such a message outright
 * (`packages/llm/src/protocols/openai-chat.ts` `lowerAssistantMessage`, 2026-07-31 — the drop is
 * per-wire, so it lives at the lowering, ruling 6). But `anthropic-messages`, `gemini` and
 * `bedrock-converse` all lower it to a well-formed, merely semantically-empty block, so THOSE
 * wires would still carry the orphaned narration. Keeping it off them is exactly what this pass
 * is for; the two predicates look alike and answer different questions.
 *
 * The full `ContentPart` union (`packages/llm/src/schema/messages.ts`) is
 * `text | media | tool-call | tool-result | reasoning`. Only `reasoning` is non-renderable on its
 * own, so it is the only member of the predicate — deliberately:
 *  - `text` / `tool-call` are the renderable assistant channels;
 *  - `media` is renderable content the assistant lowering explicitly reasons about (openai-chat
 *    REJECTS it loudly rather than silently emptying the message), so dropping it here would
 *    convert a visible provider error into silent data loss;
 *  - `tool-result` only lands on an assistant when `providerExecuted`, and those calls are never
 *    treated as dangling (`localToolCallIds` skips them) — keeping it is the conservative side.
 * Erring permissive (keep the message) is safer than dropping content, so nothing else is added.
 * `[].every(...)` is `true`, so this subsumes the original empty case.
 */
const rendersNothing = (parts: ReadonlyArray<Message["content"][number]>): boolean =>
  parts.every((part) => part.type === "reasoning")

/**
 * Wire-legality pass 1 — an assistant whose tool calls weren't all answered (the abort-mid-tool
 * case) 400s strict backends and wedges the session until reset. Remove the unanswered
 * ToolCallParts; drop the message entirely if nothing meaningful remains.
 */
export const dropDanglingToolCalls = (messages: ReadonlyArray<Message>): Message[] => {
  const answered = toolResultIds(messages)
  return messages.flatMap((message) => {
    const dangling = localToolCallIds(message).filter((id) => !answered.has(id))
    if (dangling.length === 0) return [message]
    const remaining = message.content.filter((part) => !(part.type === "tool-call" && dangling.includes(part.id)))
    if (rendersNothing(remaining)) return []
    return [Message.make({ ...message, content: remaining })]
  })
}

/**
 * Wire-legality pass 2 — a tool result whose owning assistant got evicted is an orphan; so is a
 * result with an empty id (an empty tool_call_id 400s the next request). Runs on the KEPT set
 * after eviction.
 */
export const dropOrphanTools = (messages: ReadonlyArray<Message>): Message[] => {
  const owned = new Set(messages.flatMap(localToolCallIds))
  return messages.filter((message) => {
    if (message.role !== "tool") return true
    return message.content.every((part) => part.type !== "tool-result" || (part.id !== "" && owned.has(part.id)))
  })
}

/**
 * Wire-legality pass 5 — a mid-history `system` message 400s some strict backends. Demote to a
 * provenance-prefixed user message. MUST run after the anchor pass, or a demoted note could
 * masquerade as the surviving user message (the prefix keeps `isRealUserMessage` false either way).
 */
export const demoteSystemMessages = (messages: ReadonlyArray<Message>): Message[] =>
  messages.map((message) => {
    if (message.role !== "system") return message
    const text = message.content.map((part) => ("text" in part ? part.text : "")).join("\n")
    return Message.make({ ...message, role: "user", content: [Message.text(applySteerProvenance(text))] })
  })

// ── Pass 1.5 — redundancy-aware reclamation (A2.1 ①) ────────────────────────────────────────────
//
// THE SAFETY INVARIANT, stated once, because it is the whole unit:
//
//   (INV-W) wire shape is untouched — pass 1.5 changes no message count, no role, no part type,
//           and no tool-call/result id, so `dropDanglingToolCalls` / `dropOrphanTools` /
//           `demoteSystemMessages` behave IDENTICALLY with it and without it; and
//   (INV-R) nothing unique leaves the window — a text is only ever collapsed when an equivalent
//           text produced by the SAME tool call is present at a HIGHER index, and pack's survivors
//           are a suffix (plus the anchor), so if the collapsed message survives, its retainer did.
//
// ⚠️ INV-W is why this pass REWRITES a duplicate result in place instead of deleting the message.
// The first attempt at this feature (branch `a21-redundancy-eviction`, preserved and NOT landed)
// deleted them, and that is where all of its unfixable defects lived: deleting a tool result makes
// its call dangling, pass 1 then strips the call, the emptied assistant is dropped, and the message
// that JUSTIFIED the deletion can be the one that dies — voiding the safety argument after the
// decision was already made. In-place rewriting cannot express that failure at all, and it costs
// almost nothing: a collapsed result is ~20 tokens of framing, so deleting the message outright
// would reclaim ~20 tokens more than rewriting it and buy back the entire defect class. That trade
// is not close. `preservesWireShape` is the mechanical guard (ruling 1) — if a future edit ever
// breaks INV-W the pass withdraws entirely rather than emitting a repaired-differently transcript.

/**
 * A result must be at least this big to be worth collapsing. Below it the chars/4 estimator's own
 * error is comparable to the saving, while the notice that replaces the payload costs ~23 tokens of
 * its own. It is also what makes the pass idempotent: a collapsed message is far under this floor,
 * so on the next turn it is neither a candidate nor a cover.
 */
export const MIN_ELIDABLE_TOKENS = 128

/** A single result below this size is noise even when it happens to dominate a tiny prompt. */
export const DOMINANT_TOOL_RESULT_MIN_TOKENS = 512
/** At half the message window, one result is the context rather than merely part of it. */
export const DOMINANT_TOOL_RESULT_PERCENT = 50

/** Prefix of the notice a collapsed tool result carries — stable, so a reader can grep for it. */
export const ELISION_NOTICE_PREFIX = "[novaclaw: duplicate output elided"

/**
 * What a collapsed tool result says on the wire. It names itself and says where the content went,
 * because ruling 2's worst outcome is a *silent* loss — this one is legible to the model reading it
 * and to a human reading the transcript, and the content it points at is genuinely still there.
 */
export const elisionNotice = (toolName: string): string =>
  `${ELISION_NOTICE_PREFIX} — an equivalent result for this same \`${toolName}\` call appears later in this conversation]`

/** The lone `tool-result` part of a tool message, or undefined for any other shape. */
const soleToolResult = (message: Message): ToolResultPart | undefined => {
  if (message.role !== "tool" || message.content.length !== 1) return undefined
  const part = message.content[0]!
  return part.type === "tool-result" ? part : undefined
}

/**
 * The comparable text of a settled tool result — what it actually SAYS.
 *
 * `undefined` means "no lexical signal, do not judge this message". A `content` payload abstains
 * for the WHOLE message as soon as any entry is not text (a `ToolFileContent` screenshot/PDF/audio
 * reaches the window as uri + mime scaffolding, and two unrelated captures of one path look
 * identical on it — judging the text around a binary is worse than not judging at all).
 */
const resultSignalText = (result: ToolResultValue): string | undefined => {
  if (result.type === "content") {
    const entries = result.value
    if (!Array.isArray(entries)) return undefined
    const texts: string[] = []
    for (const entry of entries) {
      if (entry.type !== "text") return undefined
      texts.push(entry.text)
    }
    return texts.join("\n")
  }
  if (typeof result.value === "string") return result.value
  try {
    return JSON.stringify(result.value) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * The identity of a tool CALL: name plus its input, verbatim. This is the gate that keeps this pass
 * from doing the thing that would be worst — collapsing two different files, or two different
 * pages, because their contents happen to look alike. A lexical score alone cannot tell "the same
 * thing twice" from "two things that resemble each other", and no downstream check can recover the
 * difference, so identity is required BEFORE similarity is even computed.
 *
 * ⚠️ Key ORDER in the input matters here, deliberately. Two encodings of the same object with keys
 * in a different order produce different identities and therefore never collapse — the conservative
 * direction, and it costs nothing in practice because a model re-issuing the same call emits the
 * same JSON. Canonicalising would be a second thing that can be wrong.
 */
const callIdentity = (name: string, input: unknown): string | undefined => {
  try {
    const encoded = JSON.stringify([name, input])
    return encoded === undefined ? undefined : encoded
  } catch {
    return undefined
  }
}

/** A settled tool exchange: what identifies it, and which assistant owns it. */
interface ToolExchange {
  readonly key: string
  readonly name: string
  readonly target?: string
  /**
   * Index of the assistant message that issued the call. INV-R needs it: pack keeps a suffix and
   * then drops orphaned tool messages, so "the retainer survives whenever the collapsed message
   * does" holds exactly when the retainer's owner is not older than the collapsed message's owner.
   * That is the normal shape (results follow their assistant); `elideRedundant` refuses the pair
   * when it is not, rather than reasoning about whether the abnormal shape can occur.
   */
  readonly owner: number
}

/** A conservative, non-secret label for a call in Developer diagnostics. Never serialize the whole
 *  input: tool inputs may contain credentials or arbitrary user content. */
const diagnosticTarget = (input: unknown): string | undefined => {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined
  for (const key of ["path", "file", "url"] as const) {
    const value = (input as Record<string, unknown>)[key]
    if (typeof value !== "string") continue
    const trimmed = value.trim()
    if (trimmed.length === 0) continue
    if (key !== "url") return trimmed.slice(0, 240)
    try {
      const parsed = new URL(trimmed)
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined
      parsed.username = ""
      parsed.password = ""
      parsed.search = ""
      parsed.hash = ""
      return parsed.toString().slice(0, 240)
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Per message index, the tool exchange it settles — `undefined` for everything that is not a lone
 * tool result whose owning call can be named.
 *
 * Pairing is POSITIONAL, not set-based: a result consumes the oldest not-yet-answered call bearing
 * its id. That is how the wire itself pairs them, and it is what makes this correct when id
 * generators restart their counters per turn (multi-turn Strict sessions; local models that emit
 * their own ids) — the case where a set-based reading fuses two different exchanges into one, and
 * the case where the first attempt at this feature froze into a permanent no-op.
 *
 * ⚠️ EVERY call enqueues and EVERY result consumes, including the ones this pass can do nothing
 * with (an unnameable input, a provider-executed pair, a multi-result tool message). Skipping a
 * slot instead of consuming it is how the queue drifts, and a drifted queue does not merely lose a
 * collapse — it hands one exchange ANOTHER exchange's identity, which is precisely the "two
 * different files read as one" failure the identity gate exists to prevent.
 */
const toolExchanges = (messages: ReadonlyArray<Message>): Array<ToolExchange | undefined> => {
  const pending = new Map<string, Array<ToolExchange | undefined>>()
  const exchanges: Array<ToolExchange | undefined> = new Array(messages.length).fill(undefined)
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    for (const part of message.content) {
      if (part.type !== "tool-call") continue
      const identity = part.providerExecuted === true ? undefined : callIdentity(part.name, part.input)
      const slot =
        identity === undefined
          ? undefined
          : { key: identity, name: part.name, target: diagnosticTarget(part.input), owner: index }
      const queue = pending.get(part.id)
      if (queue === undefined) pending.set(part.id, [slot])
      else queue.push(slot)
    }
    let settled: ToolExchange | undefined
    for (const part of message.content) {
      if (part.type !== "tool-result") continue
      const call = pending.get(part.id)?.shift()
      if (call === undefined) continue
      // The result's own shape joins the identity: an `error` payload never collapses into a
      // `text` one, however alike they read.
      settled = {
        key: `${call.key} ${part.result.type}`,
        name: call.name,
        ...(call.target === undefined ? {} : { target: call.target }),
        owner: call.owner,
      }
    }
    if (soleToolResult(message) !== undefined) exchanges[index] = settled
  }
  return exchanges
}

/**
 * INV-W, mechanically. True when `after` differs from `before` only in ways the wire-legality
 * passes cannot see: same length, same roles, same part types in the same positions, same tool
 * ids and names. Those are exactly the fields `dropDanglingToolCalls`, `dropOrphanTools`,
 * `rendersNothing` and `demoteSystemMessages` read, so a `true` here is a proof that inserting
 * pass 1.5 cannot change what any of them decides.
 *
 * Exported because it is the check, not a detail: it is what would have caught the original
 * pre-legalisation defect (a pass that DELETES a message fails the length test on its first line),
 * and `elideRedundant` withdraws its whole output rather than return something that fails it.
 */
export const preservesWireShape = (before: ReadonlyArray<Message>, after: ReadonlyArray<Message>): boolean => {
  if (before.length !== after.length) return false
  for (let index = 0; index < before.length; index++) {
    const original = before[index]!
    const rewritten = after[index]!
    if (original === rewritten) continue
    if (original.role !== rewritten.role) return false
    if (original.content.length !== rewritten.content.length) return false
    for (let position = 0; position < original.content.length; position++) {
      const source = original.content[position]!
      const target = rewritten.content[position]!
      if (source.type !== target.type) return false
      if (source.type === "tool-call" && target.type === "tool-call")
        if (
          source.id !== target.id ||
          source.name !== target.name ||
          // `localToolCallIds` reads this, so pass 1 sees it — it belongs in the comparison.
          source.providerExecuted !== target.providerExecuted
        )
          return false
      if (source.type === "tool-result" && target.type === "tool-result")
        if (source.id !== target.id || source.name !== target.name) return false
    }
  }
  return true
}

export interface ElisionResult {
  /** The rewritten window — the INPUT ARRAY ITSELF when nothing was collapsed. */
  readonly messages: Message[]
  readonly elisions: ReadonlyArray<ContextRedundancy.Redundancy>
  /** Estimated tokens the rewrite reclaimed. */
  readonly reclaimed: number
}

interface RedundancyMatch {
  readonly redundancy: ContextRedundancy.Redundancy
  readonly exchange: ToolExchange
  readonly notice: Message
  readonly saved: number
  /** Byte-equivalent model-facing text, not merely a high lexical-overlap verdict. */
  readonly exact: boolean
}

const analyzeRedundancy = (
  messages: Message[],
  estimates: ReadonlyArray<number>,
): {
  readonly matches: ReadonlyArray<RedundancyMatch>
  readonly exchanges: ReadonlyArray<ToolExchange | undefined>
} => {
  const exchanges = toolExchanges(messages)

  // Two passes, because building a comparison text means materialising a whole tool payload as a
  // string and `pack()` runs every turn. The first pass is index arithmetic only; the second builds
  // text for the identities that actually REPEAT — so an ordinary window, where every call is
  // distinct, never pays for the signal at all.
  const collapsible: Array<ToolResultPart | undefined> = new Array(messages.length).fill(undefined)
  const repeats = new Map<string, number>()
  for (let index = 0; index < messages.length; index++) {
    const exchange = exchanges[index]
    if (exchange === undefined) continue
    const message = messages[index]!
    if ((estimates[index] ?? estimateMessage(message)) < MIN_ELIDABLE_TOKENS) continue
    const part = soleToolResult(message)
    if (part === undefined) continue
    collapsible[index] = part
    repeats.set(exchange.key, (repeats.get(exchange.key) ?? 0) + 1)
  }
  const items = collapsible.map((part, index): ContextRedundancy.RedundancyItem | undefined => {
    if (part === undefined) return undefined
    const key = exchanges[index]!.key
    if ((repeats.get(key) ?? 0) < 2) return undefined
    const text = resultSignalText(part.result)
    return text === undefined ? undefined : { key, text }
  })

  const matches = ContextRedundancy.findRedundant(items).flatMap((redundancy): RedundancyMatch[] => {
    const exchange = exchanges[redundancy.index]
    if (exchange === undefined) return []
    // INV-R, structurally: pack keeps a SUFFIX and then drops orphans, so the retainer outlives the
    // collapsed message exactly when its owning assistant is not the older of the two.
    if (exchange.owner > exchanges[redundancy.retainedIndex]!.owner) return []
    const message = messages[redundancy.index]!
    const part = soleToolResult(message)
    if (part === undefined) return []
    const notice = Message.make({
      ...message,
      content: [{ ...part, result: { type: "text" as const, value: elisionNotice(part.name) } }],
    })
    const saved = (estimates[redundancy.index] ?? estimateMessage(message)) - estimateMessage(notice)
    return saved > 0
      ? [
          {
            redundancy,
            exchange,
            notice,
            saved,
            exact: items[redundancy.index]?.text === items[redundancy.retainedIndex]?.text,
          },
        ]
      : []
  })
  return { matches, exchanges }
}

const duplicateFindings = (
  matches: ReadonlyArray<RedundancyMatch>,
  elidedIndexes: ReadonlySet<number>,
): SessionMessage.ContextFinding[] => {
  const groups = new Map<
    string,
    { name: string; target?: string; indexes: Set<number>; repeatedTokens: number; first: number; elided: boolean }
  >()
  for (const match of matches) {
    const current = groups.get(match.exchange.key) ?? {
      name: match.exchange.name,
      ...(match.exchange.target === undefined ? {} : { target: match.exchange.target }),
      indexes: new Set<number>(),
      repeatedTokens: 0,
      first: match.redundancy.index,
      elided: false,
    }
    current.indexes.add(match.redundancy.index)
    current.indexes.add(match.redundancy.retainedIndex)
    current.repeatedTokens += match.saved
    current.elided ||= elidedIndexes.has(match.redundancy.index)
    groups.set(match.exchange.key, current)
  }
  return [...groups.values()]
    .sort((a, b) => a.first - b.first)
    .map((group) => ({
      kind: "duplicate-tool-output" as const,
      tool: group.name,
      ...(group.target === undefined ? {} : { target: group.target }),
      occurrences: group.indexes.size,
      repeatedTokens: group.repeatedTokens,
      elided: group.elided,
    }))
}

const dominantFinding = (
  messages: Message[],
  estimates: ReadonlyArray<number>,
  exchanges: ReadonlyArray<ToolExchange | undefined>,
): SessionMessage.ContextFinding | undefined => {
  const total = estimates.reduce((sum, tokens) => sum + tokens, 0)
  if (total === 0) return undefined
  let largest: { exchange: ToolExchange; tokens: number } | undefined
  for (let index = 0; index < messages.length; index++) {
    const exchange = exchanges[index]
    if (exchange === undefined || soleToolResult(messages[index]!) === undefined) continue
    const tokens = estimates[index]!
    if (largest === undefined || tokens > largest.tokens) largest = { exchange, tokens }
  }
  if (largest === undefined || largest.tokens < DOMINANT_TOOL_RESULT_MIN_TOKENS) return undefined
  const percent = Math.round((largest.tokens / total) * 1_000) / 10
  if (percent < DOMINANT_TOOL_RESULT_PERCENT) return undefined
  return {
    kind: "dominant-tool-output",
    tool: largest.exchange.name,
    ...(largest.exchange.target === undefined ? {} : { target: largest.exchange.target }),
    tokens: largest.tokens,
    percent,
  }
}

const contextFindings = (
  messages: Message[],
  estimates: ReadonlyArray<number>,
  exchanges: ReadonlyArray<ToolExchange | undefined>,
  matches: ReadonlyArray<RedundancyMatch>,
  elidedIndexes: ReadonlySet<number>,
): SessionMessage.ContextFinding[] => {
  const dominant = dominantFinding(messages, estimates, exchanges)
  return [...duplicateFindings(matches, elidedIndexes), ...(dominant === undefined ? [] : [dominant])]
}

const applyRedundancy = (messages: Message[], matches: ReadonlyArray<RedundancyMatch>): ElisionResult => {
  const nothing: ElisionResult = { messages, elisions: [], reclaimed: 0 }
  if (matches.length === 0) return nothing
  const rewritten = [...messages]
  let reclaimed = 0
  for (const match of matches) {
    rewritten[match.redundancy.index] = match.notice
    reclaimed += match.saved
  }
  if (!preservesWireShape(messages, rewritten)) return nothing
  return { messages: rewritten, elisions: matches.map((match) => match.redundancy), reclaimed }
}

/**
 * Wire-legality pass 1.5 — redundancy-aware reclamation. Runs INSIDE the existing pass sequence
 * (after `dropDanglingToolCalls`, before the newest-first recency loop), so redundancy is reclaimed
 * before age decides anything, and nothing downstream has to know it happened.
 *
 * ⚠️ It collapses ALL detected redundancy, not "just enough to fit". That is deliberate and it is
 * what removes an entire defect class: a shortfall budget has to be counted against the
 * POST-legalisation state to be honest, and getting that wrong is how the first attempt turned a
 * one-token overflow into three thousand reclaimed tokens. Here the question does not arise — the
 * content stays in the window (in its retainer), so there is nothing to be minimal about, the
 * decision does not depend on the budget, and the same history therefore collapses the same way on
 * every turn as the conversation grows.
 *
 * Reasons a message abstains, all of them structural rather than heuristic:
 *  - it is not a lone `tool-result` message (an assistant, a user, a multi-part tool message);
 *  - its owning call cannot be named, or its payload is not text (binary abstains wholesale);
 *  - it is under `MIN_ELIDABLE_TOKENS`;
 *  - no other message in the window settles the SAME call with the same result shape.
 * A message that is none of those is still only collapsed when `context-redundancy.ts` says a
 * strictly newer sibling already carries its content, under a hard cap on unique content lost.
 */
export const elideRedundant = (messages: Message[], estimates: ReadonlyArray<number>): ElisionResult => {
  return applyRedundancy(messages, analyzeRedundancy(messages, estimates).matches)
}

type HistoryCategory = "messages" | "retrieval" | "tool_output"

const historyCategory = (message: Message): HistoryCategory => {
  const result = soleToolResult(message)
  if (result === undefined) return "messages"
  return result.name === "kb" ? "retrieval" : "tool_output"
}

const historyUsage = (messages: ReadonlyArray<Message>, estimates: ReadonlyArray<number>) => {
  const usage: Record<HistoryCategory, number> = { messages: 0, retrieval: 0, tool_output: 0 }
  messages.forEach((message, index) => {
    usage[historyCategory(message)] += estimates[index] ?? estimateMessage(message)
  })
  return usage
}

const categoryNotice = (category: Exclude<HistoryCategory, "messages">, name: string): string =>
  `[novaclaw: older ${category === "retrieval" ? "knowledge retrieval" : `${name} tool output`} omitted to preserve this context share]`

interface CategoryBudgetResult {
  readonly messages: Message[]
  readonly findings: SessionMessage.ContextFinding[]
}

/** Enforce the three history shares before ordinary recency packing. Tool results are rewritten in
 * place so call/result wire shape survives; conversation messages are removed oldest-first, with
 * both the original task anchor and newest message protected. The legality passes get the last word. */
const enforceHistoryBudgets = (
  messages: Message[],
  estimates: ReadonlyArray<number>,
  caps: Readonly<Record<HistoryCategory, number>>,
): CategoryBudgetResult => {
  const before = historyUsage(messages, estimates)
  let working = [...messages]
  let workingEstimates = [...estimates]
  const affected: Record<HistoryCategory, number> = { messages: 0, retrieval: 0, tool_output: 0 }

  for (const category of ["retrieval", "tool_output"] as const) {
    const indexes = working.flatMap((message, index) => (historyCategory(message) === category ? [index] : []))
    let used = indexes.reduce((sum, index) => sum + workingEstimates[index]!, 0)
    const newest = indexes.at(-1)
    for (const index of indexes) {
      if (used <= caps[category] || index === newest) break
      const message = working[index]!
      const part = soleToolResult(message)
      if (part === undefined) continue
      const replacement = Message.make({
        ...message,
        content: [
          {
            ...part,
            result: { type: "text" as const, value: categoryNotice(category, part.name) },
          },
        ],
      })
      const next = estimateMessage(replacement)
      const saved = workingEstimates[index]! - next
      if (saved <= 0) continue
      working[index] = replacement
      workingEstimates[index] = next
      used -= saved
      affected[category]++
    }
  }

  let messageUsed = historyUsage(working, workingEstimates).messages
  const anchor = working.findIndex(isRealUserMessage)
  const newest = working.length - 1
  const removed = new Set<number>()
  for (let index = 0; index < working.length && messageUsed > caps.messages; index++) {
    if (historyCategory(working[index]!) !== "messages" || index === anchor || index === newest) continue
    removed.add(index)
    messageUsed -= workingEstimates[index]!
    affected.messages++
  }
  if (removed.size > 0) {
    working = working.filter((_, index) => !removed.has(index))
    working = dropOrphanTools(dropDanglingToolCalls(working))
    workingEstimates = working.map(estimateMessage)
  }

  const after = historyUsage(working, workingEstimates)
  const findings = (["messages", "retrieval", "tool_output"] as const).flatMap(
    (category): SessionMessage.ContextFinding[] =>
      before[category] <= caps[category]
        ? []
        : [
            {
              kind: "category-budget",
              category,
              limitTokens: caps[category],
              beforeTokens: before[category],
              afterTokens: after[category],
              affectedMessages: affected[category],
              protected: after[category] > caps[category],
            },
          ],
  )
  return { messages: working, findings }
}

export interface PackResult {
  readonly messages: Message[]
  /** true when anything was evicted or repaired — the runner rebuilds the request only then. */
  readonly changed: boolean
  readonly dropped: number
  readonly estimatedTokens: number
  /** How many duplicate tool results pass 1.5 collapsed (A2.1 ①). */
  readonly elided: number
  /** Plain structured findings for Developer diagnostics — never an opaque composite score. */
  readonly findings: ReadonlyArray<SessionMessage.ContextFinding>
}

/**
 * Pack whole messages newest-first until the budget, return chronological; the newest message is
 * always kept even if alone over budget. Exact repeated output is always collapsed; on overflow,
 * safe near-duplicates are collapsed too (pass 1.5), so recency only decides between things the
 * window does NOT already say. Then
 * repair the kept set: orphan results dropped, newest assistant+results group recovered whole if
 * eviction emptied the window, and the FIRST real user message re-prepended when packing would
 * evict the sole user message — "the original task, the agent's anchor against drift" —
 * deliberately over budget.
 */
export const pack = (
  messages: ReadonlyArray<Message>,
  budgetTokens: number,
  options: { readonly historyCaps?: Readonly<Record<HistoryCategory, number>> } = {},
): PackResult => {
  const repaired = dropDanglingToolCalls(messages)
  let working = repaired
  let estimates = repaired.map(estimateMessage)
  let total = estimates.reduce((sum, tokens) => sum + tokens, 0)
  let elided = 0
  let elidedIndexes = new Set<number>()
  const analysisEstimates = estimates
  const analysis = analyzeRedundancy(repaired, analysisEstimates)
  let budgetFindings: SessionMessage.ContextFinding[] = []
  const categoryOverflow =
    options.historyCaps === undefined
      ? false
      : Object.entries(historyUsage(repaired, estimates)).some(
          ([category, used]) => used > options.historyCaps![category as HistoryCategory],
        )

  // Pass 1.5 — exact repeats never enter provider context twice. This keeps the durable transcript
  // complete while giving the model the same saving as a read cache, without a cache reference that
  // can become orphaned after compaction or recency eviction. Near-duplicates remain overflow-only:
  // their bounded lexical difference is an acceptable eviction trade, not a reason to churn a
  // fitting prompt (or its prefix cache).
  const overflow = total > budgetTokens || categoryOverflow
  const applicable = overflow ? analysis.matches : analysis.matches.filter((match) => match.exact)
  if (applicable.length > 0) {
    const reclaimed = applyRedundancy(repaired, applicable)
    if (reclaimed.messages !== repaired) {
      working = reclaimed.messages
      elided = reclaimed.elisions.length
      elidedIndexes = new Set(reclaimed.elisions.map((item) => item.index))
      estimates = working.map(estimateMessage)
      total = estimates.reduce((sum, tokens) => sum + tokens, 0)
    }
  }

  if (options.historyCaps !== undefined) {
    const budgeted = enforceHistoryBudgets(working, estimates, options.historyCaps)
    if (budgeted.messages.length !== working.length || budgeted.messages.some((message, i) => message !== working[i])) {
      working = budgeted.messages
      estimates = working.map(estimateMessage)
      total = estimates.reduce((sum, tokens) => sum + tokens, 0)
    }
    budgetFindings = budgeted.findings
  }

  if (total <= budgetTokens) {
    const legal = demoteSystemMessages(dropOrphanTools(working))
    const changed = legal.length !== messages.length || legal.some((message, i) => message !== messages[i])
    return {
      messages: legal,
      changed,
      dropped: messages.length - legal.length,
      estimatedTokens: total,
      elided,
      findings: [
        ...contextFindings(repaired, analysisEstimates, analysis.exchanges, analysis.matches, elidedIndexes),
        ...budgetFindings,
      ],
    }
  }

  // Newest-first, whole messages; newest always kept.
  let used = 0
  let start = working.length
  for (let i = working.length - 1; i >= 0; i--) {
    const next = used + estimates[i]!
    if (next > budgetTokens && start < working.length) break
    used = next
    start = i
  }
  let kept = dropOrphanTools(working.slice(start))

  // Recover the newest assistant+results group whole (deliberately over budget) if the orphan
  // pass emptied the window down to nothing usable.
  if (kept.length === 0 || kept.every((message) => message.role === "tool")) {
    let newestAssistant = -1
    for (let i = working.length - 1; i >= 0; i--) {
      if (working[i]!.role === "assistant") {
        newestAssistant = i
        break
      }
    }
    if (newestAssistant >= 0) kept = dropOrphanTools(working.slice(newestAssistant))
  }

  // Original-task anchoring (pass 4): never let packing evict the sole real user message.
  if (!kept.some(isRealUserMessage)) {
    const anchor = working.find(isRealUserMessage)
    if (anchor !== undefined) kept = [anchor, ...kept]
  }

  kept = demoteSystemMessages(kept)
  return {
    messages: kept,
    changed: true,
    dropped: messages.length - kept.length,
    estimatedTokens: estimateMessages(kept),
    elided,
    findings: [
      ...contextFindings(repaired, analysisEstimates, analysis.exchanges, analysis.matches, elidedIndexes),
      ...budgetFindings,
    ],
  }
}

/** The runner-facing composition: budget from the request's own system/tools, then pack. */
const enforceSystemBudgets = (input: {
  readonly system: ReadonlyArray<SystemPart>
  readonly memoryRecall?: string
  readonly contextSize: number
  readonly profile: ContextBudget.Profile
}): {
  readonly system: SystemPart[]
  readonly changed: boolean
  readonly findings: SessionMessage.ContextFinding[]
} => {
  let system = [...input.system]
  const memoryIndex =
    input.memoryRecall === undefined ? -1 : system.findIndex((part) => part.text === input.memoryRecall)
  const memoryBefore = memoryIndex < 0 ? 0 : Token.estimate(system[memoryIndex]!.text)
  const memoryLimit = ContextBudget.cap(input.contextSize, input.profile.memory)
  let memoryAfter = memoryBefore
  let memoryAffected = 0
  if (memoryIndex >= 0 && memoryBefore > memoryLimit) {
    const lines = system[memoryIndex]!.text.split("\n")
    let kept = ""
    for (const line of lines) {
      const candidate = kept.length === 0 ? line : `${kept}\n${line}`
      if (Token.estimate(candidate) > memoryLimit) break
      kept = candidate
    }
    if (kept.length === 0) system.splice(memoryIndex, 1)
    else system[memoryIndex] = { ...system[memoryIndex]!, text: kept }
    memoryAfter = kept.length === 0 ? 0 : Token.estimate(kept)
    memoryAffected = 1
  }

  const systemBefore = input.system.reduce((sum, part, index) => {
    return index === memoryIndex ? sum : sum + Token.estimate(part.text)
  }, 0)
  const systemLimit = ContextBudget.cap(input.contextSize, input.profile.system)
  const findings: SessionMessage.ContextFinding[] = []
  if (systemBefore > systemLimit)
    findings.push({
      kind: "category-budget",
      category: "system",
      limitTokens: systemLimit,
      beforeTokens: systemBefore,
      afterTokens: systemBefore,
      affectedMessages: 0,
      protected: true,
    })
  if (memoryBefore > memoryLimit)
    findings.push({
      kind: "category-budget",
      category: "memory",
      limitTokens: memoryLimit,
      beforeTokens: memoryBefore,
      afterTokens: memoryAfter,
      affectedMessages: memoryAffected,
      protected: memoryAfter > memoryLimit,
    })
  return { system, changed: memoryAffected > 0, findings }
}

export const packRequest = (input: {
  readonly request: LLMRequest
  readonly contextSize: number | undefined
  readonly profile?: ContextBudget.Profile
  readonly memoryRecall?: string
}): PackResult & { readonly contextSize: number; readonly system: ReadonlyArray<SystemPart> } => {
  const contextSize =
    input.contextSize !== undefined && input.contextSize > 0 ? input.contextSize : DEFAULT_CONTEXT_SIZE
  const systemBudget =
    input.profile === undefined
      ? { system: [...input.request.system], changed: false, findings: [] }
      : enforceSystemBudgets({
          system: input.request.system,
          memoryRecall: input.memoryRecall,
          contextSize,
          profile: input.profile,
        })
  const result = pack(
    input.request.messages,
    budget({
      contextSize,
      system: systemBudget.system,
      tools: input.request.tools,
      maxTokens: input.request.generation?.maxTokens,
    }),
    input.profile === undefined
      ? undefined
      : {
          historyCaps: {
            messages: ContextBudget.cap(contextSize, input.profile.messages),
            retrieval: ContextBudget.cap(contextSize, input.profile.retrieval),
            tool_output: ContextBudget.cap(contextSize, input.profile.tool_output),
          },
        },
  )
  return {
    ...result,
    changed: result.changed || systemBudget.changed,
    findings: [...systemBudget.findings, ...result.findings],
    contextSize,
    system: systemBudget.system,
  }
}

/**
 * A6(7) — the ctx_pressure tripwire: every response, compare the server-REPORTED prompt tokens
 * against the window; at ≥95% the real prompt has outgrown the packer's estimate and the next
 * request risks silent server-side truncation. Instruments the estimator's blind spot instead of
 * trusting it.
 */
export const ctxPressure = (reportedPromptTokens: number, contextSize: number): boolean =>
  contextSize > 0 && reportedPromptTokens >= contextSize * PRESSURE_THRESHOLD
