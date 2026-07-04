import { For, Show, Switch, Match } from "solid-js"
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
export function NativeTranscript(props: { messages: readonly SessionMessage[]; class?: string }) {
  return (
    <div data-component="native-transcript" class={props.class}>
      <For each={props.messages as SessionMessage[]}>{(message) => <NativeMessage message={message} />}</For>
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
      <Show when={props.message.error}>
        {(err) => (
          <div data-slot="native-error" role="alert">
            {err().message}
          </div>
        )}
      </Show>
    </div>
  )
}

function ToolPart(props: { part: SessionMessageAssistantTool }) {
  const output = () => {
    const state = props.part.state
    if (state.status === "completed" || state.status === "running" || state.status === "error")
      return toolContentText(state.content)
    return ""
  }
  return (
    <Switch>
      <Match when={props.part.state.status === "error" && props.part.state}>
        {(state) => (
          <ToolErrorCardV2
            data-slot="native-tool"
            title={props.part.name}
            subtitle={state().error.message}
            suffix={
              <div data-slot="native-tool-io">
                <pre data-slot="native-tool-input">{toolInputText(props.part.state)}</pre>
                <Show when={output()}>
                  <pre data-slot="native-tool-output">{output()}</pre>
                </Show>
              </div>
            }
          />
        )}
      </Match>
      <Match when={true}>
        <BasicToolV2
          data-slot="native-tool"
          status={props.part.state.status}
          trigger={{ title: props.part.name, subtitle: props.part.state.status }}
        >
          <div data-slot="native-tool-io">
            <pre data-slot="native-tool-input">{toolInputText(props.part.state)}</pre>
            <Show when={output()}>
              <pre data-slot="native-tool-output">{output()}</pre>
            </Show>
          </div>
        </BasicToolV2>
      </Match>
    </Switch>
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
