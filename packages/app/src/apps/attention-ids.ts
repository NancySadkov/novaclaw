// Pure attention aggregation (uix-improvement slice 2) — kept free of context/router imports so it
// is unit-testable outside the browser env. `chats-attention.ts` wraps it reactively.
import type { PermissionV2Request, QuestionRequest } from "@novaclaw/sdk/v2/client"

/** Union of the three attention sources, deduped by session id. */
export function attentionSessionIds(input: {
  permission: Record<string, readonly PermissionV2Request[] | undefined>
  question: Record<string, readonly QuestionRequest[] | undefined>
  unseen: readonly string[]
  countsAsk: (ask: PermissionV2Request) => boolean
}): string[] {
  const ids = new Set<string>()
  for (const [sessionID, asks] of Object.entries(input.permission)) {
    if (asks?.some(input.countsAsk)) ids.add(sessionID)
  }
  for (const [sessionID, questions] of Object.entries(input.question)) {
    if (questions?.length) ids.add(sessionID)
  }
  for (const sessionID of input.unseen) ids.add(sessionID)
  return [...ids]
}
