import { Effect } from "effect"
import {
  LLMEvent,
  type ToolCallPart,
  ToolFailure,
  ToolOutput,
  ToolResultValue,
  type ToolOutput as ToolOutputType,
  type ToolResultValue as ToolResultValueType,
} from "./schema"
import { type AnyTool, type Tools } from "./tool"
import { UNKNOWN_TOOL_LIST_BUDGET, closestToolName, unknownToolMessage } from "./unknown-tool"

export interface ToolSettlement {
  readonly result: ToolResultValueType
  readonly output?: ToolOutputType
}

export interface DispatchResult extends ToolSettlement {
  readonly events: ReadonlyArray<LLMEvent>
}

/** Execute one canonical tool call without owning provider IO or continuation. */
export const dispatch = (tools: Tools, call: ToolCallPart): Effect.Effect<DispatchResult> => {
  const tool = tools[call.name]
  // `tools` IS the advertised set at this seam — the same record the caller lowered into `request.tools`
  // via `toDefinitions(tools)` — so the model is handed back exactly the horizon it was given, in the same
  // order. Anything less specific (a bare `Unknown tool: X`) leaves it nothing to correct toward; see
  // unknown-tool.ts for why that is the defect and not a cosmetic difference.
  if (!tool)
    return Effect.succeed(result(call, { type: "error", value: unknownToolMessage(call.name, Object.keys(tools)) }))
  if (!tool.execute)
    return Effect.succeed(result(call, { type: "error", value: `Tool has no execute handler: ${call.name}` }))

  return decodeAndExecute(tool, call).pipe(
    Effect.map((value) => result(call, value)),
    Effect.catchTag("LLM.ToolFailure", (failure) =>
      Effect.succeed(result(call, { type: "error", value: failure.message }, failure.error)),
    ),
  )
}

const decodeAndExecute = (tool: AnyTool, call: ToolCallPart): Effect.Effect<ToolSettlement, ToolFailure> =>
  tool._decode(call.input).pipe(
    Effect.mapError((error) => new ToolFailure({ message: `Invalid tool input: ${error.message}` })),
    Effect.flatMap((decoded) =>
      tool.execute!(decoded, { id: call.id, name: call.name }).pipe(
        Effect.flatMap((value) =>
          tool._encode(value).pipe(
            Effect.mapError(
              (error) =>
                new ToolFailure({
                  message: `Tool returned an invalid value for its success schema: ${error.message}`,
                }),
            ),
          ),
        ),
        Effect.map((encoded) => {
          if (tool._legacyResult && ToolResultValue.is(encoded))
            return { result: encoded, output: ToolOutput.fromResultValue(encoded) }
          const output = tool._project(decoded, call.id, encoded)
          const result = ToolOutput.toResultValue(output)
          return result.type === "error" ? { result } : { result, output }
        }),
      ),
    ),
  )

const result = (call: ToolCallPart, value: ToolResultValueType | ToolSettlement, error?: unknown): DispatchResult => {
  const settlement = ToolResultValue.is(value) ? { result: value } : value
  return {
    result: settlement.result,
    output: settlement.output,
    events:
      settlement.result.type === "error"
        ? [
            LLMEvent.toolError({ id: call.id, name: call.name, message: String(settlement.result.value), error }),
            LLMEvent.toolResult({ id: call.id, name: call.name, result: settlement.result }),
          ]
        : [LLMEvent.toolResult({ id: call.id, name: call.name, result: settlement.result, output: settlement.output })],
  }
}

/**
 * `unknownToolMessage` and friends ride the `ToolRuntime` namespace deliberately: `@novaclaw/core` runs its
 * OWN dispatch (`ToolRegistry.materialize().settle`) and must answer an unadvertised name with the same
 * words this one does, so the crossing names its source of truth at the call site —
 * `ToolRuntime.unknownToolMessage(name, advertised)`. One implementation, two seams (ruling 6).
 */
export const ToolRuntime = { dispatch, unknownToolMessage, closestToolName, UNKNOWN_TOOL_LIST_BUDGET } as const
