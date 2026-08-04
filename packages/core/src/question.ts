export * as QuestionV2 from "./question"

import { makeLocationNode } from "./effect/app-node"
import { Context, Deferred, Effect, FiberSet, Layer, Schema } from "effect"
import { Question } from "@novaclaw/schema/question"
import { EventV2 } from "./event"
import { Location } from "./location"
import { SessionSchema } from "./session/schema"

export const ID = Question.ID
export type ID = typeof ID.Type

export const Option = Question.Option
export type Option = typeof Option.Type

export const Info = Question.Info
export type Info = typeof Info.Type

export const Prompt = Question.Prompt
export type Prompt = typeof Prompt.Type

export const Tool = Question.Tool
export type Tool = typeof Tool.Type

export const Request = Question.Request
export type Request = typeof Request.Type

export const Answer = Question.Answer
export type Answer = typeof Answer.Type

export const Reply = Question.Reply
export type Reply = typeof Reply.Type

export const Event = Question.Event

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("QuestionV2.RejectedError", {}) {
  override get message() {
    return "The user dismissed this question"
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("QuestionV2.NotFoundError", {
  requestID: ID,
}) {}

export interface AskInput {
  readonly sessionID: SessionSchema.ID
  readonly questions: ReadonlyArray<Info>
  readonly tool?: Tool
}

export interface ReplyInput {
  readonly requestID: ID
  readonly answers: ReadonlyArray<Answer>
}

export interface Interface {
  readonly ask: (input: AskInput) => Effect.Effect<ReadonlyArray<Answer>, RejectedError>
  readonly reply: (input: ReplyInput) => Effect.Effect<void, NotFoundError>
  readonly reject: (requestID: ID) => Effect.Effect<void, NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/Question") {}

interface Pending {
  readonly request: Request
  readonly deferred: Deferred.Deferred<ReadonlyArray<Answer>, RejectedError>
}

/**
 * Location-owned pending prompts. The Location layer map must materialize this
 * layer once per embedded Location so replies cannot settle another Location's
 * deferred request.
 */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const location = yield* Location.Service
    const pending = new Map<ID, Pending>()

    // Asked/Replied/Rejected must carry this service's location EXPLICITLY: publishes can run
    // on fibers without Location.Service in context (tool settlement, the session-deleted
    // sweep), and the per-instance /event stream drops location-less events (mirrors
    // PermissionV2's eventLocation).
    const eventLocation: Location.Ref = {
      directory: location.directory,
      ...(location.workspaceID === undefined ? {} : { workspaceID: location.workspaceID }),
    }

    yield* Effect.addFinalizer(() =>
      Effect.forEach(pending.values(), (item) => Deferred.fail(item.deferred, new RejectedError()), {
        discard: true,
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pending.clear()
          }),
        ),
      ),
    )

    // A deleted session takes its pending questions with it: nothing can answer them once the
    // session is gone, and an orphaned request would pollute pending lists/attention badges
    // forever. Publish Rejected per question so clients clear their stores (mirrors
    // PermissionV2's session-deleted sweep).
    const rejectSessionPending = (sessionID: string) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          for (const [id, item] of pending) {
            if (String(item.request.sessionID) !== sessionID) continue
            yield* events.publish(
              Event.Rejected,
              {
                sessionID: item.request.sessionID,
                requestID: item.request.id,
              },
              { location: eventLocation },
            )
            yield* Deferred.fail(item.deferred, new RejectedError())
            pending.delete(id)
          }
        }),
      )
    // Same drain-settled sweep as PermissionV2: once the session's drain published idle/exited,
    // the tool awaiting this question is gone — reject so clients clear (and the composer,
    // which the question dock replaces while pending, comes back). Detached via the FiberSet:
    // the idle status is published from the dying drain fiber's finalizer, where an inline
    // listener effect dies with the fiber and is silently swallowed.
    const fork = yield* FiberSet.makeRuntime<never, void, never>()
    const unsubscribe = yield* events.listen((event) => {
      if (event.type === "session.deleted")
        return rejectSessionPending(String((event.data as { sessionID?: string }).sessionID ?? ""))
      if (event.type === "session.status") {
        const data = event.data as { sessionID?: string; status?: { type?: string } }
        if (data.status?.type === "idle" || data.status?.type === "exited")
          return Effect.sync(() => fork(rejectSessionPending(String(data.sessionID ?? "")))).pipe(Effect.asVoid)
      }
      return Effect.void
    })
    yield* Effect.addFinalizer(() => unsubscribe)

    const ask = Effect.fn("QuestionV2.ask")((input: AskInput) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const id = ID.ascending()
          const deferred = yield* Deferred.make<ReadonlyArray<Answer>, RejectedError>()
          const request: Request = { id, ...input }
          pending.set(id, { request, deferred })
          return yield* events.publish(Event.Asked, request, { location: eventLocation }).pipe(
            Effect.andThen(restore(Deferred.await(deferred))),
            Effect.ensuring(
              Effect.sync(() => {
                // Same contract as PermissionV2.assert: a still-pending entry here means the
                // awaiting tool died unanswered (Stop/interrupt) — publish Rejected, detached,
                // so the question dock clears instead of wedging on a stale card.
                if (pending.delete(id))
                  fork(
                    events
                      .publish(
                        Event.Rejected,
                        { sessionID: request.sessionID, requestID: request.id },
                        { location: eventLocation },
                      )
                      .pipe(Effect.asVoid),
                  )
              }),
            ),
          )
        }),
      ),
    )

    const reply = Effect.fn("QuestionV2.reply")((input: ReplyInput) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const existing = pending.get(input.requestID)
          if (!existing) return yield* new NotFoundError({ requestID: input.requestID })
          yield* events.publish(
            Event.Replied,
            {
              sessionID: existing.request.sessionID,
              requestID: existing.request.id,
              answers: input.answers.map((answer) => [...answer]),
            },
            { location: eventLocation },
          )
          yield* Deferred.succeed(existing.deferred, input.answers)
          pending.delete(input.requestID)
        }),
      ),
    )

    const reject = Effect.fn("QuestionV2.reject")((requestID: ID) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const existing = pending.get(requestID)
          if (!existing) return yield* new NotFoundError({ requestID })
          yield* events.publish(
            Event.Rejected,
            {
              sessionID: existing.request.sessionID,
              requestID: existing.request.id,
            },
            { location: eventLocation },
          )
          yield* Deferred.fail(existing.deferred, new RejectedError())
          pending.delete(requestID)
        }),
      ),
    )

    const list = Effect.fn("QuestionV2.list")(function* () {
      return Array.from(pending.values(), (item) => item.request)
    })

    return Service.of({ ask, reply, reject, list })
  }),
)

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [EventV2.node, Location.node] })
