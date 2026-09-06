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

export function commandElapsed(
  started: unknown,
  completed: unknown,
  now: number,
): string | undefined {
  const millis = (value: unknown): number | undefined => {
    if (typeof value === "number") return Number.isFinite(value) ? value : undefined
    if (value instanceof Date) {
      const at = value.getTime()
      return Number.isFinite(at) ? at : undefined
    }
    if (typeof value !== "object" || value === null) return undefined
    const at = (value as { epochMillis?: unknown }).epochMillis
    return typeof at === "number" && Number.isFinite(at) ? at : undefined
  }

  const began = millis(started)
  if (began === undefined) return undefined
  const ended = millis(completed) ?? now
  if (!Number.isFinite(ended)) return undefined
  const seconds = Math.max(0, Math.floor((ended - began) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}
