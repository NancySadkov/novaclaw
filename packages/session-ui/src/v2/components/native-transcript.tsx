import { createContext, createMemo, createSignal, For, Show, Switch, Match, useContext, type Accessor } from "solid-js"
import type {
  LlmToolContent,
  SessionMessage,
  SessionMessageAssistant,
  SessionMessageAssistantReasoning,
  SessionMessageAssistantTool,
  SessionMessageCompaction,
  SessionMessageShell,
  SessionMessageSynthetic,
  SessionMessageSystem,
  SessionMessageUser,
} from "@novaclaw/sdk/v2"
import { isSteerText, stripSteerProvenance } from "@novaclaw/core/session/steer-provenance"
import { SessionOrigin } from "@novaclaw/core/session/origin"
import { reasoningTokenLabel } from "./reasoning-count"
import { Markdown } from "../../components/markdown"
import { reasoningOpenDefault, toolOpenDefault, type ReasoningFoldMode } from "../reasoning-fold"
import { BasicToolV2 } from "./basic-tool-v2"
import { ToolErrorCardV2 } from "./tool-error-card-v2"
import "./native-transcript.css"

// Level-aware fold modes (UIX residue b / C4). Reasoning and tool cards carry SEPARATE modes so
// the user's explicit Settings prefs (feedReasoningDisplay/feedToolDisplay) can override each
// independently of the expertise default; callers that pass nothing keep the folded behavior.
// Consumed via context so the modes need not be prop-drilled through every message.
type FoldModes = { reasoning: ReasoningFoldMode; tool: ReasoningFoldMode }
const defaultFoldModes: Accessor<FoldModes> = () => ({ reasoning: "collapsed", tool: "collapsed" })
const ReasoningFoldContext = createContext<Accessor<FoldModes>>(defaultFoldModes)

// Per-message actions the host app can wire into the transcript (e.g. "revert to this prompt").
// Injected via context so `session-ui` stays decoupled from the app's SDK/dialog layer: the app
// passes a callback and owns confirmation + the actual revert mutation. Absent callback = no button.
type TranscriptActions = { onRevert?: (messageID: string) => void }
const TranscriptActionsContext = createContext<Accessor<TranscriptActions>>(() => ({}))

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

export function NativeTranscript(props: {
  messages: readonly SessionMessage[]
  class?: string
  reasoningFold?: ReasoningFoldMode
  toolFold?: ReasoningFoldMode
  /** Wire a per-user-message "revert to this prompt" action; omit to hide the button. */
  onRevert?: (messageID: string) => void
  /**
   * Prompts the user has SENT that the agent has not read yet (`GET /api/session/:id/pending`).
   * They are durable and already accepted, but have no transcript row until the runner promotes them —
   * so they are rendered here, after the real messages, as their own waiting bubbles. Without this a
   * mid-turn prompt disappears and is answered minutes later, and people retype it.
   */
  pending?: readonly { id: string; text: string }[]
}) {
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
    <ReasoningFoldContext.Provider
      value={() => ({
        reasoning: props.reasoningFold ?? "collapsed",
        // Tool cards historically followed the reasoning mode — keep that when no explicit
        // tool mode is given so existing callers render unchanged.
        tool: props.toolFold ?? props.reasoningFold ?? "collapsed",
      })}
    >
      <TranscriptActionsContext.Provider value={() => ({ onRevert: props.onRevert })}>
        <div data-component="native-transcript" class={props.class}>
          <For each={visible()}>{(message) => <NativeMessage message={message} />}</For>
          <For each={props.pending ?? []}>{(item) => <QueuedMessage text={item.text} />}</For>
        </div>
      </TranscriptActionsContext.Provider>
    </ReasoningFoldContext.Provider>
  )
}

function NativeMessage(props: { message: SessionMessage }) {
  return (
    <Switch>
      <Match when={props.message.type === "user" && props.message}>
        {(m) => (
          <Show when={!isSteerText(m().text)} fallback={<SteerMessage text={stripSteerProvenance(m().text)} />}>
            <UserMessage message={m()} />
          </Show>
        )}
      </Match>
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
      {/* agent-switched / model-switched are internal state events — not shown to the user (they read
          as debug noise like "Switched to agent build"). The events stay in the durable log. */}
    </Switch>
  )
}

/**
 * A prompt that is sent but not yet read — the transcript's read receipt, and the same idea as the single
 * tick in a messenger. It says what happens next on purpose: a mid-turn prompt waits for the current step
 * rather than interrupting a running edit or command, and without saying so people assume it was swallowed.
 * It disappears on its own when the runner promotes the input into a real user message.
 */
function QueuedMessage(props: { text: string }) {
  return (
    <div data-slot="native-user" data-queued="true">
      <div data-slot="native-user-bubble">
        <Show when={props.text.trim()}>
          <Markdown text={props.text} />
        </Show>
        <div data-slot="native-user-queued" aria-live="polite">
          <span data-slot="native-user-queued-dot" aria-hidden="true" />
          <span>Queued — the agent will read this when it finishes what it's doing</span>
        </div>
      </div>
    </div>
  )
}

// ── user ───────────────────────────────────────────────────────────────────────

function UserMessage(props: { message: SessionMessageUser }) {
  // P6: a remote/delegated turn shows a sender badge from its structured origin; a local-user turn
  // (no origin) shows nothing extra. The stored text is clean — the model-facing provenance header
  // is applied at lowering, not here.
  const badge = () => SessionOrigin.badge(props.message.origin)
  const actions = useContext(TranscriptActionsContext)
  return (
    <div data-slot="native-user">
      <div data-slot="native-user-bubble">
        <Show when={badge()}>
          {(b) => (
            <div data-slot="native-user-origin" data-tone={b().tone}>
              <span data-slot="native-user-origin-label">{b().label}</span>
              <Show when={b().detail}>
                <span data-slot="native-user-origin-detail">{b().detail}</span>
              </Show>
            </div>
          )}
        </Show>
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
      <Show when={actions().onRevert}>
        <div data-slot="native-msg-actions">
          <button
            type="button"
            data-slot="native-revert"
            aria-label="Revert to this prompt"
            title="Revert the conversation and files back to this prompt"
            onClick={() => actions().onRevert?.(props.message.id)}
          >
            Revert
          </button>
        </div>
      </Show>
    </div>
  )
}

/**
 * A harness-injected steer (the 1N provenance prefix marks it — doom-loop redirects, affective
 * nudges, denial redirects). It reaches the model as a user-role message, but it is NOT the user
 * speaking, so the transcript folds it away like reasoning instead of showing a user bubble —
 * a curious reader can expand it; nobody gets barked at by their own harness.
 */
function SteerMessage(props: { text: string }) {
  return (
    <details data-slot="native-notice" data-kind="steer">
      <summary>Automated nudge</summary>
      <div data-slot="native-notice-body">
        <Markdown text={props.text} />
      </div>
    </details>
  )
}

// ── assistant ────────────────────────────────────────────────────────────────────

function AssistantMessage(props: { message: SessionMessageAssistant }) {
  // While the turn is in flight but nothing has streamed yet (the model is thinking before
  // its first token), show a "working" indicator — otherwise a slow turn reads as a blank.
  const working = () =>
    !props.message.time.completed &&
    !props.message.content.some(
      (c) =>
        (c.type === "text" && c.text.trim().length > 0) ||
        (c.type === "reasoning" && c.text.trim().length > 0) ||
        c.type === "tool",
    )
  // The assistant's prose (text parts only — reasoning/tool output isn't "the answer").
  const copyableText = () =>
    props.message.content
      .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim()
  // The real reasoning-token count lands on the MESSAGE at step end. Attribute it to the reasoning
  // fold ONLY when there's exactly one reasoning part (the stitched-block norm) — with several parts
  // the per-message total can't be split, so those fall back to the per-part estimate.
  const reasoningParts = createMemo(
    () => props.message.content.filter((c) => c.type === "reasoning" && c.text.trim().length > 0).length,
  )
  const reasoningTokens = () => (reasoningParts() === 1 ? props.message.tokens?.reasoning : undefined)
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
                  <ReasoningPart part={p()} tokens={reasoningTokens()} />
                </Show>
              )}
            </Match>
            <Match when={part.type === "tool" && part}>{(p) => <ToolPart part={p()} />}</Match>
          </Switch>
        )}
      </For>
      <Show when={working()}>
        <div data-slot="native-working" aria-live="polite">
          <span data-slot="native-working-dot" />
          <span>Working…</span>
        </div>
      </Show>
      {/* The per-turn "N files changed" strip is deliberately NOT rendered. It repeated what the tool
          rows above it already say, and it re-listed build output on every rebuild (`pi.exe` after each
          compile), which buried the actual conversation. The git-changes tab is the surface for "what
          changed" and shows it properly. */}
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
      <Show when={props.message.time.completed && copyableText()}>
        <div data-slot="native-msg-actions">
          <button
            type="button"
            data-slot="native-copy"
            aria-label="Copy message"
            onClick={() => void navigator.clipboard?.writeText(copyableText())}
          >
            Copy
          </button>
        </div>
      </Show>
    </div>
  )
}

/**
 * A reasoning part with a level-aware default fold (uix.md §6 / UIX residue b). The fold mode
 * comes from ReasoningFoldContext (expertise-derived); `open` is FULLY controlled off it so
 * "live" mode can auto-collapse when the reasoning finishes. A user toggle wins forever after:
 * the summary click is intercepted (`preventDefault` stops the native toggle) so a programmatic
 * open/close never masquerades as a user override — only a real click latches `override`.
 *
 * While the part is still streaming, the summary is a live affordance instead of a static
 * label: a pulsing dot plus a growing character counter shows the model is actively thinking
 * even with the fold closed (a frozen counter = stalled), and opening it mid-stream shows the
 * text arriving — so a user can check the model isn't looping without waiting for the answer.
 */
function ReasoningPart(props: { part: SessionMessageAssistantReasoning; tokens?: number }) {
  const foldMode = useContext(ReasoningFoldContext)
  const [override, setOverride] = createSignal<boolean | undefined>(undefined)
  const completed = () => !!props.part.time?.completed
  const open = () => override() ?? reasoningOpenDefault(foldMode().reasoning, completed())
  const tokenLabel = () => reasoningTokenLabel(props.tokens, props.part.text)
  return (
    <details data-slot="native-reasoning" open={open()} data-streaming={completed() ? undefined : ""}>
      <summary
        onClick={(event) => {
          event.preventDefault()
          setOverride(!open())
        }}
      >
        <Show
          when={!completed()}
          fallback={
            <span data-slot="native-reasoning-done">
              <span>Reasoning</span>
              <span data-slot="native-reasoning-count">{tokenLabel()}</span>
            </span>
          }
        >
          <span data-slot="native-reasoning-live">
            <span data-slot="native-reasoning-live-dot" />
            <span>Reasoning…</span>
            <span data-slot="native-reasoning-count">{tokenLabel()}</span>
          </span>
        </Show>
      </summary>
      <div data-slot="native-reasoning-body">
        <Markdown text={props.part.text} />
      </div>
    </details>
  )
}


function ToolPart(props: { part: SessionMessageAssistantTool }) {
  const meta = () => toolMeta(props.part)
  // Level-aware default (UIX residue b): Developer sees tool cards expanded; others collapsed.
  const foldMode = useContext(ReasoningFoldContext)
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
          defaultOpen={toolOpenDefault(foldMode().tool)}
          trigger={{
            title: meta().title,
            subtitle: meta().subtitle,
            args: meta().args,
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
  // `synthetic` currently carries only runtime FAILURE notices (e.g. a pre-turn model error emitted
  // by the runner) — render it VISIBLE so the user actually sees why a turn didn't run, rather than
  // a collapsed "System note". `system` (injected context) stays a collapsed "Context" note.
  if (props.kind === "synthetic")
    return (
      <div
        data-slot="native-notice-visible"
        data-kind="synthetic"
        role="status"
        style={{
          margin: "0.5rem 0",
          padding: "0.625rem 0.875rem",
          "border-radius": "8px",
          border: "1px solid var(--v2-border-border-muted)",
          background: "var(--v2-background-bg-layer-01)",
          color: "var(--v2-text-text-base)",
          "font-size": "0.85rem",
        }}
      >
        <Markdown text={props.text} />
      </div>
    )
  return (
    <details data-slot="native-notice" data-kind="system">
      <summary>Context</summary>
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

// ── helpers ─────────────────────────────────────────────────────────────────────

interface ToolMeta {
  title: string
  subtitle?: string
  args?: string[]
}

/** Per-tool label/subtitle/args, ported from the V1 `getToolInfo` switch. */
function toolMeta(part: SessionMessageAssistantTool): ToolMeta {
  const input = toolInput(part.state)
  switch (part.name) {
    case "read": {
      const args: string[] = []
      const offset = num(input.offset)
      const limit = num(input.limit)
      if (offset !== undefined) args.push(`offset ${offset}`)
      if (limit !== undefined) args.push(`limit ${limit}`)
      return { title: "Read", subtitle: filePathOf(input), args }
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
    // The file-mutating tools read as a finished action plus the file — "Edited pi.c" — and carry NO
    // +N/-M stat inline. The stat was noise on every edit, and the exact diff is one click away in this
    // row's own body (and properly presented in the git-changes tab). Past tense on purpose: by the time
    // a row is on screen the action has happened.
    case "edit":
      return { title: "Edited", subtitle: filePathOf(input) }
    case "write":
      return { title: "Wrote", subtitle: filePathOf(input) }
    case "apply_patch": {
      const files = Array.isArray(input.files) ? input.files.length : undefined
      return { title: "Patched", subtitle: files ? `${files} file${files > 1 ? "s" : ""}` : undefined }
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

/**
 * The file a file-tool acted on. Every built-in file tool names this argument `path` (see
 * `core/src/tool/{read,edit,write}.ts`) — the transcript previously read only `filePath`, so the
 * read/edit/write rows silently rendered with NO filename at all. `filePath` stays as a fallback
 * because external/MCP tools use that spelling (and `tool/write.ts` carries a TODO about moving to it).
 */
function filePathOf(input: Record<string, unknown>): string | undefined {
  return basename(input.path) ?? basename(input.filePath)
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
