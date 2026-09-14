export * as WorkerPurpose from "./worker-purpose"

/** Durable metadata key shared by worker creation and the owner's runtime ledger. */
export const KEY = "novaclaw.worker-purpose"

const LIMIT = 400

/**
 * Preserve the task the parent actually delegated, independently of titles that are generated later.
 * One line keeps the heartbeat compact; the full opening prompt remains in the worker transcript.
 */
export const fromPrompt = (prompt: string) => {
  const oneLine = prompt.replace(/\s+/g, " ").trim()
  return oneLine.length <= LIMIT ? oneLine : `${oneLine.slice(0, LIMIT - 1)}…`
}

export const fromMetadata = (metadata: Record<string, unknown> | null | undefined) => {
  const value = metadata?.[KEY]
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}
