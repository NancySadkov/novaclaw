export * as MessengerOwnership from "./ownership"

import { Effect } from "effect"
import { AgentV2 } from "../agent"

export interface SessionRecord {
  readonly parentID?: string | undefined
  readonly agent?: string | null | undefined
}

export const belongsTo = (
  agentID: string,
  sessionID: string,
  read: (id: string) => Effect.Effect<SessionRecord | undefined>,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const visited = new Set<string>()
    let current: string | undefined = sessionID
    while (current !== undefined && !visited.has(current)) {
      visited.add(current)
      const record: SessionRecord | undefined = yield* read(current)
      if (record === undefined) return false
      if (record.parentID === undefined) return (record.agent?.trim() || AgentV2.DEFAULT_COLLEAGUE_ID) === agentID
      current = record.parentID
    }
    return false
  })
