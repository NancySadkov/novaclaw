export interface HarnessWaitAttempt {
  readonly state: string
  readonly phase: "drain" | "provider" | "tool" | "maintenance"
  readonly toolName?: string
  readonly toolSideEffect?: "read" | "idempotent-write" | "non-idempotent" | "external-unknown"
  readonly toolState?: "dispatched" | "settled"
}

const FILE_TOOLS = new Set([
  "apply_patch",
  "edit",
  "glob",
  "grep",
  "list",
  "read",
  "read_hex",
  "read-hex",
  "trash",
  "write",
  "write_hex",
  "write-hex",
])
const THREAD_TOOLS = new Set(["colleague", "session", "spawn", "spawn_agent", "wait"])

/**
 * Translate the durable execution record into the temporary stall the harness actually records.
 *
 * `session_execution.phase`, `tool_name`, `tool_side_effect`, and `tool_state` are persisted before
 * work crosses the provider/tool boundary. This renderer therefore does not infer an ending from a
 * missing live-status event: it presents the last durable boundary, and uses the generic harness
 * label only when that record genuinely cannot be more specific.
 */
export const harnessWaitLabel = (
  attempt: HarnessWaitAttempt | undefined,
  options?: { readonly transcriptReconciliation?: boolean },
): string | undefined => {
  if (options?.transcriptReconciliation) return "Syncing the transcript…"
  if (!attempt) return undefined
  if (attempt.state === "recovering") return "Recovering the agent…"
  if (attempt.state === "paused") return "Waiting for recovery approval…"
  if (attempt.phase === "provider") return "Waiting for the model…"
  if (attempt.phase === "maintenance") return "Waiting for maintenance…"
  if (attempt.phase !== "tool" || attempt.toolState === "settled") return undefined

  const name = attempt.toolName?.toLowerCase()
  if (!name) return "Waiting for a tool…"
  if (name === "bash" || name === "bash_jobs" || name === "bash-jobs") return "Waiting for a shell command…"
  if (THREAD_TOOLS.has(name)) return "Syncing with another thread…"
  if (FILE_TOOLS.has(name)) return "Waiting for file access…"
  if (name === "computer") return "Waiting for computer control…"
  return `Waiting for ${attempt.toolName}…`
}
