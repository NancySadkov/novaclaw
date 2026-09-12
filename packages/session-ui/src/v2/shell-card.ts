import * as Timestamp from "@novaclaw/schema/time"
import { DEFAULT_TIMEOUT_MS, JOB_WAIT_DEFAULT_TIMEOUT_MS } from "@novaclaw/core/tool/bash-deadline"
import { JOIN_TIMEOUT_MS } from "@novaclaw/core/session/join-deadline"

/** Friendly fallback while the parallel model label is not available yet. Never expose a blank `Shell`. */
export function shellActionTitle(command: string): string {
  const text = command.trim().toLowerCase()
  if (/\b(bun|npm|pnpm|yarn)\b.*\btest\b|\b(pytest|vitest|jest)\b/.test(text)) return "Run tests"
  if (/\b(typecheck|tsc|tsgo)\b/.test(text)) return "Check types"
  if (/\b(rg|grep|findstr)\b/.test(text)) return "Search the project"
  if (/\bgit\s+(status|diff|log|show)\b/.test(text)) return "Inspect changes"
  if (/\b(build|compile)\b/.test(text)) return "Build the app"
  if (/\b(ls|dir|get-childitem)\b/.test(text)) return "List files"
  return "Run a terminal command"
}

export function toolTimeoutMs(name: string, input: Record<string, unknown>): number | undefined {
  if (name === "wait") return JOIN_TIMEOUT_MS
  if (name !== "bash") return undefined
  const supplied = input.timeout
  if (typeof supplied === "number" && Number.isFinite(supplied) && supplied > 0) return supplied
  return input.job !== undefined && input.action === "wait" ? JOB_WAIT_DEFAULT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS
}

export function commandElapsed(
  started: unknown,
  completed: unknown,
  now: number,
  timeoutMs?: number,
): string | undefined {
  const elapsed = Timestamp.elapsedMillis(started, completed ?? now)
  if (elapsed === undefined) return undefined
  const elapsedSeconds = Math.max(0, Math.floor(elapsed / 1000))
  if (timeoutMs === undefined) return `${elapsedSeconds}s`
  return `${elapsedSeconds}s / ${Math.ceil(timeoutMs / 1000)}s`
}
