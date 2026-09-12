export * as ToolDeadline from "./tool-deadline"

import { DEFAULT_TIMEOUT_MS, JOB_WAIT_DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from "./tool/bash-deadline"
export { COMMAND_LAUNCH_TIMEOUT_MS } from "./tool/bash-deadline"
import { DEFAULT_TIMEOUT_SECONDS } from "./webfetch-deadline"
import { JOIN_TIMEOUT_MS } from "./session/join-deadline"

/** Shipped officer default. A role may override it; descendants inherit through AgentDefaults. */
export const DEFAULT_MAX_TOOL_TIMEOUT_MS = MAX_TIMEOUT_MS

export interface Resolved {
  readonly limitMs: number
  readonly timeoutMs: number
  readonly requestedMs?: number
}

const objectInput = (input: unknown): Record<string, unknown> | undefined =>
  typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined

/** Top-level `timeout` convention: milliseconds, except webfetch's documented seconds. */
export function requestedMs(tool: string, input: unknown): number | undefined {
  const value = objectInput(input)?.timeout
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined
  return tool === "webfetch" ? value * 1_000 : value
}

function toolDefaultMs(tool: string, input: unknown, limitMs: number): number {
  const record = objectInput(input)
  if (tool === "bash")
    return record?.job !== undefined && record.action === "wait" ? JOB_WAIT_DEFAULT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS
  if (tool === "wait") return JOIN_TIMEOUT_MS
  if (tool === "webfetch") return DEFAULT_TIMEOUT_SECONDS * 1_000
  return limitMs
}

/** One answer used by validation, execution, and the renderer. */
export function resolve(tool: string, input: unknown, configuredLimitMs?: number): Resolved {
  const limitMs =
    configuredLimitMs !== undefined && Number.isSafeInteger(configuredLimitMs) && configuredLimitMs > 0
      ? configuredLimitMs
      : DEFAULT_MAX_TOOL_TIMEOUT_MS
  const requested = requestedMs(tool, input)
  return {
    limitMs,
    timeoutMs: Math.min(requested ?? toolDefaultMs(tool, input, limitMs), limitMs),
    ...(requested === undefined ? {} : { requestedMs: requested }),
  }
}

export function exceedsLimit(tool: string, input: unknown, configuredLimitMs?: number): Resolved | undefined {
  const resolved = resolve(tool, input, configuredLimitMs)
  return resolved.requestedMs !== undefined && resolved.requestedMs > resolved.limitMs ? resolved : undefined
}

export function refusal(tool: string, deadline: Resolved): string {
  const requested = Math.ceil((deadline.requestedMs ?? deadline.timeoutMs) / 1_000)
  const allowed = Math.ceil(deadline.limitMs / 1_000)
  return (
    `Tool ${tool} requested a ${requested}s timeout, above this officer's ${allowed}s maximum. ` +
    `Nothing ran. Call it again with a timeout of ${deadline.limitMs} ms or less; do not retry the same value.`
  )
}

export function expired(tool: string, timeoutMs: number): string {
  const shown = timeoutMs < 1_000 ? `${timeoutMs}ms` : `${Math.ceil(timeoutMs / 1_000)}s`
  return (
    `Tool ${tool} did not return within its ${shown} deadline. ` +
    `Control has returned to you. Treat its outcome as unknown unless the tool reported a durable job id; ` +
    `inspect before retrying any side effect.`
  )
}
