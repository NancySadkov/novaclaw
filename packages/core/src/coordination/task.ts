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
