export * as AgentStatusDerive from "./derive"

import { Effect, Stream } from "effect"
import { LLM, LLMClient, LLMEvent, Message, SystemPart } from "@novaclaw/llm"
import { LocationServiceMap } from "../location-service-map"
import { ShortAnswer } from "../session/runner/short-answer"
import { SessionRunnerModel } from "../session/runner/model"
import { SessionScheduler } from "../session/scheduler"
import { SessionStore } from "../session/store"
import { SYSTEM, clean } from "./label"
import { recentText } from "./recent"

/**
 * The model half of lifecycle sampling: a colleague's recent work in, one status line out.
 *
 * 🔴 **Each colleague is summarised INSIDE ITS OWN LOCATION, and that is the whole reason this
 * module exists rather than a closure in the observer.** `SessionRunnerModel` is a LOCATION node, not a
 * global one — which model answers depends on the project a chat lives in. A global sweep holding
 * one model would summarise every colleague with whatever the instance's default happened to be,
 * quietly ignoring a project that pins its own; and on an instance where the default is unreachable
 * it would fail for colleagues whose own model is fine.
 *
 * ⚠️ The cost is one location entry per sampled session. Superseded lifecycle revisions are
 * coalesced by the observer before their result can be published.
 */

/**
 * 🔴 **A reasoning model spends the whole budget THINKING and returns an empty answer.**
 *
 * Measured 2026-08-28 against `qwen3.8-27b`: with `max_tokens: 256` and no guard, the completion came
 * back `content: ""` with 256 tokens of `reasoning_content` — so `clean()` had nothing to clean and
 * every colleague was reported `unusable`. The unit tests could not see this; they feed `clean()` a
 * string, and the string is exactly what never arrived.
 *
 * `ReasoningBudget` is the existing answer and the titler already uses it: it counts reasoning
 * tokens live, nudges at 70% and 100%, and its mechanical hard stop re-issues the turn with thinking
 * structurally DISABLED. Without it, this call is a coin toss on how talkative the model feels.
 */
export const LABEL_MAX_TOKENS = 512
/** Same ceiling the titler uses for the same reason: a one-line answer needs no deliberation. */
export const LABEL_REASONING_BUDGET = 128

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
  const scheduler = yield* SessionScheduler.Service

  /** The common short-answer path for lifecycle presentation labels. */
  const short = (
    sessionID: string,
    input: { system: string; text: string; task: string; reasoningBudget?: number },
  ) =>
    Effect.gen(function* () {
      const session = yield* store.get(sessionID as never)
      if (!session) return undefined
      const located = locations.get(session.location)
      return yield* Effect.gen(function* () {
        const models = yield* SessionRunnerModel.Service
        const { model, device } = yield* models.resolveWithDevice(session)
        return yield* ShortAnswer.generate({
          model,
          llm,
          system: input.system,
          text: input.text,
          reasoningBudget: input.reasoningBudget ?? LABEL_REASONING_BUDGET,
          maxTokens: LABEL_MAX_TOKENS,
          scheduler,
          maintenance: {
            ownerID: sessionID,
            task: input.task,
            deviceKey: device.key,
            ...(device.concurrency === undefined ? {} : { concurrency: device.concurrency }),
            ...(device.locality === undefined ? {} : { locality: device.locality }),
          },
        })
      }).pipe(Effect.provide(located))
    }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))

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
      // ⚠️ The SAME call the chat titler makes — `ShortAnswer` exists because the old sweep wrote its
      // own and got it wrong. A reasoning model with no guard returns an empty completion, which
      // the titler had already solved.
      const raw = yield* short(sessionID, { system: SYSTEM, text, task: "agent-status" })
      // ⚠️ `clean` decides whether anything usable came back; the sampler treats `undefined` as
      // "leave the previous line alone". An empty completion is a broken call, not a colleague
      // with nothing to say.
      return raw === undefined ? undefined : clean(raw)
    })

  return { recent, label, short }
})
