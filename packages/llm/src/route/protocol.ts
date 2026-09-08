import { Effect, Schema } from "effect"
import * as ProviderShared from "../protocols/shared"
import type { LLMError, LLMEvent, LLMRequest, ProtocolID } from "../schema"

/**
 * The semantic API contract of one model server family.
 *
 * A `Protocol` owns the parts of a route that are intrinsic to "what does
 * this API look like": how a common `LLMRequest` becomes a provider-native
 * body, what schema that body must satisfy before it is JSON-encoded, and
 * how the streaming response decodes back into common `LLMEvent`s.
 *
 * Examples:
 *
 * - `OpenAIChat.protocol` — chat completions style
 * - `OpenAIResponses.protocol` — responses API
 * - `AnthropicMessages.protocol` — messages API with content blocks
 * - `Gemini.protocol` — generateContent
 *
 * A `Protocol` is **not** a deployment. It does not know which URL, which
 * headers, or which auth scheme to use. Those are deployment concerns owned
 * by `Route.make(...)` along with the chosen `Endpoint`, `Auth`,
 * and `Framing`. This separation is what lets DeepSeek, TogetherAI, Cerebras,
 * etc. all reuse `OpenAIChat.protocol` without forking 300 lines per provider.
 *
 * The four type parameters reflect the pipeline:
 *
 * - `Body` — provider-native request body candidate. `Route.make(...)`
 *   validates and JSON-encodes it with `body.schema`.
 * - `Frame` — one unit of the framed response stream. The one shipped framing
 *   is SSE, whose frame is a JSON data string; the parameter is generic
 *   because a binary framing's would not be (see `Framing`).
 * - `Event` — schema-decoded provider event produced from one frame.
 * - `State` — accumulator threaded through `stream.step` to translate event
 *   sequences into `LLMEvent` sequences.
 */
export interface Protocol<Body, Frame, Event, State> {
  /** Stable id for the wire protocol implementation. */
  readonly id: ProtocolID
  /** Request side: schema for the provider-native body and how to build it. */
  readonly body: ProtocolBody<Body>
  /** Response side: streaming state machine. */
  readonly stream: ProtocolStream<Frame, Event, State>
}

export interface ProtocolBody<Body> {
  /** Schema for the validated provider-native body sent as the JSON request. */
  readonly schema: Schema.Codec<Body, unknown>
  /** Build the provider-native body from a common `LLMRequest`. */
  readonly from: (request: LLMRequest) => Effect.Effect<Body, LLMError>
  /**
   * This wire's CONVERSATION array — the one field that carries the turns, and which `make` below
   * refuses to send empty.
   *
   * ⚠️ **REQUIRED on purpose.** A protocol added without answering *"which array must not be empty,
   * and what is it called on my wire?"* does not compile. That is ruling 1's type form, and it is
   * why this is a field rather than a five-way list inside the guard: a list of today's protocols
   * goes stale silently, a required field cannot.
   *
   * `name` is the wire's own spelling (`messages` · `contents` · `input`) and appears verbatim in
   * the refusal, so the message names the field the operator would look for in a captured body —
   * ruling 2, *a fault is never described falsely*.
   */
  readonly conversation: ConversationField<Body>
}

/**
 * The declaration `ProtocolBody.conversation` requires.
 *
 * Deliberately an ACCESSOR and not a string key: `read` is typed against `Body`, so a field
 * rename in a body schema breaks the compile instead of turning the guard into a lookup that
 * silently returns `undefined` — which would read as "not empty" and disarm the check.
 */
export interface ConversationField<Body> {
  /** The field's name on the provider wire, used verbatim in the refusal message. */
  readonly name: string
  /** Read that field off a built body. */
  readonly read: (body: Body) => ReadonlyArray<unknown>
}

export interface ProtocolStream<Frame, Event, State> {
  /** Schema for one decoded streaming event, decoded from a transport frame. */
  readonly event: Schema.Codec<Event, Frame>
  /** Initial parser state. Called once per response with the resolved request. */
  readonly initial: (request: LLMRequest) => State
  /** Translate one event into emitted `LLMEvent`s plus the next state. */
  readonly step: (state: State, event: Event) => Effect.Effect<readonly [State, ReadonlyArray<LLMEvent>], LLMError>
  /** Optional request-completion signal for transports that do not end naturally. */
  readonly terminal?: (event: Event) => boolean
  /**
   * The flush emitted when the framed stream ends — for ANY reason, including one the wire never
   * explained.
   *
   * ⚠️ **REQUIRED on purpose**, for the same reason `body.conversation` is: a protocol added without
   * answering *"what do I owe the consumer when the stream stops before my terminal event?"* must
   * not compile. It was optional, and two of the four wires silently declined — leaving reasoning
   * and text blocks permanently open and dropping pending tool calls on a stream that SUCCEEDED, so
   * no layer above had an error to react to. A wire with genuinely nothing to flush writes
   * `() => []` and has thereby stated it.
   */
  readonly onHalt: (state: State) => ReadonlyArray<LLMEvent>
}

/**
 * Construct a `Protocol` from its body and stream pieces:
 *
 * - `body.schema` infers the provider-native request body shape.
 * - `body.from` ties the common `LLMRequest` to the provider body.
 * - `stream.event` infers the decoded streaming event and the wire frame.
 * - `stream.initial`, `stream.step`, and `stream.onHalt` infer the parser state.
 *
 * Provider implementations should usually call `Protocol.make({ ... })`
 * without explicit type arguments; the schemas and parser functions are the
 * source of truth. The constructor is the public seam for cross-cutting concerns, and it now
 * carries one: it wraps `body.from` with `guardConversation` below, so **every** protocol — and
 * every route that reuses one, e.g. `openai-compatible-chat`, which takes `OpenAIChat.protocol`
 * verbatim — inherits the empty-conversation refusal without a per-protocol call site to forget.
 */
/**
 * Refuse a body whose conversation array lowered to empty.
 *
 * ⚠️ **Why this is shared while the reasoning-only ASSISTANT DROP is per-wire — the two look alike
 * and are not the same question.** `68d5029a2` put that drop in `openai-chat.ts` because *"can this
 * wire render an assistant that only thought?"* has six different answers for one input (Anthropic
 * lowers it to a `thinking` block, Gemini to `{thought:true}`,
 * `openai-responses` already omits it). *"May the conversation array be empty?"* has ONE answer on
 * all four wires — read off each body schema here: `openai-chat.messages`, `openai-responses.input`,
 * `anthropic-messages.messages` and `gemini.contents` are each the sole
 * carrier of the turns, and a request with none of them asks nothing. A uniform answer belongs in
 * one place (ruling 6); a per-wire answer does not. Do not read this as reopening that ruling — the
 * drop stays exactly where it is, and this guard runs strictly after it.
 *
 * ⚠️ **Why refusing is right HERE while it was wrong THERE**, since `openai-chat.ts:382` argues the
 * opposite for its own case: `InvalidRequestReason.retryable` is `false`, so refusing a *routine*
 * shape — an assistant that only thought, which a thinking model mints on a normal finish — would
 * turn one ordinary turn into a permanently unrunnable session. An empty conversation is not
 * routine and there is nothing to run: no content reaches the model whether we send it or not, so
 * the choice is only between naming the fault here and reading a backend's complaint about a body
 * we knew was empty before we sent it. Ruling 2 picks the first.
 *
 * ⚖️ **RULED 2026-08-07 — `ContextPack.pack` does NOT owe a "says something" postcondition, and
 * this guard is what discharges the obligation instead.** The open question was whether
 * `@novaclaw/core`'s `session/runner/context-pack.ts` should guarantee that its kept-set contains
 * something renderable; measured, it can return a lone reasoning-only assistant when a session has
 * no real user message at all, because pass 4's anchor (`working.find(isRealUserMessage)`) has
 * nothing to prepend. The answer is **no**, on four grounds:
 *
 *  1. **"Renderable" is not a property `pack` can evaluate.** It is per-wire — the same lone
 *     reasoning part is dropped by `openai-chat`/`openai-responses`, and lowered to a legal
 *     `thinking` / `{thought:true}` / `reasoningContent` block by the other three. `pack` does not
 *     know the wire, and `68d5029a2` established it must not: `rendersNothing` is openly a
 *     conservative wire-INDEPENDENT approximation. A postcondition it cannot compute is not one.
 *  2. **`pack` is a budget function over the TRANSCRIPT, and the request is not the transcript.**
 *     It never sees `request.system`, yet on this wire and `openai-responses` the system prompt IS
 *     a conversation entry — so a kept-set with nothing renderable still yields a legal one-entry
 *     body. That is why the defect was production-mitigated. A postcondition that is false as a
 *     requirement in the common case is not a postcondition.
 *  3. **All three ways it could keep such a promise are worse than not keeping it.** Fabricating a
 *     placeholder turn puts words in the user's mouth in the durable prompt (ruling 2 forbids
 *     describing a fault falsely, and the anchor pass exists to preserve the user's REAL original
 *     task). Refusing kills a turn that is usually legal. Retaining an over-budget message "until
 *     something renders" needs the predicate ground 1 says it cannot have.
 *  4. **The obligation therefore belongs one layer down, and is now discharged here** — where the
 *     array has a name, emptiness is decidable, and the answer is the same on every wire.
 *
 * ⚠️ **This does NOT reopen the 2026-07-31 lowering ruling, and the two questions differ.** That
 * one asked *where the DROP of an unrenderable assistant belongs* and answered "per-wire, because
 * one input has six answers". This one asks *whether `pack` owes a non-emptiness postcondition on
 * its OUTPUT* — a different question, which happens to share that ruling's premise (`pack` is
 * wire-blind) and is answered by it rather than against it. `context-pack` is still not the fix
 * site, and nothing here asks it to become one.
 *
 * ⏳ **Owed, and outside this package:** a complementary pin in `packages/core` that `pack` never
 * SYNTHESIZES a message — the failure mode this ruling forecloses. `test/empty-conversation.test.ts`
 * holds the half that is testable here (the exact shape `pack` can emit is refused, by name).
 *
 * ⚠️ **Not a `minItems` check on each body schema, and that is deliberate.** The schema is decoded
 * one step later (`route/client.ts` `compile`), so a refinement there would be UNREACHABLE behind
 * this guard — a mutation of it could never be killed, which is the vacuous-guard shape this repo
 * has shipped twice. It would also surface as a parse error naming a refinement, not as a sentence
 * naming the subsystem. One guard, one message, one thing to mutate.
 */
const guardConversation = <Body>(id: ProtocolID, body: ProtocolBody<Body>): ProtocolBody<Body>["from"] =>
  Effect.fn(`${id}.body.from`)(function* (request: LLMRequest) {
    const built = yield* body.from(request)
    if (body.conversation.read(built).length > 0) return built
    // Counts, not adjectives: they separate "the caller sent nothing" from "everything the caller
    // sent was dropped at lowering", which are different bugs with the same wire symptom.
    return yield* ProviderShared.invalidRequest(
      `${id} has nothing to send: \`${body.conversation.name}\` is empty after lowering ` +
        `${request.messages.length} message(s) and ${request.system.length} system part(s)`,
    )
  })

export const make = <Body, Frame, Event, State>(
  input: Protocol<Body, Frame, Event, State>,
): Protocol<Body, Frame, Event, State> => ({
  ...input,
  body: { ...input.body, from: guardConversation(input.id, input.body) },
})

export const jsonEvent = <const S extends Schema.Top>(schema: S) => Schema.fromJsonString(schema)

export * as Protocol from "./protocol"
