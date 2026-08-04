import type { ServerConnection } from "@/context/server"
import { instanceFetch } from "@/utils/instance-fetch"

export interface SessionExecutionInfo {
  readonly sessionID: string
  readonly attemptID: string
  readonly generation: number
  readonly ownerID: string
  readonly state: "starting" | "busy" | "recovering" | "paused" | "failed" | "interrupted" | "settled"
  readonly phase: "drain" | "provider" | "tool" | "maintenance"
  readonly heartbeatAt: number
  readonly checkpointAt?: number
  readonly failureClass?: string
  readonly failureDetail?: string
  readonly failureCount: number
  readonly toolCallID?: string
  readonly toolName?: string
  readonly toolSideEffect?: "read" | "idempotent-write" | "non-idempotent" | "external-unknown"
  readonly toolState?: "dispatched" | "settled"
  readonly startedAt: number
  readonly updatedAt: number
}

export async function sessionExecutions(server: ServerConnection.HttpBase) {
  const response = await instanceFetch<{ data: SessionExecutionInfo[] }>(server, { route: "api/session/execution" })
  return response.data
}

export async function retrySessionExecution(server: ServerConnection.HttpBase, sessionID: string, directory: string) {
  await instanceFetch(server, {
    route: `api/session/${encodeURIComponent(sessionID)}/execution/retry`,
    method: "POST",
    directory,
    directoryVia: "header",
  })
}

export async function stopSessionExecution(server: ServerConnection.HttpBase, sessionID: string, directory: string) {
  await instanceFetch(server, {
    route: `api/session/${encodeURIComponent(sessionID)}/interrupt`,
    method: "POST",
    directory,
    directoryVia: "header",
  })
}
