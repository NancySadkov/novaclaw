import { createMemo, For, Show, Switch, Match } from "solid-js"
import type {
  LlmToolContent,
  ModelRef,
  SessionMessage,
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  SessionMessageCompaction,
  SessionMessageShell,
  SessionMessageSynthetic,
  SessionMessageSystem,
  SessionMessageUser,
} from "@novaclaw/sdk/v2"
import { Markdown } from "../../components/markdown"
import { BasicToolV2 } from "./basic-tool-v2"
import { ToolErrorCardV2 } from "./tool-error-card-v2"
import "./native-transcript.css"

/**
 * F1e S4-v3 — native `SessionMessage[]` transcript renderer (strategy B).
 *
 * A parallel render path that consumes the flat native `SessionMessage` union
 * (`@novaclaw/sdk/v2`) directly — the end-state that retires the V1
 * `Message`/`Part` shape (`session-turn.tsx` + `message-part.tsx`). It renders from
 * the native store (`createNativeMessageStore`, fed by the S1–S3 fold) instead of the
 * V1 `Data` context, so no `parentID` grouping or separate `part` map: the list is
 * already ordered oldest-first and every assistant carries its `content[]` inline.
 *
 * Mounted behind a DEV-only toggle for A/B verification against the V1 timeline (see
 * the app `NativeTimeline` wrapper); it does NOT touch the V1 path. Tool cards are a
 * first cut (name · status · collapsible input/output) — full per-tool fidelity
 * (diffs, file previews, todo, question) lands in later S4-v3 increments.
 */
const isSwitchMarker = (m: SessionMessage) => m.type === "agent-switched" || m.type === "model-switched"

export function NativeTranscript(props: { messages: readonly SessionMessage[]; class?: string }) {
  // The native store captures the session's initial agent/model as `*-switched` messages,
  // but those are setup state (V1 shows them in the header, not the transcript). Drop the
  // LEADING run of switch markers; a switch that lands mid-conversation still renders as a
  // divider, which is the informative case.
  const visible = createMemo(() => {
    const messages = props.messages
    const firstReal = messages.findIndex((m) => !isSwitchMarker(m))
    if (firstReal <= 0) return messages as SessionMessage[]
    return (messages as SessionMessage[]).filter((m, i) => i >= firstReal || !isSwitchMarker(m))
  })
  return (
    <div data-component="native-transcript" class={props.class}>
      <For each={visible()}>{(message) => <NativeMessage message={message} />}</For>
    </div>
  )
}

function NativeMessage(props: { message: SessionMessage }) {
  return (
    <Switch>
      <Match when={props.message.type === "user" && props.message}>{(m) => <UserMessage message={m()} />}</Match>
      <Match when={props.message.type === "assistant" && props.message}>
        {(m) => <AssistantMessage message={m()} />}
      </Match>
      <Match when={props.message.type === "shell" && props.message}>{(m) => <ShellMessage message={m()} />}</Match>
      <Match when={props.message.type === "system" && props.message}>
        {(m) => <NoticeMessage kind="system" text={m().text} />}
      </Match>
      <Match when={props.message.type === "synthetic" && props.message}>
        {(m) => <NoticeMessage kind="synthetic" text={(m() as SessionMessageSynthetic).text} />}
      </Match>
      <Match when={props.message.type === "compaction" && props.message}>
        {(m) => <CompactionMessage message={m()} />}
      </Match>
      <Match when={props.message.type === "agent-switched" && props.message}>
        {(m) => <SwitchMarker label={`Switched to agent ${(m() as { agent: string }).agent}`} />}
      </Match>
      <Match when={props.message.type === "model-switched" && props.message}>
        {(m) => <SwitchMarker label={`Switched model to ${formatModel((m() as { model: ModelRef }).model)}`} />}
      </Match>
    </Switch>
  )
}

// ── user ───────────────────────────────────────────────────────────────────────

function UserMessage(props: { message: SessionMessageUser }) {
  return (
    <div data-slot="native-user">
      <div data-slot="native-user-bubble">
        <Show when={props.message.text.trim()}>
          <Markdown text={props.message.text} />
        </Show>
        <Show when={props.message.files?.length || props.message.agents?.length}>
          <div data-slot="native-user-attachments">
            <For each={props.message.files ?? []}>
              {(file) => <span data-slot="native-chip">{file.name ?? file.mime ?? "file"}</span>}
            </For>
            <For each={props.message.agents ?? []}>
              {(agent) => <span data-slot="native-chip">@{agent.name}</span>}
            </For>
          </div>
        </Show>
      </div>
    </div>
  )
}

// ── assistant ────────────────────────────────────────────────────────────────────

function AssistantMessage(props: { message: SessionMessageAssistant }) {
  return (
    <div data-slot="native-assistant">
      <For each={props.message.content}>
        {(part) => (
          <Switch>
            <Match when={part.type === "text" && part}>
              {(p) => (
                <Show when={p().text.trim()}>
                  <div data-slot="native-assistant-text">
                    <Markdown text={p().text} streaming={!props.message.time.completed} />
                  </div>
                </Show>
              )}
            </Match>
            <Match when={part.type === "reasoning" && part}>
              {(p) => (
                <Show when={p().text.trim()}>
                  <details data-slot="native-reasoning">
                    <summary>Reasoning</summary>
                    <div data-slot="native-reasoning-body">
                      <Markdown text={p().text} />
                    </div>
                  </details>
                </Show>
              )}
            </Match>
            <Match when={part.type === "tool" && part}>{(p) => <ToolPart part={p()} />}</Match>
          </Switch>
        )}
      </For>
      <Show when={props.message.snapshot?.files?.length}>
        <ChangedFilesStrip files={props.message.snapshot!.files!} />
      </Show>
      <Show when={props.message.error}>
        {(err) => (
          <Show
            when={!isInterrupted(err().message)}
            fallback={
              <div data-slot="native-interrupted-divider">
                <span>Interrupted</span>
              </div>
            }
          >
            <div data-slot="native-error" role="alert">
              {err().message}
            </div>
          </Show>
        )}
      </Show>
    </div>
  )
}

/** Turn-level summary of the files this assistant step touched (`snapshot.files`). */
function ChangedFilesStrip(props: { files: readonly string[] }) {
  return (
    <div data-slot="native-changed-files">
      <div data-slot="native-changed-files-head">
        {props.files.length} file{props.files.length > 1 ? "s" : ""} changed
      </div>
      <div data-slot="native-changed-files-list">
        <For each={props.files as string[]}>
          {(file) => (
            <span data-slot="native-changed-file" title={file}>
              {file}
            </span>
          )}
        </For>
      </div>
    </div>
  )
}

function ToolPart(props: { part: SessionMessageAssistantTool }) {
  const meta = () => toolMeta(props.part)
  return (
    <Switch>
      <Match when={props.part.name === "todowrite"}>
        <TodoTool part={props.part} />
      </Match>
      <Match when={props.part.name === "question"}>
        <QuestionTool part={props.part} />
      </Match>
      <Match when={props.part.state.status === "error" && props.part.state}>
        {(state) => (
          <ToolErrorCardV2
            data-slot="native-tool"
            title={meta().title}
            subtitle={state().error.message}
            suffix={<ToolBody part={props.part} />}
          />
        )}
      </Match>
      <Match when={true}>
        <BasicToolV2
          data-slot="native-tool"
          status={props.part.state.status}
          trigger={{
            title: meta().title,
            subtitle: meta().subtitle,
            args: meta().args,
            changes: meta().changes,
          }}
        >
          <ToolBody part={props.part} />
        </BasicToolV2>
      </Match>
    </Switch>
  )
}

/** `todowrite` → an inline checklist (the one tool whose payload reads best expanded). */
function TodoTool(props: { part: SessionMessageAssistantTool }) {
  const todos = () => {
    const raw = toolInput(props.part.state).todos ?? structuredTodos(props.part.state)
    return Array.isArray(raw) ? (raw as Array<{ content?: string; status?: string }>) : []
  }
  const done = () => todos().filter((t) => t.status === "completed").length
  return (
    <BasicToolV2
      data-slot="native-tool"
      status={props.part.state.status}
      defaultOpen
      trigger={{ title: "Todos", subtitle: todos().length ? `${done()}/${todos().length}` : undefined }}
    >
      <ul data-slot="native-todos">
        <For each={todos()}>
          {(todo) => (
            <li data-slot="native-todo" data-status={todo.status ?? "pending"}>
              <span data-slot="native-todo-mark" aria-hidden="true">
                {todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "◐" : "○"}
              </span>
              <span data-slot="native-todo-content">{todo.content}</span>
            </li>
          )}
        </For>
      </ul>
    </BasicToolV2>
  )
}

/**
 * `question` → the ask-card. The interactive ask lives in a dialog (S6), so the
 * transcript only shows the resolved outcome: the answered Q&A, or a subtle
 * "dismissed" notice on rejection — pending/running asks are hidden (V1 parity).
 */
function QuestionTool(props: { part: SessionMessageAssistantTool }) {
  const state = () => props.part.state
  const questions = () => {
    const raw = toolInput(state()).questions
    return Array.isArray(raw) ? (raw as Array<{ question?: string }>) : []
  }
  const answers = () => {
    const s = state()
    if (s.status !== "completed") return []
    const raw = (s.structured as { answers?: unknown }).answers
    return Array.isArray(raw) ? (raw as string[][]) : []
  }
  const answered = () => answers().length > 0
  const dismissed = () => state().status === "error" && /dismissed this question/i.test(toolErrorMessage(state()) ?? "")

  return (
    <Switch>
      <Match when={dismissed()}>
        <div data-slot="native-question-dismissed">Questions dismissed</div>
      </Match>
      <Match when={state().status !== "pending" && state().status !== "running"}>
        <BasicToolV2
          data-slot="native-tool"
          status={state().status}
          defaultOpen={answered()}
          trigger={{ title: "Questions", subtitle: questionSubtitle(questions().length, answered()) }}
        >
          <div data-slot="native-question-answers">
            <For each={questions()}>
              {(q, i) => (
                <div data-slot="native-question-item">
                  <div data-slot="native-question-text">{q.question}</div>
                  <div data-slot="native-answer-text">{(answers()[i()] ?? []).join(", ") || "No answer"}</div>
                </div>
              )}
            </For>
          </div>
        </BasicToolV2>
      </Match>
    </Switch>
  )
}

/** Tool-card body: a real unified diff for file edits, else input args + textual output. */
function ToolBody(props: { part: SessionMessageAssistantTool }) {
  const output = () => {
    const state = props.part.state
    if (state.status === "completed" || state.status === "running" || state.status === "error")
      return toolContentText(state.content)
    return ""
  }
  return (
    <div data-slot="native-tool-io">
      <Show
        when={filePatches(props.part.state)}
        fallback={
          <>
            <pre data-slot="native-tool-input">{toolInputText(props.part.state)}</pre>
            <Show when={output()}>
              <pre data-slot="native-tool-output">{output()}</pre>
            </Show>
          </>
        }
      >
        {(patches) => <For each={patches()}>{(patch) => <DiffView patch={patch} />}</For>}
      </Show>
    </div>
  )
}

/** Minimal unified-diff colorizer (add/del/hunk/meta lines) — full syntax highlight is later polish. */
function DiffView(props: { patch: string }) {
  const lines = () => props.patch.split("\n")
  return (
    <pre data-slot="native-tool-diff">
      <For each={lines()}>{(line) => <div data-diff-line={diffLineKind(line)}>{line.length ? line : " "}</div>}</For>
    </pre>
  )
}

// ── shell / notices / compaction / switch markers ───────────────────────────────

function ShellMessage(props: { message: SessionMessageShell }) {
  return (
    <div data-slot="native-shell">
      <div data-slot="native-shell-command">$ {props.message.command}</div>
      <Show when={props.message.output.trim()}>
        <pre data-slot="native-shell-output">{props.message.output}</pre>
      </Show>
    </div>
  )
}

function NoticeMessage(props: { kind: "system" | "synthetic"; text: string }) {
  return (
    <details data-slot="native-notice" data-kind={props.kind}>
      <summary>{props.kind === "synthetic" ? "System note" : "Context"}</summary>
      <div data-slot="native-notice-body">
        <Markdown text={props.text} />
      </div>
    </details>
  )
}

function CompactionMessage(props: { message: SessionMessageCompaction }) {
  return (
    <div data-slot="native-compaction">
      <div data-slot="native-compaction-divider">
        Compacted{props.message.reason === "manual" ? " (manual)" : ""}
      </div>
      <details data-slot="native-notice">
        <summary>Summary</summary>
        <div data-slot="native-notice-body">
          <Markdown text={props.message.summary} />
        </div>
      </details>
    </div>
  )
}

function SwitchMarker(props: { label: string }) {
  return (
    <div data-slot="native-switch-marker">
      <span>{props.label}</span>
    </div>
  )
}

// ── helpers ─────────────────────────────────────────────────────────────────────

function formatModel(model: ModelRef): string {
  return model.variant ? `${model.providerID}/${model.id} · ${model.variant}` : `${model.providerID}/${model.id}`
}

interface ToolMeta {
  title: string
  subtitle?: string
  args?: string[]
  changes?: { additions: number; deletions: number }
}

/** Per-tool label/subtitle/args/changes, ported from the V1 `getToolInfo` switch. */
function toolMeta(part: SessionMessageAssistantTool): ToolMeta {
  const input = toolInput(part.state)
  switch (part.name) {
    case "read": {
      const args: string[] = []
      const offset = num(input.offset)
      const limit = num(input.limit)
      if (offset !== undefined) args.push(`offset ${offset}`)
      if (limit !== undefined) args.push(`limit ${limit}`)
      return { title: "Read", subtitle: basename(input.filePath), args }
    }
    case "list":
      return { title: "List", subtitle: basename(input.path) ?? str(input.path) }
    case "glob":
      return { title: "Find files", subtitle: str(input.pattern) }
    case "grep":
      return { title: "Search", subtitle: str(input.pattern) }
    case "webfetch":
      return { title: "Fetch", subtitle: str(input.url) }
    case "websearch":
      return { title: "Web search", subtitle: str(input.query) }
    case "task":
      return {
        title: str(input.subagent_type) ? cap(str(input.subagent_type)!) : "Task",
        subtitle: str(input.description),
      }
    case "bash":
      return { title: "Shell", subtitle: str(input.command) }
    case "edit":
      return { title: "Edit", subtitle: basename(input.filePath), changes: diffStat(part.state) }
    case "write":
      return { title: "Write", subtitle: basename(input.filePath), changes: diffStat(part.state) }
    case "apply_patch": {
      const files = Array.isArray(input.files) ? input.files.length : undefined
      return {
        title: "Patch",
        subtitle: files ? `${files} file${files > 1 ? "s" : ""}` : undefined,
        changes: diffStat(part.state),
      }
    }
    case "question":
      return { title: "Question" }
    case "skill":
      return { title: str(input.name) ?? "Skill" }
    default:
      return { title: part.name }
  }
}

function toolInput(state: SessionMessageAssistantTool["state"]): Record<string, unknown> {
  return state.status === "pending" ? {} : ((state.input ?? {}) as Record<string, unknown>)
}

function toolErrorMessage(state: SessionMessageAssistantTool["state"]): string | undefined {
  return state.status === "error" ? state.error.message : undefined
}

function questionSubtitle(count: number, answered: boolean): string | undefined {
  if (count === 0) return undefined
  if (answered) return "Answered"
  return `${count} question${count > 1 ? "s" : ""}`
}

/**
 * A turn that was aborted surfaces natively as a plain `{ type:"unknown" }` error whose
 * message the runner sets to "Provider turn interrupted" / "Tool execution interrupted"
 * (the native schema dropped V1's `MessageAbortedError` name), so match on that phrasing
 * to show an "Interrupted" divider rather than a loud error box.
 */
function isInterrupted(message: string | undefined): boolean {
  return typeof message === "string" && /interrupted/i.test(message)
}

/** The `{ file, patch, additions, deletions }[]` a file-mutating tool records in `structured`. */
function structuredFiles(
  state: SessionMessageAssistantTool["state"],
): Array<{ patch?: string; additions?: number; deletions?: number }> | undefined {
  if (state.status !== "completed" && state.status !== "error") return undefined
  const files = (state.structured as { files?: unknown }).files
  return Array.isArray(files) ? (files as Array<{ patch?: string; additions?: number; deletions?: number }>) : undefined
}

function filePatches(state: SessionMessageAssistantTool["state"]): string[] | undefined {
  const patches = structuredFiles(state)
    ?.map((f) => f.patch)
    .filter((p): p is string => typeof p === "string" && p.length > 0)
  return patches && patches.length ? patches : undefined
}

function structuredTodos(state: SessionMessageAssistantTool["state"]): unknown {
  return state.status === "pending" ? undefined : (state.structured as { todos?: unknown }).todos
}

function diffStat(state: SessionMessageAssistantTool["state"]): { additions: number; deletions: number } | undefined {
  const files = structuredFiles(state)
  if (!files?.length) return undefined
  let additions = 0
  let deletions = 0
  for (const f of files) {
    additions += f.additions ?? 0
    deletions += f.deletions ?? 0
  }
  return additions || deletions ? { additions, deletions } : undefined
}

function diffLineKind(line: string): "meta" | "hunk" | "add" | "del" | "ctx" {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("Index:") || line.startsWith("===="))
    return "meta"
  if (line.startsWith("@@")) return "hunk"
  if (line.startsWith("+")) return "add"
  if (line.startsWith("-")) return "del"
  return "ctx"
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length ? v : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined
}

function basename(p: unknown): string | undefined {
  const s = str(p)
  if (!s) return undefined
  const parts = s.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? s
}

function cap(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s
}

function toolContentText(content: readonly LlmToolContent[]): string {
  return content
    .map((item) => (item.type === "text" ? item.text : `[file: ${item.name ?? item.uri}]`))
    .join("\n")
    .trim()
}

function toolInputText(state: SessionMessageAssistantTool["state"]): string {
  if (state.status === "pending") return state.input
  try {
    return JSON.stringify(state.input, null, 2)
  } catch {
    return String(state.input)
  }
}
