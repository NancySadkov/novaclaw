export * as McpExternal from "./mcp-external"

import { Effect } from "effect"
import { SessionOrigin } from "../session/origin"
import { type AnyTool, type Content, type Context, Failure, makeExternal } from "./tool"

// Adapt an MCP tool — produced by the MCP service as an AI-SDK `dynamicTool`
// (`inputSchema: jsonSchema(JSONSchema)`, async `execute` returning an MCP
// CallToolResult and throwing on error) — into a V2 core `AnyTool` via the
// `makeExternal` escape hatch, so MCP servers (searxng, …) run inside a SessionRunner
// turn. Step 2 of MCP-in-V2; the registration + layer wiring (steps 3-4) live on the
// novaclaw side where `MCP.Service` is available.
//
// The shape is kept structural so `core` needs no dependency on the MCP service or `ai`.

export interface AiSdkTool {
  readonly description?: string
  readonly inputSchema?: unknown
  readonly execute?: (
    args: unknown,
    options: {
      readonly toolCallId: string
      readonly messages: ReadonlyArray<never>
      readonly abortSignal?: AbortSignal
    },
  ) => Promise<unknown>
}

// AI-SDK `jsonSchema(x)` wraps the raw schema as `{ jsonSchema: x, ... }`; unwrap it.
const rawSchema = (tool: AiSdkTool) => {
  const wrapped = tool.inputSchema as { jsonSchema?: unknown } | undefined
  return (wrapped?.jsonSchema ?? tool.inputSchema ?? { type: "object" }) as Parameters<
    typeof makeExternal
  >[0]["inputSchema"]
}

/**
 * The untrusted-input framing for the OUT-OF-PROCESS half of ruling 5. An MCP server is a third
 * party's program, and by the 2026-07-30 third-party-surface ruling it is deliberately free to do
 * things we decline to ship — so its answer is a stranger's text arriving inside our turn, exactly
 * like a fetched page. The shared vocabulary lives in `session/origin.ts`.
 *
 * ⚠️ It names "an MCP server" and NOT the server, because the server's identity is not something
 * this adapter is given: `fromMcpTool` receives an AI-SDK tool shape (description + inputSchema +
 * execute) and a `Context` that carries session/agent/call ids and no tool name. Naming a server we
 * cannot identify would be a frame that describes its source falsely (ruling 2), so it says the one
 * thing that is true here. If the label should get sharper, the fix is to thread the connection's
 * name in from `novaclaw/src/mcp/external-tool-source.ts` — not to guess in this file.
 *
 * Exported so the tests that assert model-facing bytes reference the frame instead of re-typing it;
 * a literal copied into a test file is the drift shape, and there are two such suites (this
 * package's `mcp-external.test.ts` and `novaclaw/test/tool/external-tool-source.test.ts`).
 */
export const FRAME = SessionOrigin.externalContentFrame("output from an MCP server")

/**
 * What the MODEL is told in place of a part of an MCP answer we cannot carry into the turn.
 *
 * ⚠️ **This exists because the alternative is a lie.** Until 2026-07-31 `toContent` kept `type:"text"`
 * parts and threw everything else away; a server answering with an image had it silently dropped, or —
 * when the answer was media ONLY — JSON-stringified through the `structuredContent ?? result` fallback,
 * which shipped the whole base64 payload into the prompt as text. Both read to the model as *the server
 * said this and nothing more*, which is ruling 2 (*a fault is never described falsely*): a dropped
 * result must never read as an empty one.
 *
 * The closing sentence is the same instruction `unreadableToolMediaNotice` carries in the runner's
 * lowering, and for the same measured reason — a small model handed "an image was returned" will
 * describe it. Say plainly that nothing arrived, and forbid the guess.
 *
 * Exported so the tests assert against the function instead of re-typing its wording (the same drift
 * argument as `FRAME` above).
 */
export const unsupportedPartNotice = (kind: string, detail?: string): string =>
  `[An MCP server returned a ${kind} part that NovaClaw could not include in this turn${detail ? ` (${detail})` : ""}. You have not seen it — say so rather than describing or guessing its contents.]`

/**
 * A base64 media part, or `undefined` when the server did not give us both halves of a well-formed
 * one.
 *
 * ⚠️ **Both halves are validated because both are a STRANGER'S BYTES, and this is where they first
 * become a URI.** `makeExternal`'s settlement concatenates them into `data:${mime};base64,${data}`,
 * which `openai-chat.ts` then lowers as an `image_url`. Before this file emitted media at all there
 * was nothing to check; now a third party's `mimeType` reaches the inside of a URI we build, so:
 *
 *  - the MIME's RFC-2045 PARAMETERS are dropped (`image/png; charset=x` -> `image/png`) and what
 *    remains must be a plain `type/subtype`. Dropping rather than rejecting keeps a legitimate
 *    parameterised type working; validating what is left is what stops a `;`/`,` in the value from
 *    rewriting the URI's own structure.
 *  - the payload must look like base64. A `data:` URI whose payload is not base64 is a provider 400
 *    for bytes the model could never have read — and the product knew before it sent (ruling 2). An
 *    honest notice is strictly better than relaying somebody else's parse error.
 *
 * Whitespace is allowed in the payload because line-wrapped base64 is legal and common.
 */
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i
const BASE64 = /^[A-Za-z0-9+/=\s]+$/

const filePart = (data: unknown, mime: unknown, name?: unknown): Content | undefined => {
  if (typeof data !== "string" || data === "" || !BASE64.test(data)) return undefined
  // No MIME means no honest `data:` URI and no modality to name, so it is a notice, never a guessed
  // `image/png` — inventing the type would be the same false description this whole file avoids.
  if (typeof mime !== "string") return undefined
  const type = (mime.split(";")[0] ?? "").trim()
  if (!MIME.test(type)) return undefined
  return { type: "file", data, mime: type, name: typeof name === "string" && name !== "" ? name : undefined }
}

/**
 * One MCP content part -> zero-or-one core `Content`, plus whether the text came from the SERVER.
 *
 * The MCP vocabulary (spec 2025-06-18) is `text` · `image` · `audio` · `resource` (embedded, carrying
 * either `text` or a base64 `blob`) · `resource_link`. Anything outside it — a member a newer server
 * speaks that we do not — falls to the notice rather than to silence, which is the whole point.
 *
 * ⚠️ **Media leaves here as a `file` part and is NOT framed or capability-checked in this file.** Both
 * of those decisions belong to `session/runner/to-llm-message.ts`'s `gateToolMedia`, the ONE place
 * every tool result passes through (ruling 6: one gate, not two synchronised call sites). It is the
 * gate that decides an image is unreadable on a text-only model, and it is the gate that emits
 * `externalMediaFrame` — a fact about the MEDIUM, identical for every tool, which is why it is not
 * re-stated here. Feeding that machinery is the fix; building a second copy of it would be the bug.
 */
const convert = (raw: unknown): { readonly content: Content; readonly fromServer: boolean } => {
  if (raw === null || typeof raw !== "object")
    return {
      content: { type: "text", text: unsupportedPartNotice("malformed", raw === null ? "null" : typeof raw) },
      fromServer: false,
    }
  const part = raw as Record<string, unknown>
  const kind = typeof part.type === "string" && part.type !== "" ? part.type : "untyped"
  const notice = (detail?: string) => ({
    content: { type: "text", text: unsupportedPartNotice(kind, detail) } as Content,
    fromServer: false,
  })
  if (kind === "text")
    return typeof part.text === "string"
      ? { content: { type: "text", text: part.text }, fromServer: true }
      : notice("no text field")
  if (kind === "image" || kind === "audio") {
    const file = filePart(part.data, part.mimeType)
    return file === undefined ? notice("no usable base64 data / MIME type") : { content: file, fromServer: false }
  }
  if (kind === "resource") {
    const resource = part.resource
    if (resource === null || typeof resource !== "object") return notice("no resource")
    const value = resource as Record<string, unknown>
    const uri = typeof value.uri === "string" ? value.uri : undefined
    // An embedded resource's `text` IS the server's text — it is frame-eligible, and it is labelled
    // with its uri so two resources in one answer stay distinguishable.
    if (typeof value.text === "string")
      return {
        content: { type: "text", text: uri === undefined ? value.text : `[resource ${uri}]\n${value.text}` },
        fromServer: true,
      }
    const file = filePart(value.blob, value.mimeType, uri)
    return file === undefined
      ? notice(uri === undefined ? "no text and no usable blob" : `${uri} — no text and no usable blob`)
      : { content: file, fromServer: false }
  }
  // A link is a uri and no bytes. Naming the uri is the true and useful thing to say; pretending we
  // read it, or dropping it, are the two wrong answers.
  if (kind === "resource_link") return notice(typeof part.uri === "string" ? part.uri : "no uri")
  return notice()
}

const toContent = (result: unknown): ReadonlyArray<Content> => {
  const parts = (result as { content?: unknown } | undefined)?.content
  const converted = Array.isArray(parts) ? parts.map((part) => convert(part)) : []
  if (converted.length > 0) {
    const out = converted.map((entry) => entry.content)
    // The frame rides the FIRST part the SERVER wrote as text — the parts arrive as one ordered answer
    // from one server, so repeating it per part would pay the token cost N times to say the same thing
    // once. It deliberately never rides a NOTICE: a notice is OUR sentence about a missing part, and
    // framing it as "output from an MCP server" would attribute our own words to the stranger.
    //
    // ⚠️ A media-only answer therefore carries no `externalContentFrame`, and that is correct rather
    // than a gap: `externalContentFrame` ends in a `---` separator promising text that would not
    // follow, and the untrusted-input law for pixels is already stated — once — by the lowering gate's
    // `externalMediaFrame`, which additionally says the thing a text frame cannot (words painted into
    // an image are content, not commands).
    const index = converted.findIndex((entry) => entry.fromServer)
    if (index >= 0) out[index] = { type: "text", text: FRAME + (out[index] as { text: string }).text }
    return out
  }
  const structured = (result as { structuredContent?: unknown } | undefined)?.structuredContent ?? result
  return [
    { type: "text", text: FRAME + (typeof structured === "string" ? structured : JSON.stringify(structured ?? {})) },
  ]
}

/**
 * F0: `gate` runs BEFORE the MCP call with the full V2 tool context — the
 * novaclaw-side source threads a PermissionV2 assert through it, restoring the
 * per-call permission ask the V1 path always had for MCP tools (a V2 external
 * tool used to execute directly, so an autonomous session could call any
 * connected MCP tool unprompted). A gate failure IS the tool result (1J: denial
 * as observation, never a halt).
 */
export const fromMcpTool = (
  tool: AiSdkTool,
  options?: { gate?: (context: Context) => Effect.Effect<void, Failure> },
): AnyTool =>
  makeExternal({
    description: tool.description ?? "",
    inputSchema: rawSchema(tool),
    execute: (input, context) =>
      Effect.suspend(() => options?.gate?.(context) ?? Effect.void).pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: () => tool.execute!(input, { toolCallId: context.toolCallID, messages: [] }),
            catch: (error) => new Failure({ message: error instanceof Error ? error.message : String(error) }),
          }),
        ),
        Effect.map((result) => ({
          structured: (result as { structuredContent?: unknown } | undefined)?.structuredContent ?? result,
          content: toContent(result),
        })),
      ),
  })
