// Per-tool summaries for the headless `novaclaw run` output.
import os from "os"
import path from "path"
import { Schema } from "effect"
import type * as Tool from "@/tool/tool"
import * as Locale from "@/util/locale"
import type { ToolPart } from "./types"

// The concrete V1 tool cluster is retired. The run renderer needs only the fields it displays, so
// these local schemas describe that narrow input rather than restoring a dependency on the old tools.
const TaskParameters = Schema.Struct({
  description: Schema.String,
  subagent_type: Schema.String,
})
type TaskToolInfo = Tool.Info<typeof TaskParameters>

const PlanExitParameters = Schema.Struct({})
type PlanExitToolInfo = Tool.Info<typeof PlanExitParameters>

const GlobParameters = Schema.Struct({ path: Schema.optional(Schema.String), pattern: Schema.optional(Schema.String) })
type GlobToolInfo = Tool.Info<typeof GlobParameters, { count: number }>

const GrepParameters = Schema.Struct({ path: Schema.optional(Schema.String), pattern: Schema.optional(Schema.String) })
type GrepToolInfo = Tool.Info<typeof GrepParameters, { matches: number }>

const ReadParameters = Schema.Struct({ filePath: Schema.optional(Schema.String) })
type ReadToolInfo = Tool.Info<typeof ReadParameters>

const WriteParameters = Schema.Struct({ filePath: Schema.optional(Schema.String) })
type WriteToolInfo = Tool.Info<typeof WriteParameters>

const WebFetchParameters = Schema.Struct({ url: Schema.optional(Schema.String) })
type WebFetchToolInfo = Tool.Info<typeof WebFetchParameters>

const EditParameters = Schema.Struct({ filePath: Schema.optional(Schema.String) })
type EditToolInfo = Tool.Info<typeof EditParameters, { diff: string }>

const WebSearchParameters = Schema.Struct({ query: Schema.optional(Schema.String) })
type WebSearchToolInfo = Tool.Info<typeof WebSearchParameters, { provider: unknown }>

const BashParameters = Schema.Struct({ command: Schema.optional(Schema.String) })
type BashToolInfo = Tool.Info<typeof BashParameters>

const TodoWriteParameters = Schema.Struct({ todos: Schema.optional(Schema.Any) })
type TodoWriteToolInfo = Tool.Info<typeof TodoWriteParameters>

const SkillParameters = Schema.Struct({ name: Schema.optional(Schema.String) })
type SkillToolInfo = Tool.Info<typeof SkillParameters>

const ApplyPatchParameters = Schema.Struct({})
type ApplyPatchToolInfo = Tool.Info<typeof ApplyPatchParameters, { files: ReadonlyArray<unknown> }>

const QuestionParameters = Schema.Struct({ questions: Schema.optional(Schema.Any) })
type QuestionToolInfo = Tool.Info<typeof QuestionParameters>

const InvalidParameters = Schema.Struct({})
type InvalidToolInfo = Tool.Info<typeof InvalidParameters>

type ToolDict = Record<string, unknown>

type ToolFrame = {
  name: string
  input: ToolDict
  meta: ToolDict
  state: ToolDict
  status: string
}

export type ToolInline = {
  icon: string
  title: string
  description?: string
  mode?: "inline" | "block"
  body?: string
}

type ToolProps<T = Tool.Info> = {
  input: Partial<Tool.InferParameters<T>>
  metadata: Partial<Tool.InferMetadata<T>>
  frame: ToolFrame
}

type ToolDefs = {
  invalid: InvalidToolInfo
  bash: BashToolInfo
  write: WriteToolInfo
  edit: EditToolInfo
  apply_patch: ApplyPatchToolInfo
  batch: Tool.Info
  task: TaskToolInfo
  todowrite: TodoWriteToolInfo
  question: QuestionToolInfo
  read: ReadToolInfo
  glob: GlobToolInfo
  grep: GrepToolInfo
  list: Tool.Info
  webfetch: WebFetchToolInfo
  websearch: WebSearchToolInfo
  skill: SkillToolInfo
  plan_exit: PlanExitToolInfo
}

type ToolName = keyof ToolDefs
type ToolRule<T = Tool.Info> = { run: (props: ToolProps<T>) => ToolInline }
type ToolRegistry = { [K in ToolName]: ToolRule<ToolDefs[K]> }
type AnyToolRule = ToolRule

function dict(value: unknown): ToolDict {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return { ...value }
}

function props<T = Tool.Info>(frame: ToolFrame): ToolProps<T> {
  return {
    input: Object.assign(Object.create(null), frame.input),
    metadata: Object.assign(Object.create(null), frame.meta),
    frame,
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? value : []
}

function info(data: ToolDict, skip: string[] = []): string {
  const entries = Object.entries(data).filter(
    ([key, value]) =>
      !skip.includes(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean"),
  )
  return entries.length === 0 ? "" : `[${entries.map(([key, value]) => `${key}=${String(value)}`).join(", ")}]`
}

function toolPath(input?: string): string {
  if (!input) return ""

  const cwd = process.cwd()
  const home = os.homedir()
  const absolute = path.isAbsolute(input) ? input : path.resolve(cwd, input)
  const relative = path.relative(cwd, absolute)

  if (!relative) return "."
  if (!relative.startsWith("..")) return relative.replaceAll("\\", "/")
  if (home && (absolute === home || absolute.startsWith(home + path.sep))) {
    return absolute.replace(home, "~").replaceAll("\\", "/")
  }
  return absolute.replaceAll("\\", "/")
}

function fallbackInline(frame: ToolFrame): ToolInline {
  const title = text(frame.state.title) || (Object.keys(frame.input).length > 0 ? JSON.stringify(frame.input) : "Unknown")
  return { icon: "⚙", title: `${frame.name} ${title}` }
}

function count(n: number, label: string): string {
  return `${n} ${label}${n === 1 ? "" : "es"}`
}

function runGlob(p: ToolProps<GlobToolInfo>): ToolInline {
  const root = p.input.path ?? ""
  const suffix = root ? `in ${toolPath(root)}` : ""
  const matches = p.metadata.count
  const description = matches === undefined ? suffix : `${suffix}${suffix ? " · " : ""}${count(matches, "match")}`
  return { icon: "✱", title: `Glob "${p.input.pattern ?? ""}"`, ...(description && { description }) }
}

function runGrep(p: ToolProps<GrepToolInfo>): ToolInline {
  const root = p.input.path ?? ""
  const suffix = root ? `in ${toolPath(root)}` : ""
  const matches = p.metadata.matches
  const description = matches === undefined ? suffix : `${suffix}${suffix ? " · " : ""}${count(matches, "match")}`
  return { icon: "✱", title: `Grep "${p.input.pattern ?? ""}"`, ...(description && { description }) }
}

function runList(p: ToolProps): ToolInline {
  const directory = text(dict(p.input).path)
  return { icon: "→", title: directory ? `List ${toolPath(directory)}` : "List" }
}

function runRead(p: ToolProps<ReadToolInfo>): ToolInline {
  const description = info(p.frame.input, ["filePath"]) || undefined
  return { icon: "→", title: `Read ${toolPath(p.input.filePath)}`, ...(description && { description }) }
}

function runWrite(p: ToolProps<WriteToolInfo>): ToolInline {
  return {
    icon: "←",
    title: `Write ${toolPath(p.input.filePath)}`,
    mode: "block",
    body: p.frame.status === "completed" ? text(p.frame.state.output) : undefined,
  }
}

function runWebfetch(p: ToolProps<WebFetchToolInfo>): ToolInline {
  const url = p.input.url ?? ""
  return { icon: "%", title: url ? `WebFetch ${url}` : "WebFetch" }
}

function runEdit(p: ToolProps<EditToolInfo>): ToolInline {
  return { icon: "←", title: `Edit ${toolPath(p.input.filePath)}`, mode: "block", body: p.metadata.diff }
}

function webSearchProviderLabel(provider: unknown): string {
  if (provider === "parallel") return "Parallel Web Search"
  if (provider === "exa") return "Exa Web Search"
  return "Web Search"
}

function runWebSearch(p: ToolProps<WebSearchToolInfo>): ToolInline {
  const title = webSearchProviderLabel(p.metadata.provider)
  return { icon: "◈", title: p.input.query ? `${title} "${p.input.query}"` : title }
}

function runTask(p: ToolProps<TaskToolInfo>): ToolInline {
  const kind = Locale.titlecase(p.input.subagent_type || "unknown")
  const description = p.input.description
  const icon = p.frame.status === "error" ? "✗" : p.frame.status === "running" ? "•" : "✓"
  return {
    icon,
    title: description || `${kind} Task`,
    description: description ? `${kind} Agent` : undefined,
  }
}

function runTodo(p: ToolProps<TodoWriteToolInfo>): ToolInline {
  return {
    icon: "#",
    title: "Todos",
    mode: "block",
    body: list<{ status?: string; content?: string }>(p.frame.input.todos)
      .flatMap((item) => {
        const body = typeof item?.content === "string" ? item.content : ""
        if (!body) return []
        const mark = item.status === "completed" ? "[✓]" : item.status === "in_progress" ? "[•]" : "[ ]"
        return [`${mark} ${body}`]
      })
      .join("\n"),
  }
}

function runSkill(p: ToolProps<SkillToolInfo>): ToolInline {
  return { icon: "→", title: `Skill "${p.input.name ?? ""}"` }
}

function runPatch(p: ToolProps<ApplyPatchToolInfo>): ToolInline {
  const files = p.metadata.files?.length ?? 0
  return files === 0
    ? { icon: "%", title: "Patch" }
    : { icon: "%", title: `Patch ${files} file${files === 1 ? "" : "s"}` }
}

function runQuestion(p: ToolProps<QuestionToolInfo>): ToolInline {
  const total = list(p.frame.input.questions).length
  return { icon: "→", title: `Asked ${total} question${total === 1 ? "" : "s"}` }
}

function runInvalid(p: ToolProps<InvalidToolInfo>): ToolInline {
  return {
    icon: "✗",
    title: text(p.frame.state.title) || "Invalid Tool",
    mode: "block",
    body: p.frame.status === "completed" ? text(p.frame.state.output) : undefined,
  }
}

function runBatch(p: ToolProps): ToolInline {
  const calls = list(dict(p.input).tool_calls).length
  return {
    icon: "#",
    title: text(p.frame.state.title) || (calls > 0 ? `Batch ${calls} tool${calls === 1 ? "" : "s"}` : "Batch"),
    mode: "block",
    body: p.frame.status === "completed" ? text(p.frame.state.output) : undefined,
  }
}

function runPlanExit(p: ToolProps<PlanExitToolInfo>): ToolInline {
  return {
    icon: "→",
    title: text(p.frame.state.title) || "Switching to build agent",
    mode: "block",
    body: p.frame.status === "completed" ? text(p.frame.state.output) : undefined,
  }
}

function runBash(p: ToolProps<BashToolInfo>): ToolInline {
  return {
    icon: "$",
    title: p.input.command || "",
    mode: "block",
    body: p.frame.status === "completed" ? text(p.frame.state.output).trim() : undefined,
  }
}

const TOOL_RULES = {
  invalid: { run: runInvalid },
  bash: { run: runBash },
  write: { run: runWrite },
  edit: { run: runEdit },
  apply_patch: { run: runPatch },
  batch: { run: runBatch },
  task: { run: runTask },
  todowrite: { run: runTodo },
  question: { run: runQuestion },
  read: { run: runRead },
  glob: { run: runGlob },
  grep: { run: runGrep },
  list: { run: runList },
  webfetch: { run: runWebfetch },
  websearch: { run: runWebSearch },
  skill: { run: runSkill },
  plan_exit: { run: runPlanExit },
} as const satisfies ToolRegistry

function key(name: string): name is ToolName {
  return Object.prototype.hasOwnProperty.call(TOOL_RULES, name)
}

function rule(name?: string): AnyToolRule | undefined {
  return name && key(name) ? TOOL_RULES[name] : undefined
}

function frame(part: ToolPart): ToolFrame {
  const state = dict(part.state)
  return {
    name: part.tool,
    input: dict(state.input),
    meta: "metadata" in part.state ? dict(part.state.metadata) : {},
    state,
    status: text(state.status),
  }
}

export function toolInlineInfo(part: ToolPart): ToolInline {
  const context = frame(part)
  const draw = rule(context.name)?.run
  try {
    return draw ? draw(props(context)) : fallbackInline(context)
  } catch {
    return fallbackInline(context)
  }
}
