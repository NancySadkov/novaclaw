/**
 * The shell's user-visible soft deadlines.
 *
 * Kept dependency-free because the renderer shows the same bound the executor enforces. A copied
 * UI number is worse than no number: it reassures the user with a deadline the command does not
 * actually have.
 */
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000
export const MAX_TIMEOUT_MS = 10 * 60 * 1_000
export const JOB_WAIT_DEFAULT_TIMEOUT_MS = 30_000
/** Preflight + OS process creation must either establish a job or return control promptly. */
export const COMMAND_LAUNCH_TIMEOUT_MS = 10_000
