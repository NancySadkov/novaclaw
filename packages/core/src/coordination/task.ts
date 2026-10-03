/**
 * The coordination task's pure half: its LIMIT and the words a reader sees.
 *
 * ⚠️ Separate from `coordination.ts` on purpose. The system prompt renders this text on every turn
 * and must stay free of the database — importing the store there to share one string would drag
 * drizzle, the session SQL and the Team Chat membership query into the prompt composer. Wording is
 * testable only when it is data, so the wording lives here and both readers import it.
 */

/** One short line. Anything longer belongs in a file the officer points at, not in the prompt. */
export const TASK_MAX = 280

/** The single spelling for "there is no task", so the prompt and the board cannot disagree. */
export const NONE = "none set yet"

export const taskOrNone = (task: string | undefined): string => {
  const trimmed = task?.trim()
  return trimmed === undefined || trimmed.length === 0 ? NONE : trimmed
}

export const taskTooLongNotice = (length: number): string =>
  `A coordination task is at most ${TASK_MAX} characters and this one has ${length}. It is quoted ` +
  "verbatim into every officer's system prompt on every turn, so keep it a short line. If the work " +
  "needs more room, store the detail in a file and make the task point at it."

/**
 * The coordination tasks keyed by agent id, as the kernel materialises them into the system prompt.
 *
 * 🔴 A SNAPSHOT, not the live store: the prompt must stay byte-stable for the whole epoch, so a task
 * change reaches the model at the next compaction rather than the next turn (owner, 2026-10-03) —
 * the same rule the memo area follows. `undefined` means "not materialised yet" (a fresh session),
 * while an empty map is a materialised board with no tasks.
 */
export interface TaskSnapshot {
  readonly tasks: Readonly<Record<string, string>>
}

export const snapshotOf = (tasks: ReadonlyMap<string, string>): TaskSnapshot => ({
  tasks: Object.fromEntries(tasks),
})

export const tasksOf = (value: unknown): ReadonlyMap<string, string> | undefined => {
  if (typeof value !== "object" || value === null || !("tasks" in value)) return undefined
  const record = (value as { tasks: unknown }).tasks
  if (typeof record !== "object" || record === null) return undefined
  const result = new Map<string, string>()
  for (const [agent, task] of Object.entries(record)) if (typeof task === "string") result.set(agent, task)
  return result
}

