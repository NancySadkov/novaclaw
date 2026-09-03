import { QuestionV2 } from "@novaclaw/core/question"
import { QuestionRequest } from "@novaclaw/schema/question-request"
import { Effect, Schema } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { QuestionNotFoundError } from "../errors"

/**
 * The legacy `/question` surface, backed by core's `QuestionV2` — the service the session worker's
 * `question-ask` RPC blocks on.
 *
 * ⚠️ Until 2026-09-03 these routes answered a SECOND service (`novaclaw/src/question`, a superseded
 * fork with its own pending map) whose `ask` nothing called, so `GET /question` was always `[]`,
 * every reply 404'd, and a restored question tool would have blocked the worker forever with no
 * reachable answer path. The fork is deleted; the wire shapes stay the legacy identifiers the SDK
 * types are named from (`QuestionRequest`, `QuestionReply`), which core's rows satisfy field for
 * field — only the id brand differs, and it is re-branded here.
 */
export const questionHandlers = HttpApiBuilder.group(InstanceHttpApi, "question", (handlers) =>
  Effect.gen(function* () {
    // Resolved INSIDE each handler, never at group build: the service is location-scoped and
    // arrives per request through `LocationMiddleware` on the group.
    const notFound = (requestID: string) =>
      new QuestionNotFoundError({ requestID, message: `Question request not found: ${requestID}` })

    // Core's rows in the legacy wire shape: same fields, and the ids share the `que_` prefix, so the
    // decode is a re-brand rather than a translation.
    const legacy = Schema.decodeUnknownSync(QuestionRequest.Request)
    const list = Effect.fn("QuestionHttpApi.list")(function* () {
      const svc = yield* QuestionV2.Service
      const requests = yield* svc.list()
      return requests.map((request) => legacy(request))
    })

    const reply = Effect.fn("QuestionHttpApi.reply")(function* (ctx: {
      params: { requestID: typeof QuestionRequest.ID.Type }
      payload: typeof QuestionRequest.Reply.Type
    }) {
      const svc = yield* QuestionV2.Service
      yield* svc
        .reply({ requestID: QuestionV2.ID.make(String(ctx.params.requestID)), answers: ctx.payload.answers })
        .pipe(Effect.catchTag("QuestionV2.NotFoundError", (error) => Effect.fail(notFound(String(error.requestID)))))
      return true
    })

    const reject = Effect.fn("QuestionHttpApi.reject")(function* (ctx: {
      params: { requestID: typeof QuestionRequest.ID.Type }
    }) {
      const svc = yield* QuestionV2.Service
      yield* svc
        .reject(QuestionV2.ID.make(String(ctx.params.requestID)))
        .pipe(Effect.catchTag("QuestionV2.NotFoundError", (error) => Effect.fail(notFound(String(error.requestID)))))
      return true
    })

    return handlers.handle("list", list).handle("reply", reply).handle("reject", reject)
  }),
)
