import type { ServerConnection } from "@/context/server"
import { instanceFetch } from "@/utils/instance-fetch"

export interface SessionExecutionInfo {
  readonly sessionID: string
  readonly attemptID: string
  readonly generation: number
  readonly ownerID: string
  readonly state: "starting" | "busy" | "recovering" | "paused" | "failed" | "interrupted" | "settled"
  readonly phase: "drain" | "provider" | "tool" | "maintenance"
  /**
   * 🔴 The thread manager's own flag, joined server-side (owner, 2026-09-26). True while a stop
   * is still in flight in the owning process — the same entry the scheduler's `settle`/`run`
   * read. The button renders its spinner from this, never from a client-local second opinion.
   */
  readonly stopping: boolean
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

export async function sessionExecutions(server: ServerConnection.HttpBase, sessionID?: string, signal?: AbortSignal) {
  const response = await instanceFetch<{ data: SessionExecutionInfo[] }>(server, {
    route: "api/session/execution",
    query: { sessionID },
    signal,
    timeoutMs: 15_000,
  })
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

export async function stopSessionExecution(
  server: ServerConnection.HttpBase,
  sessionID: string,
  directory: string,
  reason?: string,
) {
  await instanceFetch(server, {
    route: `api/session/${encodeURIComponent(sessionID)}/interrupt`,
    method: "POST",
    directory,
    directoryVia: "header",
    timeoutMs: 15_000,
    ...(reason?.trim() ? { body: { reason: reason.trim() } } : {}),
  })
}

/**
 * Stop one running command without interrupting its agent. `commandID` is the durable job id the
 * session command list shows, or the tool-call id of a command still in flight in the transcript.
 */
export async function stopSessionCommand(
  server: ServerConnection.HttpBase,
  sessionID: string,
  directory: string,
  commandID: string,
  reason: string,
) {
  await instanceFetch(server, {
    route: `api/session/${encodeURIComponent(sessionID)}/command/${encodeURIComponent(commandID)}/stop`,
    method: "POST",
    directory,
    directoryVia: "header",
    body: { reason: reason.trim() },
  })
}
