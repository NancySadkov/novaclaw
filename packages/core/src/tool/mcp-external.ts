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
    options: { readonly toolCallId: string; readonly messages: ReadonlyArray<never>; readonly abortSignal?: AbortSignal },
  ) => Promise<unknown>
}

// AI-SDK `jsonSchema(x)` wraps the raw schema as `{ jsonSchema: x, ... }`; unwrap it.
const rawSchema = (tool: AiSdkTool) => {
  const wrapped = tool.inputSchema as { jsonSchema?: unknown } | undefined
  return (wrapped?.jsonSchema ?? tool.inputSchema ?? { type: "object" }) as Parameters<typeof makeExternal>[0]["inputSchema"]
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

const toContent = (result: unknown): ReadonlyArray<Content> => {
  const parts = (result as { content?: unknown } | undefined)?.content
  const texts = Array.isArray(parts)
    ? parts.flatMap((part) =>
        part && typeof part === "object" && (part as any).type === "text" && typeof (part as any).text === "string"
          ? [(part as any).text as string]
          : [],
      )
    : []
  // The frame rides the FIRST part only — the parts arrive as one ordered answer from one server, so
  // repeating it per part would pay the token cost N times to say the same thing once.
  if (texts.length > 0) return texts.map((text, index) => ({ type: "text", text: index === 0 ? FRAME + text : text }))
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
export const fromMcpTool = (tool: AiSdkTool, options?: { gate?: (context: Context) => Effect.Effect<void, Failure> }): AnyTool =>
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
