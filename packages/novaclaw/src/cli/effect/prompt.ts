import * as prompts from "@clack/prompts"
import { Effect } from "effect"

/**
 * OUTPUT ONLY, since 2026-09-03.
 *
 * 🔴 This module used to export `select`, `autocomplete`, `text` and `password` beside the printing
 * helpers, and that adjacency was the defect: reaching for blocking input was one call, exactly as
 * short as printing a line, with no refusal built in. Five command leaves took it, and each one hung
 * forever in CI — where a killed process's output is discarded, so the operator saw nothing at all.
 * The leaves are pruned (principle 7: the CLI is vestigial and headless-only) and the primitives
 * went with them, so the shortest path is now the correct one.
 *
 * ⚠️ What remains writes to the terminal and returns: `intro`, `outro`, `log.*` and `spinner`.
 * `refuse-instead-of-blocking.test.ts` scans every file under `src/cli` for a blocking call, and
 * its allowlist is empty; adding one back here would give that scan something to find.
 */

export const intro = (msg: string) => Effect.sync(() => prompts.intro(msg))
export const outro = (msg: string) => Effect.sync(() => prompts.outro(msg))

export const log = {
  info: (msg: string) => Effect.sync(() => prompts.log.info(msg)),
  error: (msg: string) => Effect.sync(() => prompts.log.error(msg)),
  warn: (msg: string) => Effect.sync(() => prompts.log.warn(msg)),
  success: (msg: string) => Effect.sync(() => prompts.log.success(msg)),
}

export const spinner = () => {
  const s = prompts.spinner()
  return {
    start: (msg: string) => Effect.sync(() => s.start(msg)),
    stop: (msg: string, code?: number) => Effect.sync(() => s.stop(msg, code)),
  }
}
