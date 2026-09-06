import { Cause } from "effect"

/**
 * One named, human-readable thing that went wrong while the app was coming up.
 *
 * `summary` is ONE sentence written for a person and is the only part a non-developer should
 * ever see; `detail` is the pretty-printed cause and belongs in the log (and, later, Developer
 * mode). Ruling 2 — an unavailable subsystem names itself — is what this type is for: every boot
 * fault below reports through it rather than dying into a blank screen.
 */
export type StartupNotice = {
  readonly code: string
  readonly summary: string
  /** Present only for `sidecar.database.unusable`, and only when the file was known. */
  readonly databasePath?: string
  readonly detail: string
}

export type SidecarHealthFailure = StartupNotice & {
  readonly kind: "timeout" | "interrupted" | "error"
}

/**
 * Which wait failed. There are two, and they fail for different reasons — the `stage` exists
 * because the first draft of this function had ONE wording and used it for both, so a port probe
 * that timed out would have been reported to the log as *"did not pass its health check"*. That is
 * ruling 2 broken by the very function written to satisfy it: a fault described falsely is worse
 * than a fault described vaguely, because it sends the next reader to the wrong subsystem.
 */
export type SidecarStage =
  /** Anything up to and including the spawn: `preferAppEnv`, the port probe, `superviseLocalServer`. */
  | "startup"
  /** The post-spawn `/global/health` gate, by which point credentials are already published. */
  | "health"

/**
 * Classify a failed sidecar wait.
 *
 * ⚠️ This exists because of a defect/typed-error mismatch that swallowed a real crash. `index.ts`
 * used to wrap `Effect.promise(() => health.wait)` in `Effect.catch` — and `Effect.catch` does not
 * see defects (`effect@4.0.0-beta.83`, `src/Effect.ts`: *"It will not recover from unrecoverable
 * defects."*), while `Effect.promise` turns a REJECTION into exactly that. `health.wait` genuinely
 * rejects when the child dies mid-startup (`server.ts` — *"Sidecar exited before health check
 * passed with code …"*), so the crash arm bypassed the handler entirely, fell through to
 * `forwardInitializationFailure`'s `tapCause`, and called `Deferred.failCause` on a Deferred that
 * had already SUCCEEDED — a no-op. The reason was logged nowhere.
 * (`notes/reports/startup-classification-2026-08-07.md` §3, finding 6.)
 *
 * The lifecycle now catches promise failures explicitly; classification stays here where it can be
 * exercised without Electron.
 */
/**
 * Is this defect the database refusing to open, with its classification intact?
 *
 * ⚠️ Structural, not `instanceof`. The defect crosses a package boundary and may have been squashed
 * and re-wrapped on the way; matching the tag and the fields it must carry is what survives that,
 * and it degrades to "not a database fault" rather than throwing if the shape ever changes.
 */
function isDatabaseUnusable(value: unknown): value is {
  readonly fault: { summary: string; repair: readonly string[]; detail: string; path?: string }
} {
  if (typeof value !== "object" || value === null) return false
  const tagged = value as {
    _tag?: unknown
    fault?: { summary?: unknown; repair?: unknown; detail?: unknown; path?: unknown }
  }
  if (tagged._tag !== "DatabaseUnusable") return false
  return (
    typeof tagged.fault?.summary === "string" &&
    Array.isArray(tagged.fault.repair) &&
    typeof tagged.fault.detail === "string"
  )
}

export function describeSidecarFailure(
  cause: Cause.Cause<unknown>,
  stage: SidecarStage = "startup",
): SidecarHealthFailure {
  const detail = Cause.pretty(cause)

  if (Cause.hasInterruptsOnly(cause))
    return {
      kind: "interrupted",
      code: `sidecar.${stage}.interrupted`,
      summary: "NovaClaw stopped waiting for the local server because the app is shutting down.",
      detail,
    }

  const squashed = Cause.squash(cause)
  /**
   * 🔴 **NC-REL-024 — the database's own classification was being thrown away here.**
   *
   * `database.ts` distinguishes unreadable / corrupt / foreign / migration faults, writes a
   * non-developer `summary` and a concrete `repair` list, and packages both into the defect
   * deliberately. Its comment names this function as the intended consumer: the payload carries the
   * whole `Fault` *"so a caller that catches the cause (the desktop's `describeSidecarFailure`
   * shape, a future Recovery surface) gets the classification rather than a re-parse of an English
   * sentence."*
   *
   * Nothing ever caught it. So a user whose database came from a newer NovaClaw — a completely
   * ordinary thing after a downgrade — got a pretty-printed Effect cause in an error box, and the
   * sentence explaining it sat unused in the payload.
   *
   * ⚠️ This does NOT build the Recovery surface both NC-REL-024 and NC-REL-030 ask for; the app still
   * cannot start. What it changes is that the dialog now says which fault it is and what to do about
   * it, instead of a stack trace. AGENTS.md is explicit that "our users are not server admins" —
   * filesystem homework is the thing to remove, and a named cause with steps is the first half of
   * removing it.
   */
  if (isDatabaseUnusable(squashed))
    return {
      // `error`, not `timeout`: the sidecar answered — it REFUSED. Reporting a refusal as a timeout
      // is the "fault described falsely" this function's own comment was written against.
      kind: "error",
      code: "sidecar.database.unusable",
      summary: squashed.fault.summary,
      // The repair list IS the actionable half — the reason `Fault` carries one at all.
      detail: [...squashed.fault.repair, "", squashed.fault.detail].join("\n"),
      /**
       * 🔴 Carried through so the Recovery surface can OFFER the repair instead of describing it.
       *
       * ⚠️ Optional, and every consumer must treat it as such: `path` is `:memory:` for a hermetic
       * run, and absent entirely if the fault was raised before the file was resolved. A
       * move-aside button that cannot name its file is worse than no button at all.
       */
      databasePath: typeof squashed.fault.path === "string" ? squashed.fault.path : undefined,
    }
  if (Cause.isTimeoutError(squashed))
    return {
      kind: "timeout",
      code: `sidecar.${stage}.timeout`,
      summary:
        stage === "health"
          ? "The local server did not pass its health check in time — NovaClaw will keep trying to reconnect."
          : "The local server did not finish starting in time.",
      detail,
    }

  const message = squashed instanceof Error ? squashed.message : String(squashed)
  return {
    kind: "error",
    code: `sidecar.${stage}.failed`,
    summary:
      stage === "health"
        ? `The local server stopped before it finished starting: ${message}`
        : `The local server could not be started: ${message}`,
    detail,
  }
}
