export * as AgentStatusDerive from "./derive"

import { Effect, Stream } from "effect"
import { LLM, LLMClient, LLMEvent, Message, SystemPart } from "@novaclaw/llm"
import { LocationServiceMap } from "../location-service-map"
import { SessionRunnerModel } from "../session/runner/model"
import { SessionStore } from "../session/store"
import { SYSTEM, clean } from "./label"
import { recentText } from "./recent"

/**
 * The model half of the sweep: a colleague's recent work in, one status line out.
 *
 * 🔴 **Each colleague is summarised INSIDE ITS OWN LOCATION, and that is the whole reason this
 * module exists rather than a closure in the sweep.** `SessionRunnerModel` is a LOCATION node, not a
 * global one — which model answers depends on the project a chat lives in. A global sweep holding
 * one model would summarise every colleague with whatever the instance's default happened to be,
 * quietly ignoring a project that pins its own; and on an instance where the default is unreachable
 * it would fail for colleagues whose own model is fine.
 *
 * ⚠️ The cost of that is one location entry per colleague, per pass — which is why the pass runs at
 * most once every few hours and only for colleagues with genuinely new work.
 */

/** Reasoning ceiling for a one-line status. Same shape of guard the titler uses, smaller job. */
export const LABEL_MAX_TOKENS = 256

export const makeLabeller = Effect.fn("AgentStatus.makeLabeller")(function* () {
  const locations = yield* LocationServiceMap.Service
  const store = yield* SessionStore.Service
  /**
   * ⚠️ The LLM client is resolved HERE, globally, while the model RESOLVER is resolved inside each
   * colleague's location. They are two different questions and the type system caught me conflating
   * them: `SessionRunnerModel` is a location node because which model answers depends on the project
   * a chat lives in, but the client that talks to it is one per instance. Resolving both inside the
   * location left `LLMClient.Service` undischarged and the compiler said so.
   */
  const llm = yield* LLMClient.Service

  /** The colleague's recent conversation as text, read in its own location. */
  const recent = (sessionID: string) =>
    Effect.gen(function* () {
      const session = yield* store.get(sessionID as never)
      if (!session) return undefined
      const located = locations.get(session.location)
      const messages = yield* store.context(sessionID as never).pipe(Effect.provide(located))
      return recentText(messages)
    }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))

  /** One status line for the session, resolved and generated in that session's location. */
  const label = (sessionID: string, text: string) =>
    Effect.gen(function* () {
      const session = yield* store.get(sessionID as never)
      if (!session) return undefined
      const located = locations.get(session.location)
      return yield* Effect.gen(function* () {
        const models = yield* SessionRunnerModel.Service
        const model = yield* models.resolve(session)
        const chunks: string[] = []
        yield* llm
          .stream(
            LLM.request({
              model,
              system: [SystemPart.make(SYSTEM)],
              messages: [Message.user(text)],
              tools: [],
              generation: { maxTokens: LABEL_MAX_TOKENS },
            }),
          )
          .pipe(
            Stream.runForEach((event) => {
              if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
              return Effect.void
            }),
          )
        // ⚠️ `clean` decides whether anything usable came back; the sweep treats `undefined` as
        // "leave the previous line alone". An empty completion is a broken call, not a colleague
        // with nothing to say.
        return clean(chunks.join(""))
      }).pipe(Effect.provide(located))
    }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))

  return { recent, label }
})
