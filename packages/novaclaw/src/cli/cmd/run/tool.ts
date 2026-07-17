// Per-tool display rules shared across `novaclaw run` output paths.
//
// Each known tool (bash, edit, write, task, etc.) has a ToolRule that controls
// five display hooks:
//
//   view       → visibility policy for progress/final scrollback entries and
//                whether completed finals can render as structured snapshots
//   run        → inline summary for the non-interactive `run` command output
//   scroll     → text formatting for start/progress/final scrollback entries
//   permission → display info for the permission UI (icon, title, diff)
//   snap       → structured snapshot (code block, diff, task card) for rich
//                scrollback entries
//
// Tools not in TOOL_RULES get fallback formatting.
import os from "os"
import path from "path"
import stripAnsi from "strip-ansi"
import { Schema } from "effect"
import type { ToolPart } from "./types"
import type * as Tool from "@/tool/tool"
import { LANGUAGE_EXTENSIONS } from "@/util/language"
import * as Locale from "@/util/locale"
import type { RunEntryBody, StreamCommit, ToolSnapshot } from "./types"

// F1f: the V1 `task` and `plan_exit` tools are deleted with the V1 engine tree. These run-output
// display rules only need each tool's parameter/metadata SHAPE for type-safe formatting, so carry
// a local stub (mirrors the tools' `Parameters`). Re-point to the core tools if/when native
// `task`/`plan_exit` land.
const TaskParameters = Schema.Struct({
  description: Schema.String,
  prompt: Schema.String,
  subagent_type: Schema.String,
  task_id: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
  background: Schema.optional(Schema.Boolean),
})
type TaskToolInfo = Tool.Info<typeof TaskParameters>
const PlanExitParameters = Schema.Struct({})
type PlanExitToolInfo = Tool.Info<typeof PlanExitParameters>

// F1f: the concrete V1 tool cluster is retired. These `novaclaw run` display rules need only each
// tool's parameter/metadata SHAPE for type-safe formatting, so carry a local stub of each (like the
// task/plan_exit stubs above); the shapes cover exactly the fields the display code reads.
const GlobParameters = Schema.Struct({ path: Schema.optional(Schema.String), pattern: Schema.optional(Schema.String) })
type GlobToolInfo = Tool.Info<typeof GlobParameters>
const GrepParameters = Schema.Struct({ path: Schema.optional(Schema.String), pattern: Schema.optional(Schema.String) })
type GrepToolInfo = Tool.Info<typeof GrepParameters, { count: number; matches: number }>
const ReadParameters = Schema.Struct({ filePath: Schema.optional(Schema.String) })
type ReadToolInfo = Tool.Info<typeof ReadParameters>
const WriteParameters = Schema.Struct({ filePath: Schema.optional(Schema.String), content: Schema.optional(Schema.String) })
type WriteToolInfo = Tool.Info<typeof WriteParameters>
const WebFetchParameters = Schema.Struct({ url: Schema.optional(Schema.String) })
type WebFetchToolInfo = Tool.Info<typeof WebFetchParameters>
const EditParameters = Schema.Struct({ filePath: Schema.optional(Schema.String) })
type EditToolInfo = Tool.Info<typeof EditParameters, { diff: string }>
const WebSearchParameters = Schema.Struct({ query: Schema.optional(Schema.String) })
type WebSearchToolInfo = Tool.Info<typeof WebSearchParameters, { provider: unknown }>
const BashParameters = Schema.Struct({ command: Schema.optional(Schema.String), workdir: Schema.optional(Schema.String) })
type BashToolInfo = Tool.Info<typeof BashParameters, { exit: number }>
const TodoWriteParameters = Schema.Struct({ todos: Schema.optional(Schema.Any) })
type TodoWriteToolInfo = Tool.Info<typeof TodoWriteParameters>
const SkillParameters = Schema.Struct({ name: Schema.optional(Schema.String) })
type SkillToolInfo = Tool.Info<typeof SkillParameters>
type ApplyPatchFile = {
  type?: string
  relativePath?: string
  filePath?: string
  movePath?: string
  patch?: string
  deletions?: number
}
const ApplyPatchParameters = Schema.Struct({})
type ApplyPatchToolInfo = Tool.Info<typeof ApplyPatchParameters, { files: ReadonlyArray<ApplyPatchFile> }>
const QuestionParameters = Schema.Struct({ questions: Schema.optional(Schema.Any) })
type QuestionToolInfo = Tool.Info<typeof QuestionParameters, { answers: ReadonlyArray<readonly string[]> }>
const InvalidParameters = Schema.Struct({})
type InvalidToolInfo = Tool.Info<typeof InvalidParameters>

// Web-search provider label (was @/tool/websearch, retired with the cluster).
function webSearchProviderLabel(provider: unknown) {
  if (provider === "parallel") return "Parallel Web Search"
  if (provider === "exa") return "Exa Web Search"
  return "Web Search"
}

export type ToolView = {
  output: boolean
  final: boolean
  snap?: "code" | "diff" | "structured"
}

export type ToolPhase = "start" | "progress" | "final"

export type ToolDict = Record<string, unknown>

export type ToolFrame = {
  raw: string
  name: string
  input: ToolDict
  meta: ToolDict
  state: ToolDict
  status: string
  error: string
}

export type ToolInline = {
  icon: string
  title: string
  description?: string
  mode?: "inline" | "block"
  body?: string
}

export type ToolPermissionInfo = {
  icon: string
  title: string
  lines: string[]
  diff?: string
  file?: string
}

export type ToolProps<T = Tool.Info> = {
  input: Partial<Tool.InferParameters<T>>
  metadata: Partial<Tool.InferMetadata<T>>
  frame: ToolFrame
}

type ToolPermissionProps<T = Tool.Info> = {
  input: Partial<Tool.InferParameters<T>>
  metadata: Partial<Tool.InferMetadata<T>>
  patterns: string[]
}

type ToolPermissionCtx = {
  input: ToolDict
  meta: ToolDict
  patterns: string[]
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

type ToolRule<T = Tool.Info> = {
  view: ToolView
  run: (props: ToolProps<T>) => ToolInline
  scroll?: Partial<Record<ToolPhase, (props: ToolProps<T>) => string>>
  permission?: (props: ToolPermissionProps<T>) => ToolPermissionInfo
  snap?: (props: ToolProps<T>) => ToolSnapshot | undefined
}

type ToolRegistry = {
  [K in ToolName]: ToolRule<ToolDefs[K]>
}

type AnyToolRule = ToolRule

function dict(v: unknown): ToolDict {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    return {}
  }

  return { ...v }
}

function props<T = Tool.Info>(frame: ToolFrame): ToolProps<T> {
  return {
    input: Object.assign(Object.create(null), frame.input),
    metadata: Object.assign(Object.create(null), frame.meta),
    frame,
  }
}

function permission<T = Tool.Info>(ctx: ToolPermissionCtx): ToolPermissionProps<T> {
  return {
    input: Object.assign(Object.create(null), ctx.input),
    metadata: Object.assign(Object.create(null), ctx.meta),
    patterns: ctx.patterns,
  }
}

function text(v: unknown): string {
  return typeof v === "string" ? v : ""
}

function num(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return undefined
  }

  return v
}

function list<T>(v: unknown): T[] {
  if (!Array.isArray(v)) {
    return []
  }

  return v
}

function info(data: ToolDict, skip: string[] = []): string {
  const list = Object.entries(data).filter(([key, val]) => {
    if (skip.includes(key)) {
      return false
    }

    return typeof val === "string" || typeof val === "number" || typeof val === "boolean"
  })

  if (list.length === 0) {
    return ""
  }

  return `[${list.map(([key, val]) => `${key}=${String(val)}`).join(", ")}]`
}

function span(state: ToolDict): string {
  const time = dict(state.time)
  const start = num(time.start)
  const end = num(time.end)
  if (start === undefined || end === undefined || end <= start) {
    return ""
  }

  return Locale.duration(end - start)
}

function fail(ctx: ToolFrame): string {
  const error = toolError(ctx)
  if (error) {
    return `✖ ${ctx.name} failed: ${error}`
  }

  return `✖ ${ctx.name} failed`
}

function toolError(ctx: ToolFrame): string {
  if (ctx.error) {
    return ctx.error
  }

  const state = text(ctx.state.error).trim()
  if (state) {
    return state
  }

  return ctx.raw.trim()
}

function fallbackStart(ctx: ToolFrame): string {
  const extra = info(ctx.input)
  if (!extra) {
    return `⚙ ${ctx.name}`
  }

  return `⚙ ${ctx.name} ${extra}`
}

function fallbackFinal(ctx: ToolFrame): string {
  if (ctx.status === "error") {
    return fail(ctx)
  }

  if (ctx.status && ctx.status !== "completed") {
    return ctx.raw.trim()
  }

  const time = span(ctx.state)
  if (!time) {
    return `${ctx.name} completed`
  }

  return `${ctx.name} completed · ${time}`
}

export function toolPath(input?: string, opts: { home?: boolean } = {}): string {
  if (!input) {
    return ""
  }

  const cwd = process.cwd()
  const home = os.homedir()
  const abs = path.isAbsolute(input) ? input : path.resolve(cwd, input)
  const rel = path.relative(cwd, abs)

  if (!rel) {
    return "."
  }

  if (!rel.startsWith("..")) {
    return rel.replaceAll("\\", "/")
  }

  if (opts.home && home && (abs === home || abs.startsWith(home + path.sep))) {
    return abs.replace(home, "~").replaceAll("\\", "/")
  }

  return abs.replaceAll("\\", "/")
}

function fallbackInline(ctx: ToolFrame): ToolInline {
  const title = text(ctx.state.title) || (Object.keys(ctx.input).length > 0 ? JSON.stringify(ctx.input) : "Unknown")

  return {
    icon: "⚙",
    title: `${ctx.name} ${title}`,
  }
}

function count(n: number, label: string): string {
  return `${n} ${label}${n === 1 ? "" : "es"}`
}

function runGlob(p: ToolProps<GlobToolInfo>): ToolInline {
  const root = p.input.path ?? ""
  const title = `Glob "${p.input.pattern ?? ""}"`
  const suffix = root ? `in ${toolPath(root)}` : ""
  const matches = p.metadata.count
  const description = matches === undefined ? suffix : `${suffix}${suffix ? " · " : ""}${count(matches, "match")}`
  return {
    icon: "✱",
    title,
    ...(description && { description }),
  }
}

function runGrep(p: ToolProps<GrepToolInfo>): ToolInline {
  const root = p.input.path ?? ""
  const title = `Grep "${p.input.pattern ?? ""}"`
  const suffix = root ? `in ${toolPath(root)}` : ""
  const matches = p.metadata.matches
  const description = matches === undefined ? suffix : `${suffix}${suffix ? " · " : ""}${count(matches, "match")}`
  return {
    icon: "✱",
    title,
    ...(description && { description }),
  }
}

function runList(p: ToolProps): ToolInline {
  const dir = text(dict(p.input).path)
  return {
    icon: "→",
    title: dir ? `List ${toolPath(dir)}` : "List",
  }
}

function runRead(p: ToolProps<ReadToolInfo>): ToolInline {
  const file = toolPath(p.input.filePath)
  const description = info(p.frame.input, ["filePath"]) || undefined
  return {
    icon: "→",
    title: `Read ${file}`,
    ...(description && { description }),
  }
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
  return {
    icon: "%",
    title: url ? `WebFetch ${url}` : "WebFetch",
  }
}

function runEdit(p: ToolProps<EditToolInfo>): ToolInline {
  return {
    icon: "←",
    title: `Edit ${toolPath(p.input.filePath)}`,
    mode: "block",
    body: p.metadata.diff,
  }
}

function runWebSearch(p: ToolProps<WebSearchToolInfo>): ToolInline {
  const title = webSearchProviderLabel(p.metadata.provider)
  return {
    icon: "◈",
    title: p.input.query ? `${title} "${p.input.query}"` : title,
  }
}

function runTask(p: ToolProps<TaskToolInfo>): ToolInline {
  const kind = Locale.titlecase(p.input.subagent_type || "unknown")
  const desc = p.input.description
  const icon = p.frame.status === "error" ? "✗" : p.frame.status === "running" ? "•" : "✓"
  return {
    icon,
    title: desc || `${kind} Task`,
    description: desc ? `${kind} Agent` : undefined,
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
        if (!body) {
          return []
        }

        const mark = item.status === "completed" ? "[✓]" : item.status === "in_progress" ? "[•]" : "[ ]"
        return [`${mark} ${body}`]
      })
      .join("\n"),
  }
}

function runSkill(p: ToolProps<SkillToolInfo>): ToolInline {
  return {
    icon: "→",
    title: `Skill "${p.input.name ?? ""}"`,
  }
}

function runPatch(p: ToolProps<ApplyPatchToolInfo>): ToolInline {
  const files = p.metadata.files?.length ?? 0
  if (files === 0) {
    return {
      icon: "%",
      title: "Patch",
    }
  }

  return {
    icon: "%",
    title: `Patch ${files} file${files === 1 ? "" : "s"}`,
  }
}

function runQuestion(p: ToolProps<QuestionToolInfo>): ToolInline {
  const total = list(p.frame.input.questions).length
  return {
    icon: "→",
    title: `Asked ${total} question${total === 1 ? "" : "s"}`,
  }
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

type PatchFile = Tool.InferMetadata<ApplyPatchToolInfo>["files"][number]

function patchTitle(file: PatchFile): string {
  const rel = file.relativePath
  const from = file.filePath
  if (file.type === "add") {
    return `# Created ${rel || toolPath(from)}`
  }
  if (file.type === "delete") {
    return `# Deleted ${rel || toolPath(from)}`
  }
  if (file.type === "move") {
    return `# Moved ${toolPath(from)} -> ${rel || toolPath(file.movePath)}`
  }

  return `# Patched ${rel || toolPath(from)}`
}

function snapWrite(p: ToolProps<WriteToolInfo>): ToolSnapshot | undefined {
  const file = p.input.filePath || ""
  const content = p.input.content || ""
  if (!file && !content) {
    return undefined
  }

  return {
    kind: "code",
    title: `# Wrote ${toolPath(file)}`,
    content,
    file,
  }
}

function snapEdit(p: ToolProps<EditToolInfo>): ToolSnapshot | undefined {
  const file = p.input.filePath || ""
  const diff = p.metadata.diff || ""
  if (!file || !diff.trim()) {
    return undefined
  }

  return {
    kind: "diff",
    items: [
      {
        title: `# Edited ${toolPath(file)}`,
        diff,
        file,
      },
    ],
  }
}

function snapPatch(p: ToolProps<ApplyPatchToolInfo>): ToolSnapshot | undefined {
  const files = list<PatchFile>(p.frame.meta.files)
  if (files.length === 0) {
    return undefined
  }

  const items = files.flatMap((file) => {
    if (!file || typeof file !== "object") {
      return []
    }

    const diff = typeof file.patch === "string" ? file.patch : ""
    if (!diff.trim()) {
      return []
    }

    const name = file.movePath || file.filePath || file.relativePath
    return [
      {
        title: patchTitle(file),
        diff,
        file: name,
        deletions: typeof file.deletions === "number" ? file.deletions : 0,
      },
    ]
  })

  if (items.length === 0) {
    return undefined
  }

  return {
    kind: "diff",
    items,
  }
}

function snapTask(p: ToolProps<TaskToolInfo>): ToolSnapshot {
  const kind = Locale.titlecase(p.input.subagent_type || "general")
  const desc = p.input.description
  const title = text(p.frame.state.title)
  const rows = [desc || title].filter((item): item is string => Boolean(item))

  return {
    kind: "task",
    title: `# ${kind} Task`,
    rows,
    tail: "",
  }
}

function snapTodo(p: ToolProps<TodoWriteToolInfo>): ToolSnapshot {
  const items = list<{ status?: string; content?: string }>(p.frame.input.todos).flatMap((item) => {
    const content = typeof item?.content === "string" ? item.content : ""
    if (!content) {
      return []
    }

    return [
      {
        status: typeof item.status === "string" ? item.status : "",
        content,
      },
    ]
  })

  return {
    kind: "todo",
    items,
    tail: "",
  }
}

function snapQuestion(p: ToolProps<QuestionToolInfo>): ToolSnapshot {
  const answers = list<unknown[]>(p.frame.meta.answers)
  const items = list<{ question?: string }>(p.frame.input.questions).map((item, i) => {
    const answer = list<string>(answers[i]).filter((entry) => typeof entry === "string")
    return {
      question: item.question || `Question ${i + 1}`,
      answer: answer.length > 0 ? answer.join(", ") : "(no answer)",
    }
  })

  return {
    kind: "question",
    items,
    tail: "",
  }
}

function scrollBashStart(p: ToolProps<BashToolInfo>): string {
  const cmd = p.input.command ?? ""
  const wd = p.input.workdir ?? ""
  const formatted = wd && wd !== "." ? toolPath(wd) : ""
  const dir = formatted === "." ? "" : formatted
  if (cmd && !dir) {
    return `$ ${cmd}`
  }

  if (!cmd) {
    return dir ? `# Running in ${dir}` : ""
  }

  return `# Running in ${dir}\n$ ${cmd}`
}

function scrollBashProgress(p: ToolProps<BashToolInfo>): string {
  const out = stripAnsi(p.frame.raw)
  const cmd = (p.input.command ?? "").trim()
  const fmt = (text: string) => {
    const body = text.replace(/^\n+/, "").replace(/\n+$/, "")
    return body ? `\n${body}` : ""
  }

  if (!cmd) {
    return out.replace(/\n+$/, "")
  }

  const wdRaw = (p.input.workdir ?? "").trim()
  const wd = wdRaw ? toolPath(wdRaw) : ""
  const lines = out.split("\n")
  const first = (lines[0] || "").trim()
  const second = (lines[1] || "").trim()

  if (wd && (first === wd || first === wdRaw) && second === cmd) {
    return fmt(lines.slice(2).join("\n"))
  }

  if (first === cmd || first === `$ ${cmd}`) {
    return fmt(lines.slice(1).join("\n"))
  }

  if (wd && (first === `${wd} ${cmd}` || first === `${wdRaw} ${cmd}`)) {
    return fmt(lines.slice(1).join("\n"))
  }

  return fmt(out)
}

function scrollBashFinal(p: ToolProps<BashToolInfo>): string {
  const code = p.metadata.exit ?? num(p.frame.meta.exitCode) ?? num(p.frame.meta.exit_code)
  const time = span(p.frame.state)
  if (code === undefined) {
    if (!time) {
      return "bash completed"
    }

    return `bash completed · ${time}`
  }

  return `bash completed (exit ${code})${time ? ` · ${time}` : ""}`
}

function scrollReadStart(p: ToolProps<ReadToolInfo>): string {
  const file = toolPath(p.input.filePath)
  const extra = info(p.frame.input, ["filePath"])
  const tail = extra ? ` ${extra}` : ""
  return `→ Read ${file}${tail}`.trim()
}

function scrollWriteStart(_: ToolProps<WriteToolInfo>): string {
  return ""
}

function scrollEditStart(_: ToolProps<EditToolInfo>): string {
  return ""
}

function scrollPatchStart(_: ToolProps<ApplyPatchToolInfo>): string {
  return ""
}

function patchLine(file: PatchFile): string {
  const type = file.type
  const rel = file.relativePath
  const from = file.filePath

  if (type === "add") {
    return `+ Created ${rel || toolPath(from)}`
  }

  if (type === "delete") {
    return `- Deleted ${rel || toolPath(from)}`
  }

  if (type === "move") {
    return `→ Moved ${toolPath(from)} → ${rel || toolPath(file.movePath)}`
  }

  return `~ Patched ${rel || toolPath(from)}`
}

function scrollPatchFinal(p: ToolProps<ApplyPatchToolInfo>): string {
  if (p.frame.status === "error") {
    return fail(p.frame)
  }

  const files = list<PatchFile>(p.frame.meta.files)
  if (files.length === 0) {
    const time = span(p.frame.state)
    if (!time) {
      return "patch"
    }

    return `patch · ${time}`
  }

  const show_updates = !files.some((file) => file?.type && file.type !== "update")
  const shown = files.filter((file) => show_updates || file.type !== "update")
  const rows = shown.slice(0, 6).map(patchLine)
  if (shown.length > 6) {
    rows.push(`... and ${shown.length - 6} more`)
  }

  if (rows.length > 0) {
    return rows.join("\n")
  }

  return patchLine(files[0]!)
}

function scrollTaskStart(_: ToolProps<TaskToolInfo>): string {
  return ""
}

function taskResult(output: string): string | undefined {
  if (!output.trim()) {
    return undefined
  }

  const match = output.match(/<task_result>\s*([\s\S]*?)\s*<\/task_result>/)
  if (match) {
    return match[1].trim() || undefined
  }

  const next = output
    .split("\n")
    .filter((line) => !line.startsWith("task_id:"))
    .join("\n")
    .trim()
  return next || undefined
}

function scrollTaskFinal(p: ToolProps<TaskToolInfo>): string {
  if (p.frame.status === "error") {
    return fail(p.frame)
  }

  const kind = Locale.titlecase(p.input.subagent_type || "general")
  const row = p.input.description || text(p.frame.state.title)
  if (!row) {
    return `# ${kind} Task`
  }

  return `# ${kind} Task\n${row}`
}

function scrollTodoStart(_: ToolProps<TodoWriteToolInfo>): string {
  return ""
}

function scrollTodoFinal(p: ToolProps<TodoWriteToolInfo>): string {
  const items = list<{ status?: string }>(p.input.todos)
  const time = span(p.frame.state)
  if (items.length === 0) {
    if (!time) {
      return "0 todos"
    }

    return `0 todos · ${time}`
  }

  const doneN = items.filter((item) => item.status === "completed").length
  const runN = items.filter((item) => item.status === "in_progress").length
  const left = items.length - doneN - runN
  const tail = [`${items.length} total`]
  if (doneN > 0) {
    tail.push(`${doneN} done`)
  }
  if (runN > 0) {
    tail.push(`${runN} active`)
  }
  if (left > 0) {
    tail.push(`${left} pending`)
  }

  if (time) {
    tail.push(time)
  }

  return tail.join(" · ")
}

function scrollQuestionStart(_: ToolProps<QuestionToolInfo>): string {
  return ""
}

function scrollQuestionFinal(p: ToolProps<QuestionToolInfo>): string {
  const q = p.input.questions ?? []
  const a = p.metadata.answers ?? []
  const time = span(p.frame.state)
  if (q.length === 0) {
    if (!time) {
      return "0 questions"
    }

    return `0 questions · ${time}`
  }

  const rows: string[] = []
  for (const [i, item] of q.slice(0, 4).entries()) {
    const prompt = item.question
    const reply = a[i] ?? []
    rows.push(`? ${prompt || `Question ${i + 1}`}`)
    rows.push(`  ${reply.length > 0 ? reply.join(", ") : "(no answer)"}`)
  }

  if (q.length > 4) {
    rows.push(`... and ${q.length - 4} more`)
  }

  return rows.join("\n")
}

function scrollSkillStart(p: ToolProps<SkillToolInfo>): string {
  return `→ Skill "${p.input.name ?? ""}"`
}

function scrollGlobStart(p: ToolProps<GlobToolInfo>): string {
  const pattern = p.input.pattern ?? ""
  const head = pattern ? `✱ Glob "${pattern}"` : "✱ Glob"
  const dir = p.input.path ?? ""
  if (!dir) {
    return head
  }

  return `${head} in ${toolPath(dir)}`
}

function scrollGlobFinal(p: ToolProps<GlobToolInfo>): string {
  return toolError(p.frame) || fail(p.frame)
}

function scrollGrepStart(p: ToolProps<GrepToolInfo>): string {
  const pattern = p.input.pattern ?? ""
  const head = pattern ? `✱ Grep "${pattern}"` : "✱ Grep"
  const dir = p.input.path ?? ""
  if (!dir) {
    return head
  }

  return `${head} in ${toolPath(dir)}`
}

function scrollListStart(p: ToolProps): string {
  const dir = text(dict(p.input).path)
  if (!dir) {
    return "→ List"
  }

  return `→ List ${toolPath(dir)}`
}

function scrollWebfetchStart(p: ToolProps<WebFetchToolInfo>): string {
  const url = p.input.url ?? ""
  if (!url) {
    return "% WebFetch"
  }

  return `% WebFetch ${url}`
}

function scrollWebSearchStart(p: ToolProps<WebSearchToolInfo>): string {
  const title = webSearchProviderLabel(p.metadata.provider)
  const query = p.input.query ?? ""
  if (!query) {
    return `◈ ${title}`
  }

  return `◈ ${title} "${query}"`
}

function permEdit(p: ToolPermissionProps<EditToolInfo>): ToolPermissionInfo {
  const input = p.input as { filePath?: string; filepath?: string; diff?: string }
  const file = input.filePath || input.filepath || p.patterns[0] || ""
  return {
    icon: "→",
    title: `Edit ${toolPath(file, { home: true })}`,
    lines: [],
    diff: p.metadata.diff ?? input.diff,
    file,
  }
}

function permRead(p: ToolPermissionProps<ReadToolInfo>): ToolPermissionInfo {
  const file = p.input.filePath || p.patterns[0] || ""
  return {
    icon: "→",
    title: `Read ${toolPath(file, { home: true })}`,
    lines: file ? [`Path: ${toolPath(file, { home: true })}`] : [],
  }
}

function permGlob(p: ToolPermissionProps<GlobToolInfo>): ToolPermissionInfo {
  const pattern = p.input.pattern || p.patterns[0] || ""
  return {
    icon: "✱",
    title: `Glob "${pattern}"`,
    lines: pattern ? [`Pattern: ${pattern}`] : [],
  }
}

function permGrep(p: ToolPermissionProps<GrepToolInfo>): ToolPermissionInfo {
  const pattern = p.input.pattern || p.patterns[0] || ""
  return {
    icon: "✱",
    title: `Grep "${pattern}"`,
    lines: pattern ? [`Pattern: ${pattern}`] : [],
  }
}

function permList(p: ToolPermissionProps): ToolPermissionInfo {
  const dir = text(dict(p.input).path) || p.patterns[0] || ""
  return {
    icon: "→",
    title: `List ${toolPath(dir, { home: true })}`,
    lines: dir ? [`Path: ${toolPath(dir, { home: true })}`] : [],
  }
}

function permBash(p: ToolPermissionProps<BashToolInfo>): ToolPermissionInfo {
  const cmd = p.input.command || ""
  return {
    icon: "#",
    title: "Shell command",
    lines: cmd ? [`$ ${cmd}`] : p.patterns.map((item) => `- ${item}`),
  }
}

function permTask(p: ToolPermissionProps<TaskToolInfo>): ToolPermissionInfo {
  const type = p.input.subagent_type || "general"
  const desc = p.input.description
  return {
    icon: "#",
    title: `${Locale.titlecase(type)} Task`,
    lines: desc ? [`◉ ${desc}`] : [],
  }
}

function permWebfetch(p: ToolPermissionProps<WebFetchToolInfo>): ToolPermissionInfo {
  const url = p.input.url || ""
  return {
    icon: "%",
    title: `WebFetch ${url}`,
    lines: url ? [`URL: ${url}`] : [],
  }
}

function permWebSearch(p: ToolPermissionProps<WebSearchToolInfo>): ToolPermissionInfo {
  const query = p.input.query || ""
  const title = webSearchProviderLabel(p.metadata.provider)
  return {
    icon: "◈",
    title: query ? `${title} "${query}"` : title,
    lines: query ? [`Query: ${query}`] : [],
  }
}

const TOOL_RULES = {
  invalid: {
    view: {
      output: true,
      final: false,
    },
    run: runInvalid,
    scroll: {
      start: () => "",
    },
  },
  bash: {
    view: {
      output: true,
      final: false,
    },
    run: runBash,
    scroll: {
      start: scrollBashStart,
      progress: scrollBashProgress,
      final: scrollBashFinal,
    },
    permission: permBash,
  },
  write: {
    view: {
      output: false,
      final: true,
      snap: "code",
    },
    run: runWrite,
    snap: snapWrite,
    scroll: {
      start: scrollWriteStart,
    },
  },
  edit: {
    view: {
      output: false,
      final: true,
      snap: "diff",
    },
    run: runEdit,
    snap: snapEdit,
    scroll: {
      start: scrollEditStart,
    },
    permission: permEdit,
  },
  apply_patch: {
    view: {
      output: false,
      final: true,
      snap: "diff",
    },
    run: runPatch,
    snap: snapPatch,
    scroll: {
      start: scrollPatchStart,
      final: scrollPatchFinal,
    },
  },
  batch: {
    view: {
      output: true,
      final: false,
    },
    run: runBatch,
    scroll: {
      start: () => "",
    },
  },
  task: {
    view: {
      output: false,
      final: true,
      snap: "structured",
    },
    run: runTask,
    snap: snapTask,
    scroll: {
      start: scrollTaskStart,
      final: scrollTaskFinal,
    },
    permission: permTask,
  },
  todowrite: {
    view: {
      output: false,
      final: true,
      snap: "structured",
    },
    run: runTodo,
    snap: snapTodo,
    scroll: {
      start: scrollTodoStart,
      final: scrollTodoFinal,
    },
  },
  question: {
    view: {
      output: false,
      final: true,
      snap: "structured",
    },
    run: runQuestion,
    snap: snapQuestion,
    scroll: {
      start: scrollQuestionStart,
      final: scrollQuestionFinal,
    },
  },
  read: {
    view: {
      output: false,
      final: false,
    },
    run: runRead,
    scroll: {
      start: scrollReadStart,
    },
    permission: permRead,
  },
  glob: {
    view: {
      output: false,
      final: false,
    },
    run: runGlob,
    scroll: {
      start: scrollGlobStart,
      final: scrollGlobFinal,
    },
    permission: permGlob,
  },
  grep: {
    view: {
      output: false,
      final: false,
    },
    run: runGrep,
    scroll: {
      start: scrollGrepStart,
    },
    permission: permGrep,
  },
  list: {
    view: {
      output: false,
      final: false,
    },
    run: runList,
    scroll: {
      start: scrollListStart,
    },
    permission: permList,
  },
  webfetch: {
    view: {
      output: false,
      final: false,
    },
    run: runWebfetch,
    scroll: {
      start: scrollWebfetchStart,
    },
    permission: permWebfetch,
  },
  websearch: {
    view: {
      output: false,
      final: false,
    },
    run: runWebSearch,
    scroll: {
      start: scrollWebSearchStart,
    },
    permission: permWebSearch,
  },
  skill: {
    view: {
      output: false,
      final: false,
    },
    run: runSkill,
    scroll: {
      start: scrollSkillStart,
    },
  },
  plan_exit: {
    view: {
      output: true,
      final: false,
    },
    run: runPlanExit,
    scroll: {
      start: () => "",
    },
  },
} as const satisfies ToolRegistry

function key(name: string): name is ToolName {
  return Object.prototype.hasOwnProperty.call(TOOL_RULES, name)
}

function rule(name?: string): AnyToolRule | undefined {
  if (!name || !key(name)) {
    return undefined
  }

  return TOOL_RULES[name]
}

function frame(part: ToolPart): ToolFrame {
  const state = dict(part.state)
  return {
    raw: "",
    name: part.tool,
    input: dict(state.input),
    meta: "metadata" in part.state ? dict(part.state.metadata) : {},
    state,
    status: text(state.status),
    error: text(state.error),
  }
}

export function toolFrame(commit: StreamCommit, raw: string): ToolFrame {
  const state = dict(commit.part?.state)
  return {
    raw,
    name: commit.tool || commit.part?.tool || "tool",
    input: dict(state.input),
    meta: commit.part?.state && "metadata" in commit.part.state ? dict(commit.part.state.metadata) : {},
    state,
    status: commit.toolState ?? text(state.status),
    error: (commit.toolError ?? "").trim(),
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

export function toolView(name?: string): ToolView {
  return (
    rule(name)?.view ?? {
      output: true,
      final: true,
    }
  )
}

export function toolStructuredFinal(commit: StreamCommit): boolean {
  const state = commit.toolState ?? commit.part?.state.status
  return (
    commit.kind === "tool" &&
    commit.phase === "final" &&
    state === "completed" &&
    Boolean(toolView(commit.tool ?? commit.part?.tool).snap)
  )
}

export function toolInlineInfo(part: ToolPart): ToolInline {
  const ctx = frame(part)
  const draw = rule(ctx.name)?.run
  try {
    if (draw) {
      return draw(props(ctx))
    }
  } catch {
    return fallbackInline(ctx)
  }

  return fallbackInline(ctx)
}

export function toolScroll(phase: ToolPhase, ctx: ToolFrame): string {
  const draw = rule(ctx.name)?.scroll?.[phase]
  try {
    if (draw) {
      return draw(props(ctx))
    }
  } catch {
    if (phase === "start") {
      return fallbackStart(ctx)
    }
    if (phase === "progress") {
      return ctx.raw
    }
    return fallbackFinal(ctx)
  }

  if (phase === "start") {
    return fallbackStart(ctx)
  }

  if (phase === "progress") {
    return ctx.raw
  }

  return fallbackFinal(ctx)
}

export function toolPermissionInfo(
  name: string,
  input: ToolDict,
  meta: ToolDict,
  patterns: string[],
): ToolPermissionInfo | undefined {
  const draw = rule(name)?.permission
  if (!draw) {
    return undefined
  }

  try {
    return draw(permission({ input, meta, patterns }))
  } catch {
    return undefined
  }
}

export function toolSnapshot(commit: StreamCommit, raw: string): ToolSnapshot | undefined {
  const ctx = toolFrame(commit, raw)
  const draw = rule(ctx.name)?.snap
  if (!draw) {
    return undefined
  }

  try {
    return draw(props(ctx))
  } catch {
    return undefined
  }
}

function textBody(content: string): RunEntryBody | undefined {
  if (!content) {
    return undefined
  }

  return {
    type: "text",
    content,
  }
}

function markdownBody(content: string): RunEntryBody | undefined {
  if (!content) {
    return undefined
  }

  return {
    type: "markdown",
    content,
  }
}

function structuredBody(commit: StreamCommit, raw: string): RunEntryBody | undefined {
  const snap = toolSnapshot(commit, raw)
  if (!snap) {
    return undefined
  }

  return {
    type: "structured",
    snapshot: snap,
  }
}

function shellOutput(command: string, raw: string): string | undefined {
  const body = stripAnsi(raw).replace(/^\n+/, "").replace(/\n+$/, "")
  if (!body) {
    return undefined
  }

  if (!command) {
    return body
  }

  return `\n${body}`
}

export function toolEntryBody(commit: StreamCommit, raw: string): RunEntryBody | undefined {
  if (commit.shell) {
    if (commit.phase === "start") {
      return textBody(`$ ${commit.shell.command}`)
    }

    if (commit.phase === "progress") {
      return textBody(shellOutput(commit.shell.command, raw) ?? "")
    }

    return undefined
  }

  const ctx = toolFrame(commit, raw)
  const view = toolView(ctx.name)

  if (ctx.name === "task") {
    if (commit.phase === "start") {
      return undefined
    }

    if (commit.phase === "final" && ctx.status === "completed") {
      const result = taskResult(text(ctx.state.output))
      if (result) {
        return markdownBody(result)
      }
    }
  }

  if (commit.phase === "progress" && !view.output) {
    return undefined
  }

  if (commit.phase === "final") {
    if (ctx.status === "error") {
      return textBody(toolScroll("final", ctx))
    }

    if (!view.final) {
      return undefined
    }

    if (ctx.status && ctx.status !== "completed") {
      return textBody(ctx.raw.trim())
    }

    if (toolStructuredFinal(commit)) {
      return structuredBody(commit, raw) ?? textBody(toolScroll("final", ctx))
    }
  }

  return textBody(toolScroll(commit.phase, ctx))
}

export function toolFiletype(input?: string): string | undefined {
  if (!input) {
    return undefined
  }

  const ext = path.extname(input)
  const lang = LANGUAGE_EXTENSIONS[ext]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(lang)) {
    return "typescript"
  }

  return lang
}
