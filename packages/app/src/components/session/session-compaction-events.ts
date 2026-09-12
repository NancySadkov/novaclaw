import type { SessionMessage } from "@novaclaw/sdk/v2/client"

export interface SessionCompactionEvent {
  readonly id: string
  readonly at: number
  readonly cause: "manual" | "overflow" | "threshold"
  readonly beforeTokens?: number
  readonly afterTokens?: number
  readonly status: "completed" | "failed" | "running"
  readonly failure?: string
}

const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined

const cause = (
  message: Extract<SessionMessage, { type: "compaction" | "compaction-status" }>,
): SessionCompactionEvent["cause"] => {
  const value = message.metadata?.["compaction.cause"]
  if (value === "manual" || value === "overflow" || value === "threshold") return value
  return message.reason === "manual" ? "manual" : "threshold"
}

/** Newest-first operational compaction log derived from the transcript's first-class audit rows. */
export const sessionCompactionEvents = (messages: readonly SessionMessage[]): SessionCompactionEvent[] =>
  messages
    .filter(
      (message): message is Extract<SessionMessage, { type: "compaction" | "compaction-status" }> =>
        message.type === "compaction" || message.type === "compaction-status",
    )
    .map(
      (message): SessionCompactionEvent => ({
        id: message.id,
        at: message.time.created,
        cause: cause(message),
        beforeTokens: finite(message.metadata?.["compaction.before.tokens"]),
        afterTokens: finite(message.metadata?.["compaction.after.tokens"]),
        status: message.type === "compaction" ? "completed" : message.status,
        ...(message.type === "compaction-status" && message.failure ? { failure: message.failure } : {}),
      }),
    )
    .reverse()
