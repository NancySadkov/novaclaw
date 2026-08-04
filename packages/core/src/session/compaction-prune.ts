export * as CompactionPrune from "./compaction-prune"

// A2-a (todo/adoption.md §A2) — the CHEAP tier of the compaction ladder, restored.
//
// `prune()` is the NON-LLM context reclaim: walk the transcript backwards, protect the newest 40k
// tokens of tool output and the last 2 turns, exempt `skill` output, erase older tool RESULTS
// (never the call or its arguments), and commit only if the reclaim clears 20k. It shipped in the
// V1 `packages/opencode/src/session/` path and was deleted with the V1 nuke; the constants,
// the walk and the exemption list here are the V1 semantics, re-expressed against the V2 message
// schema. `packages/schema/src/session-message.ts`'s `AssistantTool.time.pruned` is the field the
// V1 tier wrote (`state.time.compacted`) and is still declared — this module is its only writer.
//
// PURE by construction: no Effect, no I/O, no clock. The reclaim DECISION (`plan`) and the reclaim
// ITSELF (`erase`) are separate so the thresholds can be asserted without a session, a database or
// a model (test/session-compaction-prune.test.ts). `compaction.ts` keeps the wiring.
//
// Tokenizer-free by deliberate design — `util/token.ts` is the ONE estimator shared by context
// packing, compaction and the reasoning budget, and prune joins it rather than adding a tokenizer
// (todo/adoption.md A2.1 gate 2). The estimate mirrors what `runner/to-llm-message.ts` actually
// lowers for a completed tool part, so "tokens reclaimed" means tokens the MODEL stops paying for,
// not bytes in the row.
//
// WHERE THE RECLAIM LANDS — one leg is shipped, and the second is deliberately NOT here.
//
// SHIPPED, in-memory inside the compaction cycle: `compaction.ts` runs this tier at the top of the
// cycle, so an erased result is gone from BOTH durable halves of that cycle — the `head` that feeds
// the summary prompt, and the `recent` tail stored verbatim on the compaction message and re-fed on
// every later turn. `erase()` below is that path, and it is the whole of what ships today.
//
// ⛔ WITHHELD: rewriting the transcript ROWS via a durable `SessionEvent.Tool.Pruned`. It was built
// and it worked (branch `tool-pruned-event`), then adversarial review found 10 defects and one of
// them voids the premise on the DEFAULT path: `SessionHistory.messageRows` bounds the runner's query
// with `gte(seq, compaction.seq)` (`session/history.ts:36-43`), so once this cycle writes its
// compaction message every pruned row is ALREADY out of the model's context, permanently. Erasing
// the rows as well therefore reclaims nothing and only destroys the human-readable transcript — and
// destroys it badly, wiping the `structured` payload that is the only rendering of what an
// `edit`/`write` call did, and making a pruned `question` card report answers the user really gave
// as "No answer".
//
// The corrected design, if you are the one building it: the durable event is a FAILURE-PATH BACKSTOP
// and the mechanism for a future `prune only` scheme — publish it ONLY where no compaction message
// will be written. On the success path the compaction boundary already does the work; leave the rows
// alone. Exempt `question`, keep a `structured.files` residue (drop only `patch`, which is the
// bytes), and surface `time.pruned` in the UI, which folds it today and renders nothing.
//
// ⚠️ Whatever lands, `erasedState` below must stay the SINGLE definition of what an erased result
// looks like — any updater arm and the `session-ui` client fold must both reproduce it, or the
// transcript and the UI will disagree.

import type { DateTime } from "effect"
import { SessionMessage } from "./message"
import { isRealUserTurn } from "./steer-provenance"
import { Token } from "../util/token"

/**
 * Tool output newer than this many tokens is never erased — the working set the agent is still
 * reasoning over. Walking BACKWARDS, output is protected until the running total crosses this
 * ceiling; the result that straddles the boundary is erased whole (V1 semantics: a half-erased
 * tool result is not a thing, so the ceiling is a floor on what survives, not an exact cut).
 */
export const PROTECT_TOOL_OUTPUT_TOKENS = 40_000

/**
 * The newest N real user turns are protected ENTIRELY — every tool result inside them survives
 * regardless of size. A steer riding the user role is not a turn (`isRealUserTurn`), so a
 * doom-loop nudge cannot silently shrink the protected window.
 */
export const PROTECT_RECENT_TURNS = 2

/**
 * Erase nothing unless the reclaim clears this. A prune that frees 3k has spent a durable rewrite
 * of history to buy nothing, so the plan reports `commit: false` and the caller leaves history
 * untouched and falls through to the summarize tier.
 */
export const MIN_RECLAIM_TOKENS = 20_000

/**
 * Tools whose output prune never touches — and never COUNTS either, so a skill's manual cannot
 * consume the 40k protection budget on behalf of the tool results around it. `skill` output is a
 * loaded instruction set the agent is expected to keep following for the rest of the task; erasing
 * it removes capability rather than stale evidence.
 */
export const EXEMPT_TOOLS: readonly string[] = ["skill"]

/** What an erased tool result reads as, to the model and in the transcript. */
export const ERASED_NOTICE = "[Tool output erased to reclaim context. The call and its arguments are unchanged.]"

/** One completed tool result the plan intends to erase. */
export type Target = {
  readonly messageID: SessionMessage.ID
  /** `AssistantTool.id` — the provider's tool-call id. */
  readonly callID: string
  readonly name: string
  /** Estimated tokens this result costs on the wire today. */
  readonly tokens: number
}

/** The reclaim decision: what to erase, how much it frees, and whether it is worth committing. */
export type Plan = {
  /** `reclaim > MIN_RECLAIM_TOKENS`. False ⇒ the caller must change nothing at all. */
  readonly commit: boolean
  readonly targets: readonly Target[]
  /** Tokens held by `targets` — what erasing them frees. */
  readonly reclaim: number
  /** Tokens of eligible tool output walked in total; `scanned - reclaim` is what stays protected. */
  readonly scanned: number
}

export const isExempt = (name: string): boolean => EXEMPT_TOOLS.includes(name)

/** Already pruned — its output is the notice, and the timestamp says who did it. */
export const isPruned = (tool: SessionMessage.AssistantTool): boolean => tool.time.pruned !== undefined

const estimateJson = (value: unknown): number => {
  try {
    return Token.estimate(JSON.stringify(value) ?? "")
  } catch {
    return 0
  }
}

/**
 * What a completed tool part costs the model, mirroring `runner/to-llm-message.ts`'s `toolResult`:
 * a provider-executed call with a raw `result` lowers that value, everything else lowers
 * `{structured, content}`. Exported as a test seam so the estimate can be asserted directly rather
 * than inferred from a plan (the same reason `compaction.ts` exports `serializeToolContent`).
 */
export const outputTokens = (tool: SessionMessage.AssistantTool): number => {
  if (tool.state.status !== "completed") return 0
  if (tool.provider?.executed === true && tool.state.result !== undefined) return estimateJson(tool.state.result)
  return estimateJson({ structured: tool.state.structured, content: tool.state.content })
}

/**
 * The reclaim decision over a transcript, newest → oldest.
 *
 * The walk stops (rather than skips) at two boundaries, both deliberate: a `compaction` message —
 * everything older is already represented by its summary — and the first ALREADY-pruned tool
 * result, because prune runs oldest-last, so anything beyond it was erased by a previous pass.
 * That second stop is what makes repeated prunes idempotent and O(new work).
 */
export const plan = (messages: readonly SessionMessage.Message[]): Plan => {
  const targets: Target[] = []
  let scanned = 0
  let reclaim = 0
  let turns = 0
  walk: for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (isRealUserTurn(message)) turns++
    // The newest PROTECT_RECENT_TURNS turns are untouchable — including the assistant work that
    // follows the newest user message, which is reached before any turn has been counted.
    if (turns < PROTECT_RECENT_TURNS) continue
    if (message.type === "compaction") break walk
    if (message.type !== "assistant") continue
    for (let position = message.content.length - 1; position >= 0; position--) {
      const part = message.content[position]!
      if (part.type !== "tool") continue
      if (part.state.status !== "completed") continue
      if (isExempt(part.name)) continue
      if (isPruned(part)) break walk
      const tokens = outputTokens(part)
      scanned += tokens
      if (scanned <= PROTECT_TOOL_OUTPUT_TOKENS) continue
      reclaim += tokens
      targets.push({ messageID: message.id, callID: part.id, name: part.name, tokens })
    }
  }
  return { commit: reclaim > MIN_RECLAIM_TOKENS, targets, reclaim, scanned }
}

/**
 * The erased form of a completed tool state: the output is replaced by the notice and nothing else
 * changes. `input` survives (the model must still see WHAT it asked for), and so do `attachments` /
 * `outputPaths` — neither is lowered to the model, both are how a surface still names the files the
 * call produced. Only `content`, `structured` and `result` carry the bulk, so only they are dropped.
 */
export const erasedState = (state: SessionMessage.ToolStateCompleted): SessionMessage.ToolStateCompleted =>
  SessionMessage.ToolStateCompleted.make({
    status: "completed",
    input: state.input,
    attachments: state.attachments,
    content: [{ type: "text", text: ERASED_NOTICE }],
    outputPaths: state.outputPaths,
    structured: {},
    result: undefined,
  })

/**
 * Apply a plan. Returns the input array UNCHANGED (same reference) when the plan does not commit —
 * "no commit" must mean history is not rewritten, and identity is the cheapest way to prove it.
 *
 * `prunedAt` is a parameter rather than a `DateTime.now` so this module stays clock-free and the
 * result is deterministic for a given input (the packing-determinism discipline in
 * `runner/context-pack.ts`).
 */
export const erase = (
  messages: readonly SessionMessage.Message[],
  applied: Plan,
  prunedAt: DateTime.Utc,
): readonly SessionMessage.Message[] => {
  if (!applied.commit || applied.targets.length === 0) return messages
  const byMessage = new Map<string, Set<string>>()
  for (const target of applied.targets) {
    const calls = byMessage.get(target.messageID) ?? new Set<string>()
    calls.add(target.callID)
    byMessage.set(target.messageID, calls)
  }
  return messages.map((message) => {
    if (message.type !== "assistant") return message
    const calls = byMessage.get(message.id)
    if (calls === undefined) return message
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== "tool" || !calls.has(part.id) || part.state.status !== "completed") return part
        return { ...part, state: erasedState(part.state), time: { ...part.time, pruned: prunedAt } }
      }),
    } satisfies SessionMessage.Assistant
  })
}
