/** Recovery facts for controller-owned child joins. */
export * as RecoveryJoin from "./recovery-join"

import type { SessionMessage } from "../message"

/** Child joins interrupted by process loss. `wait` is an observation: losing its caller never
 * cancels the child, and treating it like an unknown write is what made a recovered parent redo a
 * live child's files. */
export const interruptedChildIDs = (messages: readonly SessionMessage.Message[]): string[] => {
  const ids = new Set<string>()
  for (const message of messages) {
    if (message.type !== "assistant") continue
    for (const part of message.content) {
      if (part.type !== "tool" || part.name !== "wait") continue
      if (part.state.status !== "pending" && part.state.status !== "running") continue
      let input: unknown = part.state.input
      if (typeof input === "string") {
        try {
          input = JSON.parse(input)
        } catch {
          continue
        }
      }
      if (typeof input !== "object" || input === null) continue
      const sessionID = (input as Record<string, unknown>)["sessionID"]
      if (typeof sessionID === "string" && sessionID.length > 0) ids.add(sessionID)
    }
  }
  return [...ids]
}
