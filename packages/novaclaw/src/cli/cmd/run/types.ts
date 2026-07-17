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

// The semantic role of a scrollback entry. Maps 1:1 to theme colors.
export type EntryKind = "system" | "user" | "assistant" | "reasoning" | "tool" | "error"

export type TurnSummary = {
  agent: string
  model: string
  duration: string
}

export type ToolCodeSnapshot = {
  kind: "code"
  title: string
  content: string
  file?: string
}

export type ToolDiffSnapshot = {
  kind: "diff"
  items: Array<{
    title: string
    diff: string
    file?: string
    deletions?: number
  }>
}

export type ToolTaskSnapshot = {
  kind: "task"
  title: string
  rows: string[]
  tail: string
}

export type ToolTodoSnapshot = {
  kind: "todo"
  items: Array<{
    status: string
    content: string
  }>
  tail: string
}

export type ToolQuestionSnapshot = {
  kind: "question"
  items: Array<{
    question: string
    answer: string
  }>
  tail: string
}

export type ToolSnapshot =
  | ToolCodeSnapshot
  | ToolDiffSnapshot
  | ToolTaskSnapshot
  | ToolTodoSnapshot
  | ToolQuestionSnapshot

export type RunEntryBody =
  | { type: "none" }
  | { type: "text"; content: string }
  | { type: "code"; content: string; filetype?: string }
  | { type: "markdown"; content: string }
  | { type: "structured"; snapshot: ToolSnapshot }

// Lifecycle phase of a scrollback entry. "start" opens the entry, "progress"
// appends content, "final" closes it.
export type StreamPhase = "start" | "progress" | "final"

export type StreamSource = "assistant" | "reasoning" | "tool" | "system"

export type StreamToolState = "running" | "completed" | "error"

// A single append-only commit to scrollback. The event loop produces these from
// SDK events and run/tool.ts renders them to stdout.
export type StreamCommit = {
  kind: EntryKind
  text: string
  phase: StreamPhase
  source: StreamSource
  summary?: TurnSummary
  messageID?: string
  partID?: string
  tool?: string
  part?: ToolPart
  interrupted?: boolean
  toolState?: StreamToolState
  toolError?: string
  shell?: {
    callID: string
    command: string
  }
}
