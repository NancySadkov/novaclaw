export * as ExitIntent from "./exit-intent"

import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { FSUtil } from "@novaclaw/core/fs-util"
import { Global } from "@novaclaw/core/global"

/**
 * The child's half of the watchdog protocol — saying *why* it is leaving.
 *
 * `packages/watchdog` supervises this process and must tell a crash from a goodbye. An exit code
 * cannot carry *"restart me in an hour"*, and a file alone can be stale or half-written, so the
 * watchdog requires **two independent signals that agree**: the reserved exit code below AND an
 * intent document. This module writes the document and names the code.
 *
 * 🔴 **Silence means CRASH, and that is the safe default rather than an oversight.** Every path that
 * ends this process without calling `write` — a segfault, an OOM kill, a `TerminateProcess`, an
 * unhandled rejection — leaves no intent, and the watchdog restarts. The failure this whole
 * mechanism exists to prevent is work vanishing silently; an unwanted restart is visible and
 * stoppable, so ambiguity resolves toward coming back.
 */

/**
 * The exit status the watchdog requires before it will honour an intent.
 *
 * ⚠️ Must equal `INTENT_EXIT_CODE` in `packages/watchdog/src/main.rs`. It is 77 rather than 0
 * because an ordinary tidy exit is also 0 — a handled Ctrl-C, a library calling `exit(0)` — and a
 * signal that every clean shutdown emits by accident cannot mean "I chose this".
 */
export const EXIT_CODE = 77

/**
 * Where the watchdog put its state directory, or `undefined` when nothing is supervising us.
 *
 * 🔴 **This is what keeps an unsupervised run's behaviour BYTE-IDENTICAL.** Exiting 77 on Ctrl-C
 * when no watchdog is listening would change the status every script, CI job and shell sees for an
 * ordinary stop. The env var is set by the watchdog and by nothing else, so its absence is a
 * complete answer: exit the way this process always has.
 */
export const VAR = "NOVACLAW_WATCHDOG_STATE"

/**
 * Roots in which NovaClaw is allowed to own watchdog protocol bytes.
 *
 * The environment says which supervision edge is present; it does not grant filesystem authority.
 * Keep that authority rooted in the instance directories or the OS temp directory. A caller with a
 * real project root may pass it explicitly through `trustedRoots` — an ambient cwd is not proof that
 * a folder is a selected project.
 */
export const trustedStateRoots = (): readonly string[] => [
  Global.Path.data,
  Global.Path.cache,
  Global.Path.config,
  Global.Path.state,
  Global.Path.tmp,
  os.tmpdir(),
]

/** Canonical containment closes the ordinary symlink/junction escape for prospective paths. */
export const isTrustedStateDir = (dir: string, trustedRoots?: readonly string[]): boolean => {
  if (!path.isAbsolute(dir)) return false
  try {
    return (trustedRoots ?? trustedStateRoots()).some(
      (root) => path.isAbsolute(root) && FSUtil.containsCanonical(root, dir),
    )
  } catch {
    return false
  }
}

export const stateDir = (
  env: Record<string, string | undefined> = process.env,
  trustedRoots?: readonly string[],
): string | undefined => {
  const dir = env[VAR]
  // Preserve the historical unsupervised path without even resolving instance directories.
  return dir === undefined || dir === "" || !isTrustedStateDir(dir, trustedRoots) ? undefined : dir
}

/**
 * The environment for a process WE spawn — with the watchdog's state directory removed.
 *
 * 🔴 **The state directory names one supervision edge, not a lineage.** It says *"the watchdog
 * immediately above you is listening at this path"*, and a child that passes it on hands a
 * grandchild the authority to write a document about a process it is not.
 *
 * That matters here because `serve --supervise` is itself a supervisor: watchdog → supervisor →
 * server. Inherit the variable and the innermost server can answer a question the watchdog asked the
 * supervisor. The direction it fails in is the bad one — the server stopping cleanly leaves a
 * `shutdown` document behind, and when the SUPERVISOR later dies of something real, the watchdog
 * reads that stale intent, believes the stop was deliberate, and stays down. That is precisely the
 * outcome this whole mechanism exists to prevent (owner, 2026-08-29: *"why are crashed runs lost
 * forever?"*).
 *
 * ⚠️ Today the inner server writes no intent, so nothing is broken yet. This is not a fix for a live
 * bug; it is the reason the OTHER half of this change — teaching the plain server to emit intent so a
 * watchdog can supervise it directly — is safe to make. Landing that half without this one arms the
 * trap above. They belong in one commit for that reason.
 */
export const childEnv = (env: Record<string, string | undefined> = process.env): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) if (key !== VAR && value !== undefined) out[key] = value
  return out
}

export type Intent =
  /** Stay down. The watchdog exits too. */
  | { readonly kind: "shutdown" }
  /** Come back immediately — a binary replacement, or an operator-requested bounce. */
  | { readonly kind: "restart" }
  /**
   * Come back at an absolute instant.
   *
   * ⚠️ Absolute, not a duration: *"be back at nine"* survives the watchdog itself being restarted,
   * where a duration would restart its own countdown.
   */
  | { readonly kind: "dormant"; readonly wakeAtMs: number }

export const serialise = (intent: Intent): string => JSON.stringify(intent)

/**
 * Write the intent, atomically, and never throw.
 *
 * ⚠️ **Atomic by rename.** A watchdog reading a half-flushed file would see a truncated document —
 * which it correctly treats as a crash, so the failure is safe, but it is also avoidable: write a
 * sibling `.tmp` and rename, which is atomic on both platforms.
 *
 * ⚠️ **Synchronous.** The only callers are on the way out, and nothing async survives `process.exit`.
 *
 * 🔴 **Never throws, and returns whether it succeeded.** A failed write must not be able to block a
 * shutdown that is already happening; the consequence is simply that the watchdog reads no intent
 * and restarts — the safe direction again. Callers that care can log the `false`.
 */
export const write = (dir: string, intent: Intent, trustedRoots?: readonly string[]): boolean => {
  if (!isTrustedStateDir(dir, trustedRoots)) return false
  try {
    mkdirSync(dir, { recursive: true })
    const target = path.join(dir, "exit-intent.json")
    const temporary = `${target}.tmp`
    writeFileSync(temporary, serialise(intent))
    renameSync(temporary, target)
    return true
  } catch {
    return false
  }
}

/**
 * Record an intent if a watchdog is listening, and answer the exit code to use.
 *
 * The one call every shutdown path wants: unsupervised runs get their historical code, supervised
 * ones get the reserved code AND a document, and the two can never disagree because one function
 * produces both.
 *
 * @param unsupervised the status to use when nothing is supervising — the code this path used before
 *   the watchdog existed.
 */
export const settle = (
  intent: Intent,
  unsupervised = 0,
  env: Record<string, string | undefined> = process.env,
  trustedRoots?: readonly string[],
): number => {
  const dir = stateDir(env, trustedRoots)
  if (dir === undefined) return unsupervised
  // ⚠️ If the write fails we must NOT return the reserved code: that would be the clean status with
  // no document, which the watchdog reads as a crash anyway — but by returning the ordinary code we
  // keep the two signals honest rather than emitting half a promise.
  return write(dir, intent, trustedRoots) ? EXIT_CODE : unsupervised
}
