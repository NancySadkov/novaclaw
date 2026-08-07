import { Cause, Effect, Exit, Fiber } from "effect"

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
 * So the call site now uses `catchCause`, and the classification lives here where it can be
 * exercised without Electron.
 */
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

export type WindowFirstBoot<W> = {
  /** Open the main window. Called BEFORE the sidecar is asked to do anything at all. */
  readonly openWindow: () => W
  /** Named report when the window itself cannot be created — the one fault nothing else can show. */
  readonly onWindowFailed: (notice: StartupNotice) => void
  /** Everything the local server needs: port, spawn, health gate. */
  readonly sidecar: Effect.Effect<unknown, unknown>
  /** Runs once the sidecar settles — by then the window has existed for a long time. */
  readonly onSidecarSettled: (exit: Exit.Exit<unknown, unknown>) => void
}

/**
 * The boot order, and it is the whole point of this module: **the window is opened first, and the
 * local server starts behind it.**
 *
 * ⚠️ It used to be the other way round. `index.ts` ran `yield* Fiber.await(loadingTask)` and only
 * then `createMainWindow()`, so there was NO WINDOW AT ALL until the sidecar settled — bounded at
 * 30 s (health gate) / 60 s (spawn stall), with no splash and no dialog. A user launching a broken
 * install saw nothing happen, for up to a minute, with no way to tell a slow start from a dead one.
 * That is the dead-end `AGENTS.md` forbids in as many words: *the UI never crashes to a dead-end …
 * a calm "connection lost — reconnecting…" message box, never a stack trace or a white screen.*
 *
 * Inverting it costs nothing, because the renderer already owns both halves of the outcome: it
 * shows a splash while `awaitInitialization` is pending, and its error boundary renders *"An error
 * occurred while starting the local server."* when that promise rejects. The main process was
 * withholding the very window those two states live in.
 *
 * The ordering is expressed as a function taking its steps rather than as two adjacent statements
 * so it can be exercised: a test hands it a sidecar effect that never completes and asserts
 * `openWindow` has already been called. Two adjacent statements in an Electron main module cannot
 * be asserted about at all.
 */
export const bootWindowFirst = <W>(steps: WindowFirstBoot<W>): Effect.Effect<W | undefined> =>
  Effect.gen(function* () {
    const window = yield* Effect.try({ try: steps.openWindow, catch: (error) => error }).pipe(
      // `catchCause`, not `catch`: `createMainWindow` reaches electron-window-state, a BrowserWindow
      // constructor and the renderer protocol, and a throw from any of them must not take the
      // process down silently — see describeSidecarFailure above for the same mismatch's cost.
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          steps.onWindowFailed({
            code: "window.create.failed",
            summary: "NovaClaw could not open its window.",
            detail: Cause.pretty(cause),
          })
          return undefined
        }),
      ),
    )

    const task = yield* steps.sidecar.pipe(Effect.forkChild)
    const exit = yield* Fiber.await(task)
    steps.onSidecarSettled(exit)
    return window
  })
