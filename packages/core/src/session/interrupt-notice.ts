export * as SessionInterruptNotice from "./interrupt-notice"

import { DateTime, Effect, type Layer } from "effect"
import { EventV2 } from "../event"
import { Location } from "../location"
import type { LocationError, LocationServices } from "../location-services"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import type { SessionStore } from "./store"
import type { SessionExecutionAttempt } from "./execution-attempt"

/** Clear both projections of an in-flight provider attempt before settling a deliberate Stop. The
 * attempt row and session row are separate durable projections; clearing only one makes the next
 * manual prompt misread the user's cancellation as a process loss and auto-resume it. */
export const settleProvider = (input: {
  readonly events: EventV2.Interface
  readonly attempts: SessionExecutionAttempt.Interface
  readonly lease: SessionExecutionAttempt.Lease
  readonly sessionID: SessionSchema.ID
  readonly located: Layer.Layer<LocationServices, LocationError>
}) =>
  Effect.gen(function* () {
    const recovery = yield* input.attempts.providerRecovery(input.lease)
    if (!recovery) return
    const timestamp = yield* DateTime.now
    yield* Location.Service.use((location) =>
      input.events.publish(
        SessionEvent.ProviderAttempt.Settled,
        {
          sessionID: input.sessionID,
          timestamp,
          attemptID: recovery.attemptID,
          outcome: "interrupted",
        },
        {
          location: new Location.Info({
            directory: location.directory,
            ...(location.workspaceID ? { workspaceID: location.workspaceID } : {}),
            root: location.root,
            origin: location.origin,
          }),
        },
      ),
    )
    yield* input.attempts.providerSettled(input.lease, recovery.attemptID)
  }).pipe(Effect.provide(input.located), Effect.ignore)

/**
 * Say, in the transcript, that a turn was stopped before it produced anything.
 *
 * The execution ledger already records the interruption (`state: "interrupted"`,
 * `failure_class: "interrupt"`) and that was never the gap. **A ledger row is not a message**, and
 * the transcript renders messages — so a turn interrupted during prefill left the prompt with
 * nothing after it: no answer, no marker, no sign that anything had been attempted or that the user
 * themselves had stopped it (measured in the app, 2026-08-11).
 *
 * ## Two constraints this shape exists to satisfy
 *
 * ⚠️ **It must be called from a FINALIZER, and that is measured rather than assumed.**
 * `RunCoordinator.interrupt` calls `Fiber.interrupt` on the runner, and `Effect.exit` does not let a
 * fiber survive its own interruption — an external interrupt tears it down THROUGH an enclosing
 * `uninterruptibleMask`, with `restore` as the delivery point. Two attempts inside the runner's
 * normal control flow were proven dead by compiled-in probes: none of three fired when the interrupt
 * was delivered at prefill. Finalizers run; nothing else does.
 * (`notes/reports/chat-uix-audit-2026-08-11.md`.)
 *
 * ⚠️ **A synthetic notice, not an assistant row marked interrupted.** The turn produced no assistant
 * output, and manufacturing one to hang a marker on would describe something that did not happen
 * (ruling 2). It also matches what the product already does for the sibling case — process-loss
 * recovery publishes a Synthetic saying the same kind of thing — and needs no agent or model,
 * neither of which an executor layer resolves.
 *
 * ## Why it lives in core rather than in one executor
 *
 * There are two executors — the in-process `execution/local.ts` and the worker the server actually
 * binds — and the worker settles an interrupt at two separate sites. Writing the notice four times
 * is how three of them drift. The rule that decides whether to speak (did this turn leave any
 * assistant output?) is the part that must not diverge.
 */
export const publish = (input: {
  readonly events: EventV2.Interface
  readonly store: SessionStore.Interface
  readonly sessionID: SessionSchema.ID
  /** The session's resolved Location layer — an unstamped event loses its directory routing. */
  readonly located: Layer.Layer<LocationServices, LocationError>
}) =>
  Effect.gen(function* () {
    const context = yield* input.store.context(input.sessionID)
    // Only when the turn left NO assistant row. A turn interrupted mid-answer already settles its
    // own message with an `Interrupted` error and renders the divider; a notice under it is noise.
    // This also makes the call idempotent: once the notice lands, the last message is no longer a
    // user message, so a second interrupt says nothing.
    if (context.at(-1)?.type !== "user") return
    const timestamp = yield* DateTime.now
    yield* Location.Service.use((location) =>
      input.events.publish(
        SessionEvent.Synthetic,
        {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp,
          // ⚠️ Deliberately says only what the USER did. An earlier draft read "…before the model
          // replied", which is true from our side (no assistant row means no delta ever arrived)
          // but sits badly beside the prompt dock's own recovery banner — "NovaClaw could not
          // confirm that the reply finished" — which appears on this same path. Two messages about
          // one event should not appear to disagree about what is known; the banner owns that
          // nuance, and this owns the plain fact that explains the missing answer.
          text: "You stopped this turn.",
        },
        {
          location: new Location.Info({
            directory: location.directory,
            ...(location.workspaceID ? { workspaceID: location.workspaceID } : {}),
            root: location.root,
            origin: location.origin,
          }),
        },
      ),
    )
    // Best-effort throughout: a transcript note must never fail a drain that is already being torn
    // down, and the interruption is recorded in the ledger either way.
  }).pipe(Effect.provide(input.located), Effect.ignore)
