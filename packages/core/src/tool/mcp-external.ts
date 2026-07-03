export * as McpExternal from "./mcp-external"

import { Effect } from "effect"
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

const toContent = (result: unknown): ReadonlyArray<Content> => {
  const parts = (result as { content?: unknown } | undefined)?.content
  const texts = Array.isArray(parts)
    ? parts.flatMap((part) =>
        part && typeof part === "object" && (part as any).type === "text" && typeof (part as any).text === "string"
          ? [(part as any).text as string]
          : [],
      )
    : []
  if (texts.length > 0) return texts.map((text) => ({ type: "text", text }))
  const structured = (result as { structuredContent?: unknown } | undefined)?.structuredContent ?? result
  return [{ type: "text", text: typeof structured === "string" ? structured : JSON.stringify(structured ?? {}) }]
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
