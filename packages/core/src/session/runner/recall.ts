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
