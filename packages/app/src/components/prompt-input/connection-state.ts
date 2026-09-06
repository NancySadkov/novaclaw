import type { ServerStreamStatus } from "@/context/server-sdk"

/** The numbered attempt shown instead of an input while its source of truth is unavailable. */
export function reconnectingPromptAttempt(status: ServerStreamStatus, attempt: number): number | undefined {
  if (status === "connected") return undefined
  return Math.max(1, Math.floor(attempt))
}
