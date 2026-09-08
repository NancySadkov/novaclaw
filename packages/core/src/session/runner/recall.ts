export * as SessionRecall from "./recall"

import { lastRealUserText } from "../steer-provenance"
import type { ModelV2 } from "../../model"
import type { MemoryClient } from "../../kb-graph/memory-client"
import type { SessionMessage } from "../message"

// Auto-recall: each turn, surface relevant memories into the system
// prompt so the model "just remembers" — the user (and other chats') facts show up without the agent
// having to call the `kb` tool. Pure helpers here (the runner does the search + injection). Budgeted
// DOWN for weak models (the JH floor) so recalled memory never crowds out the task.

/** The recall query = the latest REAL user message's text (what this turn is about); undefined if none.
 *
 *  ⚠️ B2 — harness steers are stored as `user`-type messages, so taking the newest one verbatim made
 *  the retrieval query the harness's own instruction text after every doom-loop redirect or quality
 *  nudge: the turn's memories were then selected by scaffolding rather than by what the user said.
 *  `lastRealUserText` is the one shared predicate; it also skips blank turns (a files-only prompt
 *  carries no query), matching `strict.ts`'s task walk. */
export const recallQuery = (context: ReadonlyArray<SessionMessage.Message>): string | undefined =>
  lastRealUserText(context)

/** How many memories to inject — scaled down for weak models (the JH floor: don't crowd the window). */
export const recallBudget = (tier: ModelV2.Tier | undefined): number => {
  switch (tier) {
    case "micro":
    case "tiny":
      return 3
    case "small":
      return 5
    default:
      return 8
  }
}

/** How many candidates to RETRIEVE before ranking — deliberately DECOUPLED from `recallBudget`.
 *  The budget bounds what the model SEES (window pressure, correctly small for weak models); the pool
 *  bounds what the ranker can CHOOSE FROM, which costs rerank latency, not context. Conflating them
 *  penalised weak models exactly where recall matters most: MEASURED (the D20
 *  bisection), a query with no rare anchor put its answer at hybrid rank 12 and 18 — so a micro tier's
 *  3x3=9 pool could not contain it at all, while the model would still only have been shown 3.
 *  Floor 16 covers the measured range; cap 40 bounds rerank cost (measured ~915ms at 24 candidates).
 *  Never returns fewer candidates than the budget — you cannot show more than you retrieved. */
export const recallPoolSize = (budget: number): number => Math.max(Math.min(Math.max(budget * 3, 16), 40), budget)

const slashPathText = (value: string): string => value.replaceAll("\\", "/")

const pathBoundary = (value: string | undefined): boolean => value === undefined || /[\s"'`()\[\]{},;:!?]/.test(value)

const mentionsExactPath = (text: string, target: string): boolean => {
  const normalizedTarget = slashPathText(target.trim())
  // Windows paths are case-insensitive in the environments Nova supports. Keep POSIX paths
  // case-sensitive: `/home/A` and `/home/a` may genuinely be different files. The decision belongs
  // to the TARGET, not the whole memory sentence containing it.
  const windows = /^[a-z]:\//i.test(normalizedTarget) || normalizedTarget.startsWith("//")
  const haystack = windows ? slashPathText(text).toLowerCase() : slashPathText(text)
  const needle = windows ? normalizedTarget.toLowerCase() : normalizedTarget
  if (needle === "") return false
  let offset = haystack.indexOf(needle)
  while (offset >= 0) {
    const before = offset === 0 ? undefined : haystack[offset - 1]
    const after = offset + needle.length >= haystack.length ? undefined : haystack[offset + needle.length]
    const afterBoundary = pathBoundary(after) || (after === "." && pathBoundary(haystack[offset + needle.length + 1]))
    if (pathBoundary(before) && afterBoundary) return true
    offset = haystack.indexOf(needle, offset + 1)
  }
  return false
}

/** Which memory scopes THIS turn may read (AGENTS.md — *the structural metaphor*: the agent's private
 *  memory scope is its filing cabinet, and a D&D companion's recall never reaches the trading desk).
 *
 *  - `session:<id>` — what was said in this chat.
 *  - `agent:<id>` — the OFFICER's own cabinet, which is what makes the roster mean anything: it
 *    outlives any one chat and no sibling agent can see it. Nova is not exempt and is not a
 *    super-user — its memory is personal to it like everyone else's (owner, 2026-08-19).
 *  - `global` — the household's shared facts (who the user is, how they like things), deliberately
 *    readable by every agent: partitioning THOSE would make each new colleague a stranger.
 *
 *  ⚠️ `undefined` means this agent has NO memory at all — the owner's throwaway "Crashtest Joe". It is
 *  distinct from an empty result: the caller must skip the whole recall leg (embed + search + inject),
 *  not search with no scopes, or a probe pays for retrieval it must never receive.
 *
 *  A sub-agent is a child SESSION of its officer and carries the officer's agent id through the config
 *  walk, so it inherits the same cabinet for free and cannot reach a sibling's. */
export const recallScopes = (input: {
  readonly sessionID: string
  readonly agentID: string | undefined
  readonly memory: "own" | "none" | undefined
}): ReadonlyArray<string> | undefined => {
  if (input.memory === "none") return undefined
  const scopes = [`session:${input.sessionID}`]
  if (input.agentID !== undefined && input.agentID !== "") scopes.push(`agent:${input.agentID}`)
  scopes.push("global")
  return scopes
}

/** Where a `remember` writes when the model does not say. An officer's durable facts belong to the
 *  OFFICER, not to whichever chat happened to be open — that is the whole difference between a roster
 *  and a session list. Falls back to the session when there is no agent to own it. */
export const rememberScope = (input: { readonly sessionID: string; readonly agentID: string | undefined }): string =>
  input.agentID !== undefined && input.agentID !== "" ? `agent:${input.agentID}` : `session:${input.sessionID}`

/** Recalled facts that cite an exact filesystem target. This is the provenance gate for automatic
 * correction: a failed read may invalidate a remembered file claim only when that memory actually
 * led the current turn to the missing path. Nearby names (`pi.c.bak`) deliberately do not match. */
export const memoriesMentioningPath = (
  hits: ReadonlyArray<MemoryClient.SearchHit>,
  targets: ReadonlyArray<string>,
): ReadonlyArray<MemoryClient.SearchHit> => {
  const uniqueTargets = [...new Set(targets.map((target) => target.trim()).filter(Boolean))]
  if (uniqueTargets.length === 0) return []
  return hits.filter((hit) => uniqueTargets.some((target) => mentionsExactPath(hit.text, target)))
}

// ── the BOUNDED CONTEXT PACK (P3) ────────────────────────────────────────────────────────────────

/**
 * How many TOKENS of recalled memory a turn may spend, by model tier.
 *
 * 🔴 **A count of items is not a bound on context, and that is what this replaces.** `recallBudget`
 * caps the NUMBER of memories, so five one-line preferences and five ingested passages cost the same
 * budget while differing by two orders of magnitude in window pressure. On the tiers this harness is
 * built for — where the whole window is the scarce resource — that is the difference between recall
 * helping and recall crowding out the task.
 *
 * ⚠️ Both bounds survive, and they bound different things: `recallBudget` sizes the CANDIDATE POOL
 * (rerank cost, measured in latency), and this bounds what the model is actually shown (window
 * cost). Conflating them is the mistake `recallPoolSize` already exists to avoid, one level up.
 *
 * The numbers are deliberately round, because the estimator below is not precise enough for them to
 * be anything else: a micro/tiny model on a 4–8K window can spare a couple of hundred tokens of
 * background before the task starts losing room; a full-tier model can spare an order of magnitude
 * more without noticing.
 */
export const recallTokenBudget = (tier: ModelV2.Tier | undefined): number => {
  switch (tier) {
    case "micro":
    case "tiny":
      return 200
    case "small":
      return 400
    default:
      return 900
  }
}

/**
 * TOKENS, ESTIMATED — four characters to a token, and what this estimate's error costs.
 *
 * 🔴 **Deliberately not a tokenizer call.** This runs inside the user's own turn, before the request
 * is even built, and every model this harness talks to has a different vocabulary — so a "real"
 * count would mean either loading a per-model tokenizer on the hot path or producing a number that
 * is precise about the wrong model. Four characters per token is the standard rough figure for
 * English prose and it costs nothing.
 *
 * ⚠️ **Where it is wrong, and what that costs.** It runs LOW on code, filesystem paths, identifiers
 * and non-Latin scripts — everything that tokenizes into many short pieces — so a pack of file paths
 * can genuinely occupy something like 1.5–2x what this claims. The consequence is bounded and
 * one-directional by design: this is a soft ceiling on BACKGROUND material sitting inside a window
 * that `context-pack` bounds for real, so an underestimate spends a little more of the memory
 * category's allowance than intended and can never overrun the request. The opposite error —
 * overestimating and silently dropping a constraint the user relies on — is the one that would hurt,
 * and the protected tier is what makes it impossible.
 */
export const estimateTokens = (text: string): number => Math.ceil(text.trim().length / 4)

/**
 * The predicates that are CONSTRAINTS: standing instructions about how to behave, not facts to know.
 *
 * A dropped fact makes an answer thinner. A dropped constraint makes it WRONG in a way the user
 * already told us not to be — the wrong language, the wrong time zone, a preference they stated once
 * and expect to hold. That asymmetry is the whole reason for a protected tier, and it is why this
 * set is small: everything in it changes what the model DOES rather than what it knows.
 */
const CONSTRAINT_PREDICATES: ReadonlySet<string> = new Set(["preference", "language", "timezone"])

/** Where a hit sits in the pack. Lower is admitted first, and tier 0 is never truncated. */
export type RecallTier = 0 | 1 | 2

/**
 * ⚠️ **"High-confidence" reads the LIFECYCLE, not the `confidence` column.** Measured 2026-07-20 and
 * still true: no writer sets `confidence` — every occurrence is `input.confidence ?? null` plumbing
 * — so a threshold on it would protect exactly nothing while looking like it protected the right
 * things. What the store genuinely knows is whether the harness ACCEPTED an identity: an `active`
 * claim with a validated `{subject, predicate}` is the current answer to a question the predicate
 * table declares to have exactly one. That is the store's own confidence signal, and unlike the
 * column it is populated.
 */
export const recallTier = (hit: MemoryClient.SearchHit): RecallTier => {
  if (hit.kind === "claim" && hit.status === "active") {
    if (hit.predicate !== null && CONSTRAINT_PREDICATES.has(hit.predicate)) return 0
    if (hit.subject !== null && hit.predicate !== null) return 0
  }
  // Evidence: the passages and sources a claim rests on. Useful, and the first thing to give up —
  // raw source material is what the claim above it already summarises.
  if (hit.kind === "passage" || hit.kind === "source") return 2
  return 1
}

export interface RecallPack {
  /** What the model is shown, in the order it was ranked. */
  readonly shown: ReadonlyArray<MemoryClient.SearchHit>
  /** How many ranked memories did not fit. The block SAYS this — see `formatRecall`. */
  readonly omitted: number
  /** Estimated tokens the shown material occupies. */
  readonly tokens: number
  /** How many of `shown` were admitted by the protection rather than by the budget. */
  readonly protectedCount: number
}

const renderHit = (hit: MemoryClient.SearchHit): string =>
  `- ${hit.name ? `${hit.name}: ` : ""}${hit.text.replaceAll(/\s+/g, " ").trim()}`

/**
 * Fill a fixed token budget: constraints and current claims first and unconditionally, then ordinary
 * context in rank order, then evidence.
 *
 * 🔴 **Tier 0 is admitted BEFORE the budget is consulted, and may exceed it.** "Protected from
 * truncation" is a promise; implementing it as "given the best weight" would leave a long enough
 * passage able to displace a standing instruction. The pool it draws from is already bounded by `k`,
 * so the worst case is bounded too — and the honest failure here is a slightly over-budget pack that
 * kept the user's constraints, not an on-budget one that quietly dropped them.
 *
 * ⚠️ A hit that does not fit is SKIPPED, not stopped on: a long passage must not hide three short
 * facts ranked behind it.
 */
export const packRecall = (hits: ReadonlyArray<MemoryClient.SearchHit>, budget: number): RecallPack => {
  const kept = new Set<string>()
  let tokens = 0
  let protectedCount = 0
  for (const hit of hits)
    if (recallTier(hit) === 0 && !kept.has(hit.id)) {
      kept.add(hit.id)
      tokens += estimateTokens(renderHit(hit))
      protectedCount += 1
    }
  for (const tier of [1, 2] as const)
    for (const hit of hits) {
      if (recallTier(hit) !== tier || kept.has(hit.id)) continue
      const cost = estimateTokens(renderHit(hit))
      if (tokens + cost > budget) continue
      kept.add(hit.id)
      tokens += cost
    }
  // Back into RANKED order. The packer walks by tier, but what the model reads should still be the
  // order the reranker chose — a list that visibly jumps between priorities reads as noise.
  const shown = hits.filter((hit) => kept.has(hit.id))
  return { shown, omitted: hits.length - shown.length, tokens, protectedCount }
}

/**
 * Render a bounded pack as a system-prompt block (undefined if nothing was shown). Linearized; the
 * model is told to USE it silently, not echo the list.
 *
 * 🔴 **The block SAYS when material was left out**, and that sentence is load-bearing rather than
 * polite. A model handed a silently truncated list has no way to know it is reasoning from a
 * fragment, so it answers with the confidence of a complete recall. The harness's rule is that a
 * model which genuinely cannot continue says so in its reply — it can only do that if it knows
 * something is missing, and it can only ask for the rest if it knows there is a rest.
 */
export const formatRecall = (pack: RecallPack): string | undefined => {
  if (pack.shown.length === 0) return undefined
  const lines = pack.shown.map(renderHit)
  const omission =
    pack.omitted > 0
      ? `\n(${pack.omitted} further relevant ${pack.omitted === 1 ? "memory" : "memories"} did not fit this ` +
        `turn's memory budget — ask with the kb tool if you need more.)`
      : ""
  return (
    "Relevant things you remember (from earlier in this chat and from other chats). Use them if " +
    "helpful; don't mention or repeat this list:\n" +
    lines.join("\n") +
    omission
  )
}
