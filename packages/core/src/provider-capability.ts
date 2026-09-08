export * as ProviderCapability from "./provider-capability"

import { recoverToolCallsFromText } from "@novaclaw/llm"

/**
 * WHAT CAN THIS ENDPOINT ACTUALLY DO — the reading half of capability negotiation.
 *
 * `provider-reach.ts` answers *does it answer*. The existing endpoint Test
 * (`POST /provider/:id/probe`) goes one step further and asks *does a one-token completion come
 * back*. Neither answers the question the runner needs before its first real turn: **can this model
 * take a tool call, and in which shape** — because the answer decides whether the harness offers
 * native tools, describes them in the prompt, or runs a chat with no tools at all.
 *
 * Today that is a guess. A model that silently ignores `tools` produces a turn that reads as the
 * agent refusing to act, and a user has no way to tell that from a broken instance.
 *
 * ## The distinction this module exists to keep
 *
 * 🔴 **"It cannot" and "we could not find out" are different answers, and collapsing them is the
 * defect.** A 401, a dropped connection, a proxy's HTML error page — none of them are evidence about
 * the MODEL. Recorded as `unsupported` they would permanently demote a capable endpoint to prompted
 * tools on the strength of a network blip, and nothing downstream could tell the difference. So
 * every outcome is one of three, never two: `supported`, `unsupported`, or `unknown` **with the
 * fault that stopped us**.
 *
 * The one place a failure IS evidence: a 4xx whose body names the offending parameter. An endpoint
 * that says *"unknown field: tools"* has told us something about itself, and treating that as merely
 * unknown would re-probe forever against a server that already answered.
 *
 * ## No side effects, by construction
 *
 * The probe offers a CAPTURE-ONLY tool. It exists to be called and does nothing when it is; nothing
 * executes, no permission is asked, and a model that calls it three times has changed nothing. That
 * is not a convention to be remembered at the call site — there is no executor here to forget it.
 *
 * ## What the schema deliberately exercises
 *
 * MULTIPLE arguments and a NESTED object, because those are what break in practice. A provider that
 * emits `{"label":"x"}` for a three-argument schema, or flattens the nested object, is one whose
 * native tool calls the runner cannot rely on — and a single-string-argument probe would call it
 * healthy.
 */

/** The rungs of the ladder, each measured rather than assumed. */
export type Capability =
  /** A plain completion returns content. Everything else is meaningless without it. */
  | "chat"
  /** A JSON response format returns parseable JSON. */
  | "json"
  /** The endpoint's own tool-call channel returns a well-formed call. */
  | "native-tools"
  /** The model emits a tool call as TEXT when the tools are described in the prompt. */
  | "text-tools"

export const CAPABILITIES: readonly Capability[] = ["chat", "json", "native-tools", "text-tools"]

/** Why we could not find out. Never a statement about the model. */
export type Fault =
  /** The request never completed — no response, a socket error, a timeout. */
  | "transport"
  /** Credentials were rejected. */
  | "auth"
  /** A response arrived and was not a success, and did not say why in a way we can read. */
  | "http"
  /** A success arrived whose body is not what this protocol returns. A proxy's error page lands here. */
  | "malformed"
  /**
   * The completion ran out of budget before it said anything.
   *
   * 🔴 A fault, NOT a capability, and this arm exists because the probe got it wrong on itself.
   * Measured against Holo3.1: the JSON rung asked with `max_tokens: 64`, the model spent all of it
   * reasoning, and the reply came back with `content: null` and `finish_reason: "length"` — which the
   * reader scored as *"accepted a JSON response format and answered prose"*. That is a permanent
   * `unsupported` recorded for OUR budget, on a rung the endpoint handles fine.
   */
  | "budget"
  /** Not asked. A rung below it failed, so asking would have measured that failure again. */
  | "not-attempted"

export type Outcome =
  | { readonly kind: "supported"; readonly detail?: string }
  | { readonly kind: "unsupported"; readonly detail: string }
  | { readonly kind: "unknown"; readonly fault: Fault; readonly detail: string }

/** What the harness should do with this endpoint. */
export type Choice =
  | "native"
  /** Tools described in the prompt, calls recovered from text — gated by the offered whitelist. */
  | "prompted"
  /** No tools at all. A conversation, honestly labelled. */
  | "chat-only"
  /** We could not find out. NOT a synonym for chat-only: it must not be persisted as a decision. */
  | "unknown"

export interface Report {
  readonly outcomes: Readonly<Record<Capability, Outcome>>
  readonly choice: Choice
  /** What the choice rests on, in one sentence, for a surface that has to explain itself. */
  readonly rationale: string
}

/**
 * The capture-only tool.
 *
 * ⚠️ The name is namespaced on purpose. A model that has seen a thousand `get_weather` examples will
 * hallucinate one; a call naming a tool we did not offer is the signal {@link readToolCall} refuses
 * on, and a generic name would make a real hallucination indistinguishable from a correct call.
 */
export const CAPTURE_TOOL = {
  name: "nova_probe_capture",
  description:
    "Records the arguments you pass and does nothing else. Call it exactly once with all three arguments filled in.",
  parameters: {
    type: "object",
    properties: {
      label: { type: "string", description: "Any short word." },
      count: { type: "integer", description: "Any whole number between 1 and 9." },
      nested: {
        type: "object",
        description: "An object with both fields filled in.",
        properties: { left: { type: "string" }, right: { type: "string" } },
        required: ["left", "right"],
      },
    },
    required: ["label", "count", "nested"],
  },
} as const

/**
 * The prompt that asks for a TEXT tool call, for endpoints with no native channel.
 *
 * 🔴 **It asks for BARE JSON, and that is a measured decision rather than a style choice.**
 *
 * Measured against Holo3.1 on the Spark, 2026-08-13, three requests differing only in the wrapper:
 *
 *   · `Reply with only this line: {"name":…}`                    → the JSON comes back verbatim
 *   · the same line wrapped in `<tool_call>…</tool_call>`        → **content is `null`**, no tool_calls
 *   · `Reply with exactly: OK`                                   → "OK"
 *
 * The server's own tool parser CONSUMES the `<tool_call>` block and emits nothing in its place. So
 * the hermes shape — the one the decoder was built to recover, because models emit it unprompted —
 * is exactly the shape you must not ASK for on a server that has a tool parser armed: the client
 * sees an empty turn and reads it as the model having nothing to say.
 *
 * Bare JSON is recovered by the same `recoverToolCallsFromText` (its `recoverBareJson` arm) and
 * passes through untouched. The general lesson, worth more than this prompt: on the prompted rung
 * the SERVER is a participant, not a pipe — a format it recognises is one it may swallow.
 *
 * ⚠️ The recovery still accepts every shape it always did. This is about what we ASK for; a model
 * that answers in hermes anyway is still recovered when the server passes it through.
 */
export const TEXT_TOOL_PROMPT =
  `You can call one tool. Reply with nothing but a single line of JSON, no code fence and no tags: ` +
  `{"name":"${CAPTURE_TOOL.name}","arguments":{"label":"…","count":1,"nested":{"left":"…","right":"…"}}}. ` +
  `label is a short word, count is a whole number 1-9, and left and right are short words. Fill in all three.`

/** A tool call, however it arrived. */
export interface ToolCall {
  readonly name: string
  /** Raw argument text. Kept unparsed so a TRUNCATED call is distinguishable from a well-formed one. */
  readonly rawArguments: string
}

const REQUIRED_KEYS = ["label", "count", "nested"] as const

/**
 * Judge one tool call against what was offered.
 *
 * 🔴 **A call naming a tool that was not offered is `unsupported`, not a parse failure.** It is the
 * clearest possible evidence that this endpoint's tool channel invents names, and an offered-tools
 * whitelist is the only thing standing between that and a runner executing a tool nobody granted.
 * Measuring it here is what lets the negotiator refuse the native rung on evidence rather than on a
 * later incident.
 */
export const readToolCall = (call: ToolCall | undefined, offered: readonly string[]): Outcome => {
  if (call === undefined)
    return { kind: "unsupported", detail: "The model answered without calling the tool it was offered." }
  if (!offered.includes(call.name))
    return {
      kind: "unsupported",
      detail: `The model called "${call.name}", which was never offered. Its tool calls cannot be trusted by name.`,
    }
  let parsed: unknown
  try {
    parsed = JSON.parse(call.rawArguments)
  } catch {
    // Truncation lands here, and it is the common shape: a budget too small for the arguments cuts
    // the JSON mid-object. Reported as unsupported for THIS probe rather than as a fault, because
    // the probe asked for three tiny values — a channel that cannot carry them is not usable.
    return { kind: "unsupported", detail: "The tool call's arguments were not valid JSON (often a truncated call)." }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return { kind: "unsupported", detail: "The tool call's arguments were not an object." }
  const args = parsed as Record<string, unknown>
  const missing = REQUIRED_KEYS.filter((key) => args[key] === undefined)
  if (missing.length > 0)
    return {
      kind: "unsupported",
      detail: `The tool call dropped ${missing.join(", ")} — this endpoint does not carry multi-argument calls intact.`,
    }
  const nested = args["nested"]
  // The nested check is separate and deliberate: flattening (`nested.left` as a top-level key, or a
  // JSON string where an object belongs) is the failure a required-keys check alone reads as healthy.
  if (typeof nested !== "object" || nested === null || Array.isArray(nested))
    return { kind: "unsupported", detail: "The nested argument arrived flattened rather than as an object." }
  const inner = nested as Record<string, unknown>
  if (inner["left"] === undefined || inner["right"] === undefined)
    return { kind: "unsupported", detail: "The nested argument lost its fields." }
  return { kind: "supported" }
}

/**
 * Recover a TEXT tool call using the RUNNER's own recovery.
 *
 * ⚠️ Not a reimplementation, and that is the whole point. `recoverToolCallsFromText` is
 * whitelist-gated on the offered names — ordinary prose, C++ `<vector>`, markdown and code are
 * never misread as a call — and it already handles the four shapes small models actually emit. Any
 * second reader here would drift from it, and the drift would show up as a verdict about a channel
 * that does not match the one the turn would use.
 *
 * A recovered call is BY CONSTRUCTION whitelist-clean, so what {@link readToolCall} still judges is
 * the payload: multiple arguments carried intact, and the nested object not flattened.
 */
export const recoverTextToolCall = (content: string, offered: readonly string[]): ToolCall | undefined => {
  const [first] = recoverToolCallsFromText(content, offered)
  return first === undefined ? undefined : { name: first.name, rawArguments: first.arguments }
}

/**
 * Does a 4xx body tell us the endpoint rejected the FEATURE rather than us?
 *
 * ⚠️ Narrow on purpose. A body merely containing the word "tools" could be anything, so this asks for
 * a rejection phrase next to the parameter — the shape servers actually emit for an unknown or
 * unsupported field. Anything less specific stays `unknown`, because a wrong `unsupported` is
 * permanent and a wrong `unknown` only costs another probe.
 */
export const rejectsParameter = (body: string, parameter: string): boolean => {
  const text = body.toLowerCase()
  if (!text.includes(parameter.toLowerCase())) return false
  return /unsupported|not support|unknown (field|parameter|argument)|unrecognized|unexpected|invalid (field|parameter|argument)|do(es)? not accept/.test(
    text,
  )
}

/** The raw shape a rung's request came back as. Classified by {@link outcomeOf}. */
export type Response =
  | { readonly kind: "transport"; readonly detail: string }
  | { readonly kind: "http"; readonly status: number; readonly body: string }
  | { readonly kind: "body"; readonly payload: unknown }

/**
 * Did this completion stop because it ran out of room, with nothing to show for it?
 *
 * ⚠️ Both halves are required. A `length` finish with content is a normal truncation of a real
 * answer — the native rung's arguments arriving whole is exactly that case — and only an EMPTY one
 * means we learned nothing. A reasoning model burns its budget before the first content token, so
 * this is the shape a too-small budget takes rather than an exotic edge.
 */
export const spentWithoutAnswering = (input: { readonly content: string; readonly finishReason?: string }): boolean =>
  input.finishReason === "length" && input.content.trim().length === 0

/**
 * Turn one rung's response into an outcome, given a reader for a successful body.
 *
 * The fault mapping is the whole point and is written once here rather than at each rung: three
 * rungs classifying HTTP statuses independently is three chances to call an auth failure a
 * capability.
 */
export const outcomeOf = (
  response: Response,
  input: { readonly parameter?: string; readonly read: (payload: unknown) => Outcome },
): Outcome => {
  if (response.kind === "transport")
    return { kind: "unknown", fault: "transport", detail: `The request did not complete: ${response.detail}` }
  if (response.kind === "http") {
    if (response.status === 401 || response.status === 403)
      return {
        kind: "unknown",
        fault: "auth",
        detail: `The endpoint rejected the credentials (HTTP ${response.status}).`,
      }
    if (input.parameter !== undefined && rejectsParameter(response.body, input.parameter))
      return {
        kind: "unsupported",
        detail: `The endpoint rejected the "${input.parameter}" parameter (HTTP ${response.status}).`,
      }
    return {
      kind: "unknown",
      fault: "http",
      detail: `HTTP ${response.status}${response.body ? `: ${response.body.slice(0, 200)}` : ""}`,
    }
  }
  return input.read(response.payload)
}

/** `not-attempted` for every rung a failed precondition made pointless to ask. */
export const notAttempted = (because: string): Outcome => ({
  kind: "unknown",
  fault: "not-attempted",
  detail: `Not asked: ${because}`,
})

/**
 * The ladder, decided from evidence.
 *
 * ⚠️ `unknown` is NOT chat-only. An endpoint we could not reach must be re-probed, not demoted — and
 * a caller that persists a decision has to be able to tell "measured: no tools" from "we never got
 * an answer". That is why the two are separate members rather than a boolean with a comment.
 */
export const choose = (outcomes: Readonly<Record<Capability, Outcome>>): { choice: Choice; rationale: string } => {
  if (outcomes["native-tools"].kind === "supported")
    return { choice: "native", rationale: "The endpoint returned a well-formed native tool call." }
  if (outcomes["text-tools"].kind === "supported")
    return {
      choice: "prompted",
      rationale:
        outcomes["native-tools"].kind === "unsupported"
          ? `Native tool calls are not usable here (${outcomes["native-tools"].detail}), but the model emits a tool call as text.`
          : "Native tool calls could not be measured, and the model emits a tool call as text.",
    }
  if (outcomes.chat.kind !== "supported")
    return {
      choice: "unknown",
      rationale: `Nothing could be measured: ${outcomes.chat.detail ?? "the endpoint did not answer"}.`,
    }
  // Chat works and BOTH tool rungs failed. Only call that chat-only when they failed as
  // capabilities: if either is `unknown`, we are guessing, and a guess persisted as a decision is
  // how an endpoint gets stuck without tools for reasons nobody can reconstruct.
  const measured = outcomes["native-tools"].kind === "unsupported" && outcomes["text-tools"].kind === "unsupported"
  return measured
    ? { choice: "chat-only", rationale: "The endpoint answers, and neither tool channel produced a usable call." }
    : { choice: "unknown", rationale: "The endpoint answers, but its tool channels could not be measured." }
}

/** Assemble the report. Separated from `choose` so a caller can record outcomes it did not act on. */
export const report = (outcomes: Readonly<Record<Capability, Outcome>>): Report => ({
  outcomes,
  ...choose(outcomes),
})

/**
 * The SHAPE half of a negotiation: where to post, and how to read what comes back.
 *
 * The rungs' verdicts — what counts as supported, what is a budget fault, what a call naming an
 * unoffered tool means — are written once against this interface. Only the envelope differs between
 * wires, and keeping the two apart is what stops a second wire from quietly acquiring a second,
 * subtly different definition of "supported".
 */
export interface Wire {
  /** Appended to the provider's base URL. */
  readonly path: string
  /** The request fields every rung shares, given the model and the token budget. */
  readonly base: (modelID: string, maxTokens: number) => Record<string, unknown>
  /** A user turn in this wire's message shape. */
  readonly ask: (text: string) => Record<string, unknown>
  /**
   * Did the endpoint answer in THIS wire's envelope at all?
   *
   * ⚠️ Not "was it a good answer". A 2xx in the wrong envelope is a proxy or a gateway answering for
   * the endpoint, which says nothing about the model and must not be scored as a capability.
   */
  readonly answered: (payload: unknown) => boolean
  readonly text: (payload: unknown) => string
  readonly toolCall: (payload: unknown) => ToolCall | undefined
  /** The model stopped because it hit the ceiling, having said nothing. */
  readonly exhausted: (payload: unknown) => boolean
  /** How this wire is asked to offer the capture tool, and the parameter a refusal would name. */
  readonly toolsParameter: string
  readonly offerCaptureTool: () => Record<string, unknown>
  /**
   * How this wire is asked for machine-readable output — ABSENT where the wire has no such
   * parameter.
   *
   * ⚠️ Absent is not `unsupported`. "This endpoint rejects JSON mode" is a claim about the endpoint;
   * "this wire has no JSON-mode parameter" is a fact about the protocol, and recording the first
   * when the second is true would blame a server for its wire's vocabulary.
   */
  readonly jsonMode?: { readonly parameter: string; readonly request: Record<string, unknown> }
}

const openAIMessage = (payload: unknown): Record<string, unknown> | undefined => {
  const choices = (payload as { choices?: unknown } | null)?.choices
  if (!Array.isArray(choices) || choices.length === 0) return undefined
  const message = (choices[0] as { message?: unknown } | undefined)?.message
  return typeof message === "object" && message !== null ? (message as Record<string, unknown>) : undefined
}

const openAIFinishReason = (payload: unknown): string | undefined => {
  const choices = (payload as { choices?: unknown } | null)?.choices
  if (!Array.isArray(choices) || choices.length === 0) return undefined
  const reason = (choices[0] as { finish_reason?: unknown } | undefined)?.finish_reason
  return typeof reason === "string" ? reason : undefined
}

const anthropicBlocks = (payload: unknown): ReadonlyArray<Record<string, unknown>> => {
  const content = (payload as { content?: unknown } | null)?.content
  return Array.isArray(content) ? (content.filter((b) => typeof b === "object" && b !== null) as never) : []
}

/**
 * The two wires a probe can speak.
 *
 * `anthropic-messages` has been driven end to end against a REAL server speaking this envelope:
 * `llama-server` serves `/v1/messages` alongside the OpenAI path, and every designed behaviour fired
 * correctly there — a `supported` native verdict off a real `tool_use` block, a `budget` fault off a
 * real `stop_reason: "max_tokens"`, and the `not-attempted` JSON rung. See
 * `packages/novaclaw/test/live/anthropic-probe-live.ts`.
 *
 * ⚠️ What that still does not establish is how **api.anthropic.com** answers. It is unreachable from
 * here, so no verdict has come from the vendor's own server — a different claim, and the one the
 * ledger still tracks.
 */
export const WIRES: Readonly<Record<"openai-chat" | "anthropic-messages", Wire>> = {
  "openai-chat": {
    path: "chat/completions",
    base: (modelID, maxTokens) => ({ model: modelID, temperature: 0, stream: false, max_tokens: maxTokens }),
    ask: (text) => ({ messages: [{ role: "user", content: text }] }),
    answered: (payload) => openAIMessage(payload) !== undefined,
    text: (payload) => {
      const content = openAIMessage(payload)?.["content"]
      return typeof content === "string" ? content : ""
    },
    toolCall: (payload) => {
      const calls = openAIMessage(payload)?.["tool_calls"]
      if (!Array.isArray(calls) || calls.length === 0) return undefined
      const fn = (calls[0] as { function?: unknown } | undefined)?.function as
        | { name?: unknown; arguments?: unknown }
        | undefined
      if (fn === undefined) return undefined
      return {
        name: typeof fn.name === "string" ? fn.name : "",
        rawArguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
      }
    },
    exhausted: (payload) => openAIFinishReason(payload) === "length",
    toolsParameter: "tools",
    offerCaptureTool: () => ({ tools: [{ type: "function", function: CAPTURE_TOOL }] }),
    jsonMode: { parameter: "response_format", request: { response_format: { type: "json_object" } } },
  },
  "anthropic-messages": {
    path: "messages",
    // ⚠️ `max_tokens` is REQUIRED here, not an optional guard as on the OpenAI wire: omitting it is a
    // 400, so a rung that forgot it would measure our own request and record it as the endpoint's.
    base: (modelID, maxTokens) => ({ model: modelID, stream: false, max_tokens: maxTokens }),
    ask: (text) => ({ messages: [{ role: "user", content: text }] }),
    answered: (payload) => Array.isArray((payload as { content?: unknown } | null)?.content),
    text: (payload) =>
      anthropicBlocks(payload)
        .filter((block) => block["type"] === "text" && typeof block["text"] === "string")
        .map((block) => block["text"] as string)
        .join(""),
    toolCall: (payload) => {
      const block = anthropicBlocks(payload).find((b) => b["type"] === "tool_use")
      if (block === undefined) return undefined
      return {
        name: typeof block["name"] === "string" ? block["name"] : "",
        // The arguments arrive already parsed on this wire; re-encoding keeps ONE argument reader
        // for both wires rather than a second path that could disagree about what is valid.
        rawArguments: JSON.stringify(block["input"] ?? {}),
      }
    },
    exhausted: (payload) => (payload as { stop_reason?: unknown } | null)?.stop_reason === "max_tokens",
    toolsParameter: "tools",
    offerCaptureTool: () => ({
      tools: [
        {
          name: CAPTURE_TOOL.name,
          description: CAPTURE_TOOL.description,
          input_schema: CAPTURE_TOOL.parameters,
        },
      ],
    }),
    // No JSON-mode parameter exists on this wire.
  },
}

/**
 * WHICH serving process answered, read off a finished turn's provider metadata.
 *
 * `system_fingerprint` is the only serving identity on an OpenAI-compatible wire: vLLM fills it with
 * its build plus a per-process suffix, so it is stable across calls to one server and differs
 * between two servers of the same build. That makes it the one signal that a URL now points at a
 * different process — the case a stored capability verdict cannot otherwise notice.
 *
 * ⚠️ Lives here rather than inline in the runner because the runner's stream loop is not driven by
 * any test: a namespace key or a field name that quietly changed would be caught by nothing. Kept
 * pure and exported so the reading is checked even though its two callers are glue.
 *
 * ⚠️ The `openai` namespace regardless of vendor — it is the decoder that names the key, and every
 * protocol in the OpenAI-compatible family decodes through the same one.
 */
export const servingIdentityOf = (metadata: Readonly<Record<string, unknown>> | undefined): string | undefined => {
  const reported = (metadata?.["openai"] as { system_fingerprint?: unknown } | undefined)?.system_fingerprint
  // An empty string is not an identity. Some servers send `""` when they have nothing to report, and
  // recording it would make every such turn look like a MOVE away from the real one.
  return typeof reported === "string" && reported.length > 0 ? reported : undefined
}

/**
 * What a stored verdict is ABOUT. A change to any of it invalidates the evidence.
 *
 * ⚠️ The template is in here because it is the thing that changes under you. A server reloaded with
 * a different chat template is the same URL, the same model name and a different tool channel — the
 * exact case where stale evidence would send the runner down a rung that no longer works.
 */
export const fingerprint = (input: {
  readonly endpoint: string
  readonly model: string
  readonly protocol: string
  readonly template?: string
}): string =>
  // ⚠️ JSON, not a delimiter. A separator character has to be one that cannot appear in a URL, a
  // model id, a protocol name or a template — and every visible candidate can. (An earlier draft
  // reached for a NUL for exactly that reason, which is invisible in every tool that reads source
  // and is banned outright by `invisible-characters.test.ts`.) Encoding the tuple sidesteps the
  // question: two different tuples cannot produce one string.
  JSON.stringify([input.endpoint.replace(/\/+$/, ""), input.model, input.protocol, input.template ?? null])
