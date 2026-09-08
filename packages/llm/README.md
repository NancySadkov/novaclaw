# @novaclaw/llm

Schema-first LLM core for novaclaw. One typed request, response, event, and tool language; provider quirks live in adapters, not in calling code.

```ts
import { Effect } from "effect"
import { LLM, LLMClient } from "@novaclaw/llm"
import { Auth } from "@novaclaw/llm/route"
import { OpenAIResponses } from "@novaclaw/llm/protocols/openai-responses"

const model = OpenAIResponses.route.with({ auth: Auth.config("OPENAI_API_KEY").bearer() }).model({ id: "gpt-4o-mini" })

const request = LLM.request({
  model,
  system: "You are concise.",
  prompt: "Say hello in one short sentence.",
  generation: { maxTokens: 40 },
})

const program = Effect.gen(function* () {
  const response = yield* LLMClient.generate(request)
  console.log(response.text)
})
```

Run `LLMClient.stream(request)` instead of `generate` when you want incremental `LLMEvent`s. The event stream is provider-neutral — same shape across OpenAI Responses, Anthropic Messages, and any OpenAI-compatible deployment.

## Public API

- **`LLM.request({...})`** — build a provider-neutral `LLMRequest`. Accepts ergonomic inputs (`system: string`, `prompt: string`) that normalize into the canonical Schema classes.
- **`LLM.generate` / `LLM.stream`** — re-exported from `LLMClient` for one-import use.
- **`Message.user(...)` / `Message.assistant(...)` / `Message.tool(...)`** — message constructors from the canonical schema model.
- **`Model.make(...)` / `ToolCallPart.make(...)` / `ToolResultPart.make(...)` / `ToolDefinition.make(...)`** — model and tool-related constructors from the canonical schema model.
- **`LLMClient.prepare(request)`** — compile a request through protocol body construction, validation, and HTTP preparation without sending. Useful for inspection and testing.
- **`LLMEvent.is.*`** — typed guards (`is.textDelta`, `is.toolCall`, `is.finish`, …) for filtering streams.

## Caching

Prompt caching is **on by default**. Every `LLMRequest` resolves to `cache: "auto"` unless the caller opts out with `cache: "none"`. Each protocol translates `CacheHint`s to its wire format (`cache_control` on Anthropic; OpenAI and Gemini do implicit caching server-side and don't need inline markers — auto is a no-op there).

### Auto placement

`"auto"` places three breakpoints — last tool definition, last system part, latest user message. The last-user-message boundary is the load-bearing detail: in a tool-use loop, a single user turn expands into many assistant/tool round-trips, all sharing that prefix. Caching at that boundary lets every intra-turn API call hit.

The math justifies the default: Anthropic's 5-minute cache write is 1.25× base, read is 0.1×, so a single reuse within 5 minutes already wins. One-shot completions below the per-model minimum-cacheable-token threshold silently no-op on the wire, so the worst case is harmless.

### Opting out

```ts
LLM.request({
  model,
  system,
  prompt: "one-off question",
  cache: "none",
})
```

### Granular policy

```ts
cache: {
  tools?: boolean,
  system?: boolean,
  messages?: "latest-user-message" | "latest-assistant" | { tail: number },
  ttlSeconds?: number,         // ≥ 3600 → 1h on Anthropic; else 5m
}
```

### Manual hints

Inline `CacheHint` on any text / system / tool / tool-result part overrides automatic placement. The auto policy preserves manual hints; it only fills gaps.

```ts
LLM.request({
  model,
  system: [
    { type: "text", text: "stable system prompt", cache: { type: "ephemeral" } },
  ],
  ...
})
```

### Provider behavior table

| Protocol                | `cache: "auto"`                                                           |
| ----------------------- | ------------------------------------------------------------------------- |
| Anthropic Messages      | emits up to 3 `cache_control` markers (4-breakpoint cap enforced)         |
| OpenAI Chat / Responses | no-op (implicit caching above 1024 tokens)                                |
| Gemini                  | no-op (implicit caching on 2.5+; explicit `CachedContent` is out-of-band) |

Normalized cache usage is read back into `response.usage.cacheReadInputTokens` and `cacheWriteInputTokens` across every provider.

## Protocol routes

Configure the live protocol route with endpoint and authentication details, then map a catalog model id onto it. The selected model carries the executable route value used at runtime.

```ts
import { Auth } from "@novaclaw/llm/route"
import { OpenAICompatibleChat } from "@novaclaw/llm/protocols/openai-compatible-chat"

const model = OpenAICompatibleChat.route
  .with({
    provider: "local-vllm",
    endpoint: { baseURL: "http://127.0.0.1:8000/v1" },
    auth: Auth.none,
  })
  .model({ id: "qwen3" })
```

The production entry points are Anthropic Messages, OpenAI-compatible Chat, and OpenAI Responses. Gemini remains internal while its compatibility probe is unresolved.

## Provider options & HTTP overlays

Three escape hatches in order of stability:

1. **`generation`** — portable knobs (`maxTokens`, `temperature`, `topP`, `topK`, penalties, seed, stop).
2. **`providerOptions: { <provider>: {...} }`** — provider-specific knobs lowered by the selected protocol.
3. **`http: { body, headers, query }`** — last-resort serializable overlays merged into the final HTTP request. Reach for this only when a stable typed path doesn't yet exist.

Route defaults are overridden by request-level values for each axis.

## Routes

Adding a new model or deployment is usually 5-15 lines using `Route.make({ protocol, endpoint, auth, framing, ... })`. The route owns endpoint/auth/framing and the protocol owns body construction plus stream parsing. Transports are reusable IO templates that receive route endpoint/auth at compile time. Capability/catalog metadata lives outside this low-level package; unsupported request shapes fail during protocol lowering. `src/route/protocol.ts` and `src/route/endpoint.ts` carry the architectural detail in their own headers.

## Effect

This package is built on Effect. Public methods return `Effect` or `Stream`; provide `LLMClient.layer` for runtime dispatch and import the protocol modules for the routes you use.

## See also

- `src/protocols/` — one file per protocol; each is the worked example for adding another
- `test/provider/*.test.ts` — fixture-first protocol tests; `*.recorded.test.ts` files cover live cassettes
