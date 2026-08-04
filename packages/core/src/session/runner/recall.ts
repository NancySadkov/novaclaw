export * as SessionRecall from "./recall"

import { lastRealUserText } from "../steer-provenance"
import type { ModelV2 } from "../../model"
import type { MemoryClient } from "../../kb-graph/memory-client"
import type { SessionMessage } from "../message"

// Auto-recall (notes/kb-graph-plan.md §1.3.1): each turn, surface relevant memories into the system
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
 *  penalised weak models exactly where recall matters most: MEASURED (notes/kb-graph-plan.md, the D20
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

/** Render recalled memories as a system-prompt block (undefined if none). Linearized; the model is
 *  told to USE it silently, not echo the list. */
export const formatRecall = (hits: ReadonlyArray<MemoryClient.SearchHit>): string | undefined => {
  if (hits.length === 0) return undefined
  const lines = hits.map((hit) => `- ${hit.name ? `${hit.name}: ` : ""}${hit.text.replaceAll(/\s+/g, " ").trim()}`)
  return (
    "Relevant things you remember (from earlier in this chat and from other chats). Use them if " +
    "helpful; don't mention or repeat this list:\n" +
    lines.join("\n")
  )
}
