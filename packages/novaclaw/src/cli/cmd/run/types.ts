// Shared type vocabulary for `novaclaw run`'s headless output formatting.
//
// The event `loop()` in ../run.ts turns SDK events into these shapes, and
// run/tool.ts consumes them to render tool calls to stdout. (The far richer
// interactive `--mini` split-footer types that once lived here were removed
// with the TUI — only the headless-output vocabulary survives.)
// V1-nuke slice D: the run CLI's LOCAL tool-part rendering model (was the retired V1 wire
// ToolPart type). The CLI builds these itself from native tool events; only the renderer reads them.
export type ToolPart = {
  id: string
  tool: string
  state: { status: string; metadata?: Record<string, unknown>; [key: string]: unknown }
  [key: string]: unknown
}
