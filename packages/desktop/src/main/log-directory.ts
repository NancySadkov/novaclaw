import { join } from "node:path"
import type { StartupNotice } from "./boot"

/**
 * Where the desktop process writes its own logs — and what it says when it cannot write them
 * anywhere.
 *
 * ⚠️ `initRunDirectory` used to be three unguarded lines:
 *
 *     root = join(app.getPath("userData"), "logs")
 *     run  = join(root, stamp())
 *     mkdirSync(run, { recursive: true })
 *
 * called from `index.ts`'s FIRST real step. On an unwritable profile directory (EACCES / EPERM /
 * EROFS / ENOSPC, a roaming profile that never mounted, a locked-down machine) that throw killed
 * the main process *before the logger it was building existed* — so: no window, no dialog, and no
 * log line anywhere. From outside it looked exactly like a slow sidecar: nothing happens when I
 * launch it. (`notes/reports/startup-classification-2026-08-07.md` §3 step 3, finding 5.)
 *
 * The decision is pure and takes its `mkdir` as an argument on purpose. The failure is a syscall on
 * a directory a test cannot reliably make unwritable on every platform this ships to, so a fake
 * `mkdir` that throws is the only way this path is ever exercised before a user reaches it.
 */
export type LogDirectory =
  /** The preferred directory took the write. */
  | { readonly kind: "ready"; readonly root: string; readonly run: string }
  /** The preferred directory refused; a later candidate took the write. Logs still land. */
  | {
      readonly kind: "fallback"
      readonly root: string
      readonly run: string
      readonly preferred: string
      readonly reason: string
    }
  /** Nothing was writable. The file transport must be switched OFF rather than aimed at the cwd. */
  | { readonly kind: "unavailable"; readonly attempted: readonly string[]; readonly reason: string }

/**
 * Try each candidate root in order, creating `<root>/<stamp>`. The first that accepts the write
 * wins; every refusal is remembered so the outcome can name itself.
 */
export function resolveLogDirectory(
  candidates: readonly string[],
  stamp: string,
  mkdir: (dir: string) => void,
): LogDirectory {
  const refusals: string[] = []

  for (const root of candidates) {
    const run = join(root, stamp)
    try {
      mkdir(run)
    } catch (error) {
      refusals.push(describeError(error))
      continue
    }
    if (refusals.length === 0) return { kind: "ready", root, run }
    return { kind: "fallback", root, run, preferred: candidates[0] ?? root, reason: refusals[0] }
  }

  return {
    kind: "unavailable",
    attempted: [...candidates],
    reason: refusals[0] ?? "no log directory was offered",
  }
}

/** What goes in the log. A degraded logger still says, in its own output, that it is degraded. */
export function describeLogDirectory(result: LogDirectory):
  | {
      readonly level: "warn" | "error"
      readonly message: string
      readonly meta: Record<string, unknown>
    }
  | undefined {
  if (result.kind === "ready") return undefined
  if (result.kind === "fallback")
    return {
      level: "warn",
      message: "log directory unwritable — using a fallback",
      meta: { preferred: result.preferred, using: result.run, reason: result.reason },
    }
  return {
    level: "error",
    message: "no writable log directory — file logging is off for this run",
    meta: { attempted: result.attempted, reason: result.reason },
  }
}

/**
 * What the USER is shown, and only that.
 *
 * A `fallback` is deliberately silent to the user: logs still land, the app is whole, and
 * `AGENTS.md`'s managed-by-default stance says a common user is helped rather than handed a pager.
 * `unavailable` is different in kind — the profile directory refused every write, which will break
 * far more than logging, and there is by definition no log for anyone to find afterwards. That one
 * gets one calm sentence.
 */
export function logDirectoryNotice(result: LogDirectory): StartupNotice | undefined {
  if (result.kind !== "unavailable") return undefined
  return {
    code: "logging.directory.unavailable",
    summary: "NovaClaw could not write to its profile folder, so it cannot save logs this run.",
    detail: [
      `Tried: ${result.attempted.join(", ") || "<no candidate>"}`,
      `Reason: ${result.reason}`,
      "NovaClaw will keep running, but if something goes wrong there will be nothing to send us.",
      "Check that the folder exists and that your account is allowed to write to it.",
    ].join("\n"),
  }
}

function describeError(error: unknown) {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code
    return code ? `${code}: ${error.message}` : error.message
  }
  return String(error)
}
