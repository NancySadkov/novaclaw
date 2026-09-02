export { LLMClient } from "./route/client"
export { Auth } from "./route/auth"
export {
  classify,
  imageLimitFrom,
  isContextOverflow,
  isContextOverflowFailure,
  isMediaLimit,
  isModelMissing,
  mediaLimitFailure,
} from "./provider-error"
export type {
  RouteModelInput,
  RouteRoutedModelInput,
  Interface as LLMClientShape,
  Service as LLMClientService,
} from "./route/client"
export * from "./schema"
export {
  TruncatedArgs,
  TRUNCATED_ARGS_SENTINEL,
  truncatedArgsInput,
  truncatedArgsMessage,
  truncatedArgsResult,
} from "./protocols/utils/truncated-args"
// Exported because the CAPABILITY PROBE has to measure the channel the decoder actually recovers.
// A probe with its own reader would report "this endpoint can do prompted tools" for a format the
// runner cannot parse — a verdict about a channel that does not exist. One reader, both ends.
export { recoverToolCallsFromText, resolveToolName } from "./protocols/utils/tool-recovery"
export type { RecoveredCall } from "./protocols/utils/tool-recovery"
export { Tool, ToolFailure, toDefinitions } from "./tool"
export { ToolRuntime } from "./tool-runtime"
export type { DispatchResult as ToolDispatchResult, ToolSettlement } from "./tool-runtime"
export type {
  AnyExecutableTool,
  AnyTool,
  ExecutableTool,
  ExecutableTools,
  Tool as ToolShape,
  ToolExecute,
  ToolExecuteContext,
  ToolModelOutputInput,
  Tools,
  ToolSchema,
  ToolToModelOutput,
} from "./tool"
export * as LLM from "./llm"
