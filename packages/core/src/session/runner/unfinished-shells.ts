export * as UnfinishedShells from "./unfinished-shells"

import type { RunningJob } from "../../tool/bash-jobs"

const NAME_LIMIT = 5
const COMMAND_ECHO = 120

const command = (value: string) =>
  value.length <= COMMAND_ECHO ? value : `${value.slice(0, COMMAND_ECHO).trimEnd()}…`

/**
 * A background command is child work, not a detached side effect the session may forget. Completion
 * is refused while any job the session owns is still running; the agent must join it or stop it.
 */
export const exitNudge = (jobs: readonly RunningJob[]): string => {
  const named = jobs.slice(0, NAME_LIMIT)
  const remaining = jobs.length - named.length
  return (
    `Not finished: ${jobs.length} background shell command${jobs.length === 1 ? " is" : "s are"} still running. ` +
    `A session may not exit while child work is alive:\n` +
    named
      .map(
        (job) =>
          `- ${job.id}: ${command(job.command)} — wait with {"job":"${job.id}","action":"wait","timeout":30000}; ` +
          `if it is hung, stop it with {"job":"${job.id}","action":"stop"}.`,
      )
      .join("\n") +
    (remaining > 0 ? `\n- …and ${remaining} more, same treatment.` : "") +
    `\nCheck every job until it has finished or been stopped, then request exit again.`
  )
}
