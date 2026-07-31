import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { LLM } from ".."
import { Auth, LLMClient } from "../route"
import { Endpoint } from "../route/endpoint"
import { HttpTransport } from "../route/transport"
import type { LLMRequest } from "../schema"
import { OpenAIChat } from "./openai-chat"

// S5 — constrained decoding through the protocol layer.
//
// Two invariant families, each negative-controlled:
//   (1) the REQUEST side — `LLMRequest.responseFormat` reaches the OpenAI Chat body when a caller
//       asks, is absent when nobody does, survives the body schema, and survives the transport's
//       protocol-owned-field denylist;
//   (2) the NON-ASSUMPTION — S5 asks for a constraint and removes nothing. The decode side
//       (tool-call recovery) is provably untouched, so an endpoint that ignores `response_format`
//       behaves exactly as it does today.

// `fromRequest` reads model/messages/tools/generation/responseFormat — a minimal cast drives real
// body construction without a live model (same pattern as `openai-chat.body.test.ts`).
const request = (patch: Record<string, unknown>) =>
  ({ model: { id: "qwen3.6-35b" }, system: [], messages: [], tools: [], ...patch }) as unknown as LLMRequest

const body = (patch: Record<string, unknown>) =>
  Effect.runSync(OpenAIChat.protocol.body.from(request(patch))) as Record<string, unknown>

const ANSWER_SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
} as const

// A real route, so `LLMClient.prepare` runs body construction -> BODY-SCHEMA DECODE (a field
// missing from `bodyFields` is stripped here — exactly how `top_k` used to vanish) -> the
// transport's overlay/denylist check. ⚠️ `prepared.body` is the PRE-overlay protocol body; the
// merged wire body is only visible through `jsonRequestParts` (see `overlaidBody` below).
// The helper supplies `model` and `prompt` itself, so the parameter is the OVERLAY only — typing it
// as the whole `RequestInput` both demanded those two back and made the spread look like it was
// overwriting the model it is meant to keep.
const preparedBody = (input: Partial<Omit<Parameters<typeof LLM.request>[0], "model" | "prompt">>) =>
  Effect.runSync(
    LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
      LLM.request({
        model: OpenAIChat.route
          .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
          .model({ id: "qwen3.6-35b" }),
        prompt: "Say hello.",
        ...input,
      } as Parameters<typeof LLM.request>[0]),
    ),
  ).body as Record<string, unknown>

// The MERGED wire body — what the transport actually encodes after applying `http.body`. This is
// the only place the overlay is observable; `LLMClient.prepare` stops one step earlier.
const overlaidBody = (http: Record<string, unknown>) =>
  Effect.runSync(
    HttpTransport.jsonRequestParts({
      body: { model: "qwen3.6-35b", messages: [], stream: true },
      request: request({ http: { body: http } }),
      endpoint: Endpoint.path("/chat/completions", { baseURL: "https://api.openai.test/v1" }),
      auth: Auth.none,
      encodeBody: (value) => JSON.stringify(value),
    }),
  ).jsonBody as Record<string, unknown>

describe("openai-chat — responseFormat reaches the wire (S5)", () => {
  test("json: response_format is built from LLMRequest.responseFormat", () => {
    const result = body({ responseFormat: { type: "json", schema: ANSWER_SCHEMA } })
    expect(result.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "novaclaw_response", schema: ANSWER_SCHEMA },
    })
  })

  test("NEGATIVE CONTROL: absent when nobody asks — api.openai.com requests unchanged", () => {
    const result = body({ generation: { temperature: 0.7 } })
    expect("response_format" in result).toBe(false)
  })

  test("text: the explicit no-constraint member is expressible", () => {
    expect(body({ responseFormat: { type: "text" } }).response_format).toEqual({ type: "text" })
  })

  test("the caller's schema travels VERBATIM — no projection, no injected keys", () => {
    const nested = { type: "object", properties: { a: { anyOf: [{ type: "string" }, { type: "null" }] } } }
    const result = body({ responseFormat: { type: "json", schema: nested } }) as {
      response_format: { json_schema: { schema: unknown } }
    }
    // `ToolSchemaProjection.openAI` would have stripped the null branch out of `anyOf`.
    expect(result.response_format.json_schema.schema).toEqual(nested)
  })

  test("`strict` is NOT sent — a strict-subset violation would be a hard 400 every turn", () => {
    const result = body({ responseFormat: { type: "json", schema: ANSWER_SCHEMA } }) as {
      response_format: { json_schema: Record<string, unknown> }
    }
    expect("strict" in result.response_format.json_schema).toBe(false)
  })

  // ⚠️ Re-aimed 2026-07-31. This used to read "the `tool` member is REFUSED BY NAME" and drove the
  // one member `ResponseFormat` declared but nothing could produce; that member is now deleted
  // (ruling 10 — `schema/messages.ts` carries the evidence). The assertion survives unchanged in
  // substance because what it actually pins is the GUARD, not that member: an unexpressible
  // `responseFormat` is refused and named, never dropped (ruling 2). The input reaches the branch
  // through the same cast the whole file uses, which is now the only way to reach it — and is
  // exactly the shape a future third member would arrive in if someone added it without a lowering.
  test("an UNEXPRESSIBLE member is refused BY NAME, never silently dropped (ruling 2)", () => {
    const error = Effect.runSync(
      OpenAIChat.protocol.body
        .from(
          request({
            responseFormat: { type: "tool", tool: { name: "write", description: "", inputSchema: {} } },
          }),
        )
        .pipe(Effect.flip),
    )
    expect(error.reason).toMatchObject({ _tag: "InvalidRequest" })
    expect(String((error.reason as { message: string }).message)).toContain("responseFormat `tool`")
  })
})

describe("openai-chat — S5 survives the body schema and the overlay denylist", () => {
  test("response_format survives the FULL prepare path (schema decode + transport)", () => {
    const result = preparedBody({ responseFormat: { type: "json", schema: ANSWER_SCHEMA } })
    expect(result.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "novaclaw_response", schema: ANSWER_SCHEMA },
    })
  })

  test("NEGATIVE CONTROL: unset stays unset all the way through prepare", () => {
    expect("response_format" in preparedBody({})).toBe(false)
  })

  test("an http.body overlay of response_format is still REFUSED — exactly one source of truth", () => {
    const error = Effect.runSync(
      LLMClient.prepare(
        LLM.request({
          model: OpenAIChat.route
            .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
            .model({ id: "qwen3.6-35b" }),
          prompt: "Say hello.",
          http: { body: { response_format: { type: "json_object" } } },
        }),
      ).pipe(Effect.flip),
    )
    expect(error.reason).toMatchObject({
      _tag: "InvalidRequest",
      message: "http.body cannot overlay protocol-owned field(s): response_format",
    })
  })

  test("ruling 10 clause 1: an ENGINE-SPECIFIC grammar rides the open runtime store, no code", () => {
    // llama.cpp GBNF / vLLM guided_* are values that travel an existing wire, so they belong in the
    // model's config `options` (-> runner `sampling-split.ts` -> `http.body`), NOT in `bodyFields`.
    // This pins that the path is OPEN — if someone ever denylists `grammar`, this fails and says why.
    const grammar = 'root ::= "{" ws "\\"answer\\"" ws ":" ws string ws "}"'
    expect(overlaidBody({ grammar, guided_regex: "[0-9]+" }).grammar).toBe(grammar)
    expect(overlaidBody({ grammar, guided_regex: "[0-9]+" }).guided_regex).toBe("[0-9]+")
  })

  test("NEGATIVE CONTROL for the same path: response_format in that overlay is refused", () => {
    const error = Effect.runSync(
      Effect.flip(
        HttpTransport.jsonRequestParts({
          body: { model: "qwen3.6-35b", messages: [], stream: true },
          request: request({ http: { body: { response_format: { type: "json_object" } } } }),
          endpoint: Endpoint.path("/chat/completions", { baseURL: "https://api.openai.test/v1" }),
          auth: Auth.none,
          encodeBody: (value) => JSON.stringify(value),
        }),
      ),
    )
    expect(error.reason).toMatchObject({
      _tag: "InvalidRequest",
      message: "http.body cannot overlay protocol-owned field(s): response_format",
    })
  })
})

describe("openai-chat — S5 asks, and assumes nothing (ruling 2)", () => {
  test("the decode side is bit-identical with and without a constraint", () => {
    // The whole ignore-the-constraint answer in one assertion: S5 changes what is ASKED FOR and
    // nothing else. Tool-call text recovery (`allowedToolNames`) still arms on every turn, so an
    // endpoint that ignores `response_format` behaves exactly as it does today — never worse.
    const tools = [{ name: "write", description: "", inputSchema: {} }]
    const withConstraint = OpenAIChat.protocol.stream.initial(
      request({ tools, responseFormat: { type: "json", schema: ANSWER_SCHEMA } }),
    )
    const without = OpenAIChat.protocol.stream.initial(request({ tools }))
    expect(withConstraint).toEqual(without)
    expect(withConstraint.allowedToolNames).toEqual(["write"])
  })

  test("a constrained request still carries its tools and tool_choice unchanged", () => {
    const result = body({
      tools: [{ name: "write", description: "d", inputSchema: { type: "object" } }],
      toolChoice: { type: "auto" },
      responseFormat: { type: "json", schema: ANSWER_SCHEMA },
    })
    expect(result.tool_choice).toBe("auto")
    expect(Array.isArray(result.tools) && (result.tools as unknown[]).length).toBe(1)
  })
})

// SHRINK-ONLY LEDGER — the protocols that still DROP `responseFormat` silently.
//
// S5 implements the channel on OpenAI Chat only (which is also `openai-compatible-chat`, the route
// every local model uses). The other protocols carry `LLMRequest.responseFormat` and ignore it —
// that predates S5, but S5 makes the asymmetry live, so it is pinned rather than left to be
// rediscovered. When one of these grows the channel, THIS TEST FAILS and the name must come out.
// Never add a name to this list.
const PROTOCOLS_THAT_DROP_RESPONSE_FORMAT = [
  "anthropic-messages.ts",
  "bedrock-converse.ts",
  "gemini.ts",
  "openai-responses.ts",
] as const

describe("S5 — the silent-drop ledger (can only shrink)", () => {
  // A SOURCE assertion, deliberately. Driving four protocols' `body.from` needs a per-protocol
  // fixture apiece, and a fixture too thin to build a body would pass this test for the wrong
  // reason (measured: the anthropic arm threw on `request.model.route.defaults` and would have
  // read as "dropped"). "Does this file mention the field at all" cannot fail that way.
  for (const file of PROTOCOLS_THAT_DROP_RESPONSE_FORMAT) {
    test(`${file} still ignores responseFormat — implement it, then delete this line`, () => {
      expect(readFileSync(join(import.meta.dir, file), "utf8")).not.toContain("responseFormat")
    })
  }

  test("the ledger is complete: every protocol except the one S5 implements", () => {
    expect(PROTOCOLS_THAT_DROP_RESPONSE_FORMAT.length).toBe(4)
    // ...and the one it does implement is not on it.
    expect([...PROTOCOLS_THAT_DROP_RESPONSE_FORMAT]).not.toContain("openai-chat.ts")
  })
})
