// Pure attention aggregation (uix-improvement slice 2) — kept free of context/router imports so it
// is unit-testable outside the browser env. `chats-attention.ts` wraps it reactively.
import type { PermissionV2Request, QuestionRequest } from "@novaclaw/sdk/v2/client"

export type AttentionInput = {
  permission: Record<string, readonly PermissionV2Request[] | undefined>
  question: Record<string, readonly QuestionRequest[] | undefined>
  unseen: readonly string[]
  countsAsk: (ask: PermissionV2Request) => boolean
}

/**
 * The two attention tiers, deduped: `waiting` = blocked on the USER (a pending permission ask
 * auto-accept won't settle, or a pending question) — always outranks `unseen` = output the user
 * hasn't looked at yet (a session in both tiers reports only as waiting).
 */
export function attentionSets(input: AttentionInput): { waiting: string[]; unseen: string[] } {
  const waiting = new Set<string>()
  for (const [sessionID, asks] of Object.entries(input.permission)) {
    if (asks?.some(input.countsAsk)) waiting.add(sessionID)
  }
  for (const [sessionID, questions] of Object.entries(input.question)) {
    if (questions?.length) waiting.add(sessionID)
  }
  return { waiting: [...waiting], unseen: input.unseen.filter((sessionID) => !waiting.has(sessionID)) }
}

/** Union of both tiers, deduped by session id (the launcher-badge count). */
export function attentionSessionIds(input: AttentionInput): string[] {
  const sets = attentionSets(input)
  return [...sets.waiting, ...sets.unseen]
}
