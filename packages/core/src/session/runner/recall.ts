export * as SessionRecall from "./recall"

import type { ModelV2 } from "../../model"
import type { MemoryClient } from "../../kb-graph/memory-client"
import type { SessionMessage } from "../message"

// Auto-recall (notes/kb-graph-plan.md §1.3.1): each turn, surface relevant memories into the system
// prompt so the model "just remembers" — the user (and other chats') facts show up without the agent
// having to call the `kb` tool. Pure helpers here (the runner does the search + injection). Budgeted
// DOWN for weak models (the JH floor) so recalled memory never crowds out the task.

/** The recall query = the latest user message's text (what this turn is about); undefined if none. */
export const recallQuery = (context: ReadonlyArray<SessionMessage.Message>): string | undefined => {
  for (let i = context.length - 1; i >= 0; i--) {
    const message = context[i]
    if (message.type === "user") {
      const text = message.text?.trim()
      return text && text.length > 0 ? text : undefined
    }
  }
  return undefined
}

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
