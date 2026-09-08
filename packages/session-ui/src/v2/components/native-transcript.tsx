import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  Switch,
  Match,
  onCleanup,
  useContext,
  type Accessor,
} from "solid-js"
import type {
  LlmToolContent,
  SessionMessage,
  SessionMessageAssistant,
  SessionMessageAssistantReasoning,
  SessionMessageAssistantTool,
  SessionMessageCompaction,
  SessionMessageCompactionStatus,
  SessionMessagePermissionChanged,
  SessionMessageShell,
  SessionMessageSynthetic,
  SessionMessageSystem,
  SessionMessageUser,
  SessionStatus,
} from "@novaclaw/sdk/v2"
import { isSteerText, stripSteerProvenance } from "@novaclaw/core/session/steer-provenance"
import { SessionOrigin } from "@novaclaw/core/session/origin"
import { Token } from "@novaclaw/core/util/token"
import { isInFlightAssistant, isOptimistic, unqueuedPending } from "../message-fold"
import { answerStart, foldClosing, groupTurns, stableGroups, type TurnGroup } from "../turn-group"
import { reasoningTokenLabel } from "./reasoning-count"
import { colleagueRow } from "./colleague-row"
import { spawnRow } from "./spawn-row"
import { waitRow } from "./wait-row"
import { toolIcon } from "./tool-icon"
import { toolInputForDisplay } from "./tool-input-preview"
import { fallbackWorkerLabel } from "@novaclaw/core/agent-status/worker-label"
import { Markdown } from "../../components/markdown"
import {
  reasoningGoesInReceipt,
  reasoningOpenDefault,
  toolOpenDefault,
  type ReasoningFoldMode,
} from "../reasoning-fold"
import { turnOutcome } from "./turn-receipt"
import { BasicToolV2 } from "./basic-tool-v2"
import { ToolErrorCardV2 } from "./tool-error-card-v2"
import {
  sessionErrorDisplay,
  sessionErrorDiagnostic,
  sessionErrorHeadline,
  type SessionErrorDisplay,
} from "@novaclaw/core/session/session-error"
import { useI18n, type UiI18n } from "@novaclaw/ui/context/i18n"
import { selectTranscriptMessages } from "../transcript-view"
import { messageTime } from "../message-time"
import { commandElapsed, shellActionTitle } from "../shell-card"
import {
  attemptLabel,
  currentPhase,
  detailLabel,
  elapsedMs,
  longStageNote,
  phaseLabel,
  seconds,
  type TurnTiming,
} from "./turn-receipt"

// Level-aware fold modes (UIX residue b / C4). Reasoning and tool cards carry SEPARATE modes so
// the user's explicit Settings prefs (feedReasoningDisplay/feedToolDisplay) can override each
// independently of the expertise default; callers that pass nothing keep the folded behavior.
// Consumed via context so the modes need not be prop-drilled through every message.
// `settled` rides with the modes because it is the same kind of fact and reaches the same consumer:
// a reasoning card deep in a turn has to know whether the TRANSCRIPT is still working, and prop-
// drilling one boolean through every message is what the context exists to avoid. It defaults to
// settled so a caller that renders history (no live status) folds exactly as it always did.
type FoldModes = { reasoning: ReasoningFoldMode; tool: ReasoningFoldMode; settled: boolean }
const defaultFoldModes: Accessor<FoldModes> = () => ({ reasoning: "collapsed", tool: "collapsed", settled: true })
const ReasoningFoldContext = createContext<Accessor<FoldModes>>(defaultFoldModes)

/**
 * The session-fault headline, TRANSLATED.
 *
 * ⚠️ **This surface rendered raw English until 2026-07-30.** It used the taxonomy's `headline` —
 * the English fallback that exists for surfaces with *no* translator (the headless CLI) — so every
 * session fault read in English regardless of locale, on the one surface a lay user is most likely
 * to hit first (a model server that is off, a key that expired). The taxonomy answers with
 * `key` + `params` precisely so this call site can translate it, and `sessionErrorHeadline` is the
 * shared one-liner that does it (the app's notification surface calls the same function).
 */
function useFaultText() {
  const i18n = useI18n()
  return (fault: SessionErrorDisplay): string => sessionErrorHeadline(fault, i18n.t)
}

/**
 * WHEN a message was written, beside Copy in the hover chrome (owner, 2026-08-23).
 *
 * ⚠️ It lives INSIDE `native-msg-actions`, which is hover-revealed and marked `user-select: none`.
 * Both matter: a timestamp on every row permanently would turn a conversation into a log, and one
 * that joined drag-selections would paste a wall of dates into whatever the reader copied.
 *
 * The short label is what fits; the full form is on `title`. Reasoning: `../message-time.ts`.
 */
function MessageTimestamp(props: { created: unknown }) {
  const i18n = useI18n()
  // `Date.now()` is read here, untracked, and that is correct: the chip is created when the row
  // renders and only decides today-vs-not-today, which does not change while a row is on screen.
  const stamp = createMemo(() => messageTime({ created: props.created, locale: i18n.locale() }))
  return (
    <Show when={stamp()}>
      {(value) => (
        <time data-slot="native-msg-time" dateTime={value().iso} title={value().full}>
          {value().label}
        </time>
      )}
    </Show>
  )
}

// Per-message actions the host app can wire into the transcript (e.g. "revert to this prompt").
// Injected via context so `session-ui` stays decoupled from the app's SDK/dialog layer: the app
// passes a callback and owns confirmation + the actual revert mutation. Absent callback = no button.
type TranscriptActions = {
  onRevert?: (messageID: string) => void
  onRetry?: (messageID: string) => void | Promise<void>
  onChooseModel?: () => void
  onUnpinDevice?: (sessionID: string) => void | Promise<void>
  onStopCommand?: (reason: string) => void | Promise<void>
}
const TranscriptActionsContext = createContext<Accessor<TranscriptActions>>(() => ({}))
const TranscriptMessagesContext = createContext<Accessor<readonly SessionMessage[]>>(() => [])

/**
 * **THE transcript.** It consumes the flat native `SessionMessage` union (`@novaclaw/sdk/v2`)
 * from the native store (`createNativeMessageStore`), so there is no `parentID` grouping and no
 * separate `part` map: the list arrives ordered oldest-first and every assistant carries its
 * `content[]` inline.
 *
 * ⚠️ **This used to say it was "mounted behind a DEV-only toggle for A/B verification against the
 * V1 timeline".** That was true while V1 still existed; the V1 nuke retired the other path
 * entirely, and `message-v2-store.ts` has called this THE render path since. Corrected 2026-08-11,
 * because a component that says it is a parallel experiment is one nobody dares change.
 *
 * The unit of layout is the TURN, not the message — see `Turn` below for why the flat list needed
 * a container at all.
 */
export function NativeTranscript(props: {
  messages: readonly SessionMessage[]
  class?: string
  reasoningFold?: ReasoningFoldMode
  toolFold?: ReasoningFoldMode
  /** Developer expertise reveals exact snapshot internals inside the otherwise friendly receipt. */
  developer?: boolean
  /** Wire a per-user-message "revert to this prompt" action; omit to hide the button. */
  onRevert?: (messageID: string) => void
  onRetry?: (messageID: string) => void | Promise<void>
  onChooseModel?: () => void
  onUnpinDevice?: (sessionID: string) => void | Promise<void>
  onStopCommand?: (reason: string) => void | Promise<void>
  status?: SessionStatus
  /**
   * Prompts the user has SENT that the agent has not read yet (`GET /api/session/:id/pending`).
   * They are durable and already accepted, but have no transcript row until the runner promotes them —
   * so they are rendered here, after the real messages, as their own waiting bubbles. Without this a
   * mid-turn prompt disappears and is answered minutes later, and people retype it.
   */
  pending?: readonly { id: string; text: string }[]
}) {
  const i18n = useI18n()
  // The native store captures the session's initial agent/model as `*-switched` messages,
  // but those are setup state (V1 shows them in the header, not the transcript). Drop the
  // LEADING run of switch markers; a switch that lands mid-conversation still renders as a
  // divider, which is the informative case.
  const visible = createMemo(() => {
    return selectTranscriptMessages(props.messages)
  })
  const hasOpenAssistant = createMemo(() => visible().some(isInFlightAssistant))
  // A harness steer rides the `user` role, so the turn boundary is "a user message the USER wrote".
  //
  // ⚠️ `stableGroups` is load-bearing, not an optimisation. `<For>` keys by reference, so returning
  // fresh group objects on every recompute rebuilds the WHOLE transcript on any tool result — which
  // collapses the scroller's height and drops the reader at the top (owner, 2026-08-11).
  const turns = createMemo<readonly TurnGroup<SessionMessage>[]>((previous) =>
    stableGroups(
      previous ?? [],
      groupTurns(visible(), (message) => message.type === "user" && !isSteerText(message.text)),
    ),
  )
  const busy = createMemo(() => props.status?.type === "busy" || props.status?.type === "retry")
  const liveTiming = createMemo(() => (props.status?.type === "busy" ? props.status.timing : undefined))
  const liveMessageID = createMemo(() => {
    const open = visible().find((message) => message.type === "assistant" && !message.time.completed)
    return open?.type === "assistant" ? open.id : undefined
  })
  /**
   * When THIS stretch of work began — across every turn in it.
   *
   * The status carries only the current turn's timing, so nothing on the wire says how long the
   * session has been working. A step that calls a tool ends one turn and starts another, and the
   * user is still waiting on the same piece of work: the number they want is the one that keeps
   * counting. Held here because this is the component that watches the status change.
   *
   * ⚠️ Cleared when the session stops being busy, NOT when a turn ends. That distinction is the
   * whole feature; clearing per turn would rebuild the bug it fixes.
   */
  /**
   * What the model has produced SO FAR, for the working row — "so the user knows it is going
   * somewhere" (owner, 2026-09-03).
   *
   * ⚠️ An ESTIMATE, and it says so with a `~`. Real usage arrives once, at finish, so during the wait
   * there is no exact number to show; this is the same chars/4 estimate the reasoning fold already
   * displays (`~525` in the owner's screenshot), over every part the open message has streamed —
   * reasoning AND answer, because both are the model generating.
   */
  /** The open message's reasoning, so the working fold can hold it instead of a second fold beside it. */
  const liveReasoning = createMemo(() => {
    const open = visible().find((message) => message.type === "assistant" && !message.time.completed)
    if (open?.type !== "assistant") return undefined
    const text = open.content
      .filter((part) => part.type === "reasoning")
      .map((part) => (part.type === "reasoning" ? part.text : ""))
      .join("")
      .trim()
    return text.length === 0 ? undefined : text
  })
  const liveTokens = createMemo(() => {
    const open = visible().find((message) => message.type === "assistant" && !message.time.completed)
    if (open?.type !== "assistant") return undefined
    const text = open.content
      .map((part) => (part.type === "text" || part.type === "reasoning" ? part.text : ""))
      .join("")
    return text.length === 0 ? undefined : reasoningTokenLabel(undefined, text)
  })
  let runStart: number | undefined
  const runStartedAt = createMemo(() => {
    if (props.status?.type !== "busy") {
      runStart = undefined
      return undefined
    }
    runStart ??= props.status.timing?.startedAt ?? Date.now()
    return runStart
  })
  return (
    <ReasoningFoldContext.Provider
      value={() => ({
        reasoning: props.reasoningFold ?? "collapsed",
        // Tool cards historically followed the reasoning mode — keep that when no explicit
        // tool mode is given so existing callers render unchanged.
        tool: props.toolFold ?? props.reasoningFold ?? "collapsed",
        // The SAME predicate `Turn` folds its work on (`running` reads `busy` first), so the two
        // folds settle together instead of one of them collapsing under a running turn.
        settled: !busy(),
      })}
    >
      <TranscriptMessagesContext.Provider value={() => props.messages}>
        <TranscriptActionsContext.Provider
          value={() => ({
            onRevert: props.onRevert,
            onRetry: props.onRetry,
            onChooseModel: props.onChooseModel,
            onUnpinDevice: props.onUnpinDevice,
            onStopCommand: props.onStopCommand,
          })}
        >
          <div data-component="native-transcript" class={props.class}>
            <For each={turns()}>
              {(group, index) => (
                <Turn
                  group={group}
                  developer={props.developer}
                  liveTiming={liveTiming() !== undefined}
                  busy={busy() && index() === turns().length - 1}
                />
              )}
            </For>
            {/* Only prompts the transcript is not already showing — see `unqueuedPending`. Both lists hold
              the first prompt of a session while it waits for the runner. */}
            <For each={unqueuedPending(props.pending, props.messages)}>
              {(item) => <QueuedMessage id={item.id} text={item.text} />}
            </For>
            <Show
              when={liveTiming()}
              fallback={
                <Show when={props.status?.type === "busy" && !hasOpenAssistant()}>
                  <div data-slot="native-provider-status" role="status" aria-live="polite">
                    <span data-slot="native-working-dot" aria-hidden="true" />
                    <span>{i18n.t("ui.transcript.working")}</span>
                  </div>
                </Show>
              }
            >
              {(timing) => (
                <TurnReceipt
                  messageID={liveMessageID()}
                  timing={timing()}
                  live
                  developer={props.developer}
                  runStartedAt={runStartedAt()}
                  tokens={liveTokens()}
                  reasoning={liveReasoning()}
                />
              )}
            </Show>
            <Show when={props.status?.type === "retry" && props.status.message}>
              {(message) => (
                <div data-slot="native-provider-status" role="status" aria-live="polite">
                  <span data-slot="native-working-dot" aria-hidden="true" />
                  <span>{message()}</span>
                </div>
              )}
            </Show>
          </div>
        </TranscriptActionsContext.Provider>
      </TranscriptMessagesContext.Provider>
    </ReasoningFoldContext.Provider>
  )
}

/**
 * One turn: the prompt, and what the agent did about it.
 *
 * **While it runs, everything shows.** Watching the work IS the feedback — a fold that hides a
 * running turn reads as a hang. **Once it settles, the work collapses under one control** and the
 * answer stands alone (owner ruling, 2026-08-11): the internals stay one click away for whoever
 * wants to open the hood, which is the promise, rather than a wall of tool output that buries what
 * the reader actually came back for.
 *
 * Three cases deliberately do NOT fold, because folding them would hide the only thing worth
 * showing: a turn still in flight, a turn with no prose to stand in for its work (interrupted, or
 * ended on a tool call), and a plain answer with no work behind it — which would otherwise get a
 * "Done" box containing nothing but its own timings.
 */
function Turn(props: {
  group: TurnGroup<SessionMessage>
  developer?: boolean
  liveTiming?: boolean
  /** This is the last turn and the session is still working — never fold it. */
  busy?: boolean
}) {
  const i18n = useI18n()
  const body = () => props.group.body
  const running = () => props.busy || body().some(isInFlightAssistant)
  /** The turn's closing assistant message — the only one that can carry the answer. */
  const closing = () => {
    const tail = body().at(-1)
    return tail?.type === "assistant" ? tail : undefined
  }
  const split = () => {
    const message = closing()
    return message ? answerStart(message.content) : 0
  }
  const hasAnswer = () => {
    const message = closing()
    return message !== undefined && split() < message.content.length
  }
  /** Is there anything BEHIND the answer worth a fold? Earlier steps, or work in the closing one. */
  const hasWork = () => body().length > 1 || split() > 0
  /**
   * The stand-in when a settled turn produced no prose — 57% of tool-bearing turns (measured
   * 2026-08-11). Without it those turns cannot fold, and render their raw internals in full: the
   * exact wall of tool output the Done control exists to hide. `answerStart`'s contract is *do not
   * fold a turn that has nothing to show in its place*; this GIVES it something to show, and only
   * ever states what the transcript knows.
   */
  const outcome = () =>
    running() || hasAnswer() ? undefined : turnOutcome({ toolCount: toolCount(), lastToolName: lastToolName() })
  /**
   * 🔴 **The fold is BUILT AROUND the closing assistant message, so it may not render without one.**
   *
   * This crashed a shipped 0.1.67 renderer mid-conversation, and the whole app went with it:
   * `TypeError: Cannot read properties of undefined (reading 'time')`. The folded branch renders
   * `<AssistantMessage message={closing()!} …>` twice, and `closing()` is `undefined` whenever the
   * turn's last row is not an assistant one — a tool, a shell row, a notice. The `!` told the
   * compiler that could not happen; at runtime `AssistantMessage` read `props.message.time` on
   * `undefined` and threw out of a `<Show>`'s `when`.
   *
   * ⚠️ **Every clause of the old gate passes in exactly that state**, which is why it was reachable
   * rather than theoretical: `hasAnswer()` is false with no closing message, so `outcome()` returns
   * its stand-in and satisfies the third clause; `hasWork()` needs only `body().length > 1`; and
   * `running()` goes false the moment the turn settles. So a settled multi-row turn ending on a
   * tool call rendered the fold and dereferenced nothing — measured live in session
   * `ses_fbc4201ceffe…`, at `session.finish`.
   *
   * Returning the MESSAGE rather than a boolean is what removes the two `!`s: the `<Show>` below
   * binds it, so the branch that uses it cannot be entered without it.
   */
  const foldsClosing = () =>
    foldClosing({
      closing: closing(),
      running: running(),
      hasWork: hasWork(),
      hasAnswer: hasAnswer(),
      outcome: outcome(),
    })
  /** The closing message's last tool — an `exit` ends the drain deliberately, so it is not a stop-short. */
  const lastToolName = () => {
    const parts = closing()?.content.filter((part) => part.type === "tool")
    return parts?.at(-1)?.name
  }
  const toolCount = () =>
    body().reduce(
      (total, message) =>
        message.type === "assistant" ? total + message.content.filter((part) => part.type === "tool").length : total,
      0,
    )
  return (
    <div data-slot="native-turn">
      <Show when={props.group.lead}>
        {(lead) => <NativeMessage message={lead()} developer={props.developer} liveTiming={props.liveTiming} />}
      </Show>
      <Show
        when={foldsClosing()}
        keyed
        fallback={
          <For each={body()}>
            {(message) => <NativeMessage message={message} developer={props.developer} liveTiming={props.liveTiming} />}
          </For>
        }
      >
        {(closingMessage) => (
          <>
            <details data-slot="native-turn-work">
              <summary>
                {/* The flex lives HERE, not on <summary> — see the css note; flexing the summary drops
                the native triangle, which is what left this fold without one. */}
                <span data-slot="native-turn-work-summary">
                  <span data-slot="native-turn-work-label">{i18n.t("ui.transcript.done")}</span>
                  <Show when={toolCount() > 0}>
                    <span data-slot="native-turn-work-count">{i18n.plural("ui.transcript.steps", toolCount())}</span>
                  </Show>
                </span>
              </summary>
              <div data-slot="native-turn-work-body">
                <For each={body().slice(0, -1)}>
                  {(message) => (
                    <NativeMessage message={message} developer={props.developer} liveTiming={props.liveTiming} />
                  )}
                </For>
                <AssistantMessage
                  message={closingMessage}
                  developer={props.developer}
                  liveTiming={props.liveTiming}
                  half="work"
                />
              </div>
            </details>
            <Show
              when={outcome()}
              fallback={
                <AssistantMessage
                  message={closingMessage}
                  developer={props.developer}
                  liveTiming={props.liveTiming}
                  half="answer"
                />
              }
            >
              {(line) => <p data-slot="native-turn-outcome">{line()}</p>}
            </Show>
          </>
        )}
      </Show>
    </div>
  )
}

function NativeMessage(props: { message: SessionMessage; developer?: boolean; liveTiming?: boolean }) {
  return (
    <Switch>
      <Match when={props.message.type === "user" && props.message}>
        {(m) => (
          <Show
            when={!isSteerText(m().text)}
            fallback={<SteerMessage text={stripSteerProvenance(m().text)} cacheKey={`${m().id}:steer`} />}
          >
            <UserMessage message={m()} />
          </Show>
        )}
      </Match>
      <Match when={props.message.type === "assistant" && props.message}>
        {(m) => <AssistantMessage message={m()} developer={props.developer} liveTiming={props.liveTiming} />}
      </Match>
      <Match when={props.message.type === "shell" && props.message}>{(m) => <ShellMessage message={m()} />}</Match>
      <Match when={props.message.type === "system" && props.message}>
        {(m) => <NoticeMessage kind="system" text={m().text} messageID={m().id} />}
      </Match>
      <Match when={props.message.type === "synthetic" && props.message}>
        {(m) => {
          const message = m() as SessionMessageSynthetic
          if (isSteerText(message.text))
            return <SteerMessage text={stripSteerProvenance(message.text)} cacheKey={`${message.id}:steer`} />
          return (
            <NoticeMessage
              kind="synthetic"
              text={message.text}
              messageID={message.id}
              sessionID={message.sessionID}
              repair={message.repair}
            />
          )
        }}
      </Match>
      <Match when={props.message.type === "compaction" && props.message}>
        {(m) => <CompactionMessage message={m()} />}
      </Match>
      <Match when={props.message.type === "compaction-status" && props.message}>
        {(m) => <CompactionMessage message={m()} />}
      </Match>
      <Match when={props.message.type === "permission-changed" && props.message}>
        {(m) => <PermissionChangedMessage message={m() as SessionMessagePermissionChanged} />}
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
function QueuedMessage(props: { id: string; text: string }) {
  const i18n = useI18n()
  return (
    <div data-slot="native-user" data-queued="true">
      <div data-slot="native-user-bubble">
        <Show when={props.text.trim()}>
          <Markdown text={props.text} cacheKey={`${props.id}:queued`} />
        </Show>
        <div data-slot="native-user-queued" aria-live="polite">
          <span data-slot="native-user-queued-dot" aria-hidden="true" />
          <span>{i18n.t("ui.transcript.queued")}</span>
        </div>
      </div>
    </div>
  )
}

// ── user ───────────────────────────────────────────────────────────────────────

function UserMessage(props: { message: SessionMessageUser }) {
  const i18n = useI18n()
  // P6: a remote/delegated turn shows a sender badge from its structured origin; a local-user turn
  // (no origin) shows nothing extra. The stored text is clean — the model-facing provenance header
  // is applied at lowering, not here.
  const badge = () => SessionOrigin.badge(props.message.origin)
  const actions = useContext(TranscriptActionsContext)
  // Not-yet-acknowledged: the row is on screen because the user pressed Enter, not because the server
  // has it. Rendered DIFFERENTLY on purpose — a pending message that looks identical to a delivered one
  // answers "where did it go?" while leaving "did it send?" open, which is the owner's "unread".
  const pending = () => isOptimistic(props.message)
  return (
    <div data-slot="native-user" data-message-id={props.message.id} data-pending={pending() ? "" : undefined}>
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
          <Markdown text={props.message.text} cacheKey={props.message.id} />
        </Show>
        <Show when={props.message.files?.length || props.message.agents?.length}>
          <div data-slot="native-user-attachments">
            <For each={props.message.files ?? []}>
              {(file) => (
                <span data-slot="native-chip">{file.name ?? file.mime ?? i18n.t("ui.message.attachment.alt")}</span>
              )}
            </For>
            <For each={props.message.agents ?? []}>{(agent) => <span data-slot="native-chip">@{agent.name}</span>}</For>
          </div>
        </Show>
      </div>
      {/* ⚠️ The row is no longer gated on `onRevert`. The timestamp belongs to EVERY message, and
          hanging it off a host-supplied callback would have made "when did I say this?" answerable
          only in a client that also happens to wire up Revert. */}
      <div data-slot="native-msg-actions">
        <Show when={actions().onRevert}>
          <button
            type="button"
            data-slot="native-revert"
            aria-label={i18n.t("ui.transcript.revert.label")}
            title={i18n.t("ui.transcript.revert.title")}
            onClick={() => actions().onRevert?.(props.message.id)}
          >
            {i18n.t("ui.transcript.revert.action")}
          </button>
        </Show>
        <MessageTimestamp created={props.message.time.created} />
      </div>
    </div>
  )
}

/**
 * A harness-injected steer (the 1N provenance prefix marks it — doom-loop redirects, affective
 * nudges, denial redirects). It reaches the model as a user-role message, but it is NOT the user
 * speaking, so the transcript folds it away like reasoning instead of showing a user bubble —
 * a curious reader can expand it; nobody gets barked at by their own harness.
 */
function SteerMessage(props: { text: string; cacheKey?: string }) {
  const i18n = useI18n()
  return (
    <details data-slot="native-notice" data-kind="steer">
      <summary>{i18n.t("ui.transcript.steer")}</summary>
      <div data-slot="native-notice-body">
        <Markdown text={props.text} cacheKey={props.cacheKey} />
      </div>
    </details>
  )
}

// ── assistant ────────────────────────────────────────────────────────────────────

/**
 * `half` splits ONE assistant message across the turn's fold: its tool calls, reasoning and
 * in-between narration render as `work` inside Done, its closing prose as the `answer` outside.
 * Omit it to render the whole message, which is what a running turn and every non-closing step do.
 *
 * The chrome follows meaning rather than position: the turn receipt belongs to the work, while a
 * fault card, a truncated-reply notice and Copy belong to the answer — **a fault must never end up
 * inside a fold**, or the one thing the reader must act on is the one thing hidden from them.
 */
function AssistantMessage(props: {
  message: SessionMessageAssistant
  developer?: boolean
  liveTiming?: boolean
  half?: "work" | "answer"
}) {
  const i18n = useI18n()
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
  //
  // ⚠️ **This IS the end state, checked 2026-08-11 — do not re-open it as a gap.** No provider gives
  // a per-part figure: `LLM.Usage` (which carries `reasoningTokens`) arrives once, at finish, for the
  // whole step, and `reasoning-end` carries only `providerMetadata`. Anthropic does not break
  // thinking out of `output_tokens` at all. So the only way to put an exact-looking number on each
  // of several parts would be to invent a split — a fabricated figure rendered in the same style as
  // a measured one, which is strictly worse than the `~` estimate `reasoningTokenLabel` already
  // marks as approximate.
  const reasoningParts = createMemo(
    () => props.message.content.filter((c) => c.type === "reasoning" && c.text.trim().length > 0).length,
  )
  const reasoningTokens = () => (reasoningParts() === 1 ? props.message.tokens?.reasoning : undefined)
  const faultText = useFaultText()
  const actions = useContext(TranscriptActionsContext)
  const split = () => answerStart(props.message.content)
  const parts = () => {
    if (props.half === "work") return props.message.content.slice(0, split())
    if (props.half === "answer") return props.message.content.slice(split())
    return props.message.content
  }
  const showReceipt = () => props.half !== "answer"
  const showChrome = () => props.half !== "work"
  /**
   * Does the Details fold hold this half's reasoning?
   *
   * Only when one is actually going to be drawn — `TurnReceipt` renders its `<details>` under
   * `Show when={timing()}`, so handing parts to a receipt that has no timing would delete them from
   * the transcript rather than move them. A part never disappears: when there is no fold to put it
   * in, it stays where it always was.
   */
  const receiptHoldsReasoning = () =>
    reasoningGoesInReceipt({ half: props.half, hasTiming: props.message.timing !== undefined })
  /** This half's reasoning parts, for the fold — empty whenever they render inline instead. */
  const foldedReasoning = () =>
    receiptHoldsReasoning()
      ? parts().filter(
          (part): part is SessionMessageAssistantReasoning => part.type === "reasoning" && part.text.trim().length > 0,
        )
      : []
  return (
    <div data-slot="native-assistant">
      <For each={parts()}>
        {(part) => (
          <Switch>
            <Match when={part.type === "text" && part}>
              {(p) => (
                <Show when={p().text.trim()}>
                  <div data-slot="native-assistant-text">
                    <Markdown
                      text={p().text}
                      cacheKey={`${props.message.id}:${p().id}`}
                      streaming={!props.message.time.completed}
                    />
                  </div>
                </Show>
              )}
            </Match>
            <Match when={part.type === "reasoning" && part}>
              {(p) => (
                // ⚠️ Hidden ONLY while the live working fold is holding this same text — otherwise it
                // would render twice, which is the two-rows-one-wait defect facing the other way. The
                // gate is the same one the per-message receipt already uses, so the two cannot
                // disagree about which of them is showing.
                <Show
                  when={
                    p().text.trim() && !(props.liveTiming && !props.message.time.completed) && !receiptHoldsReasoning()
                  }
                >
                  <ReasoningPart part={p()} tokens={reasoningTokens()} cacheKey={`${props.message.id}:${p().id}`} />
                </Show>
              )}
            </Match>
            <Match when={part.type === "tool" && part}>{(p) => <ToolPart part={p()} />}</Match>
          </Switch>
        )}
      </For>
      <Show when={showReceipt() && ((working() && !props.liveTiming) || props.message.timing)}>
        <TurnReceipt
          messageID={props.message.id}
          timing={props.message.timing}
          live={working() && !props.liveTiming}
          developer={props.developer}
          reasoningParts={foldedReasoning()}
          reasoningTokens={reasoningTokens()}
        />
      </Show>
      {/* The per-turn "N files changed" strip is deliberately NOT rendered. It repeated what the tool
          rows above it already say, and it re-listed build output on every rebuild (`pi.exe` after each
          compile), which buried the actual conversation. The git-changes tab is the surface for "what
          changed" and shows it properly. */}
      <Show when={showChrome() && props.message.error && sessionErrorDisplay(props.message.error)}>
        {(fault) => (
          <Show
            when={fault().kind !== "interrupted"}
            fallback={
              <div data-slot="native-interrupted-divider">
                <span>{faultText(fault())}</span>
              </div>
            }
          >
            <FaultCard
              messageID={props.message.id}
              error={props.message.error!}
              fault={fault()}
              headline={faultText(fault())}
              actions={actions()}
            />
          </Show>
        )}
      </Show>
      <Show when={showChrome() && props.message.finish === "broken"}>
        <details data-slot="native-broken-reply">
          <summary>{i18n.t("ui.transcript.brokenReply.title")}</summary>
          <div>{i18n.t("ui.transcript.brokenReply.body")}</div>
        </details>
      </Show>
      <Show when={showChrome() && props.message.time.completed && copyableText()}>
        <div data-slot="native-msg-actions">
          <button
            type="button"
            data-slot="native-copy"
            aria-label={i18n.t("ui.message.copyMessage")}
            onClick={() => void navigator.clipboard?.writeText(copyableText())}
          >
            {i18n.t("ui.message.copy")}
          </button>
          <MessageTimestamp created={props.message.time.created} />
        </div>
      </Show>
    </div>
  )
}

function ElapsedTime(props: { startedAt: number; completedAt?: number; live: boolean }) {
  const [now, setNow] = createSignal(Date.now())
  let timer: ReturnType<typeof setInterval> | undefined
  createEffect(() => {
    if (!props.live || props.completedAt !== undefined) {
      if (timer) clearInterval(timer)
      timer = undefined
      return
    }
    if (!timer) timer = setInterval(() => setNow(Date.now()), 250)
  })
  onCleanup(() => {
    if (timer) clearInterval(timer)
  })
  return (
    <Show when={seconds(elapsedMs(props.startedAt, props.completedAt, now()))}>
      {(value) => <span data-slot="native-turn-elapsed">{value()}</span>}
    </Show>
  )
}

/**
 * The receipt's summary is ONE label and ONE clock, and both are about the RUN.
 *
 * Owner, 2026-09-03: *"everything should be inside a single Working fold with a count of generated
 * tokens so the user knows it is going somewhere … the time also resets after each agent's action,
 * instead of keeping the total so the user could see how long the work is going on."*
 *
 * Two defects, one cause: the summary was describing the current TURN rather than the work. It took
 * its title from the current PHASE (`Writing the answer…`), which is a stage name doing duty as the
 * name of a fold full of stage names — and it took its clock from `timing.startedAt`, which is the
 * start of THIS provider turn. A step that calls a tool ends one turn and begins another, so the
 * clock went back to zero at every action while the user waited on one continuous piece of work.
 *
 * So: the title is the working label, always — the phase is inside the fold, where the rest of the
 * stages are — and the clock counts from `runStartedAt`, which the transcript holds across turns.
 */
function TurnReceipt(props: {
  messageID?: string
  timing?: TurnTiming
  live: boolean
  developer?: boolean
  /** When this stretch of work began, across every turn in it. Falls back to this turn's own start. */
  runStartedAt?: number
  /** Approximate tokens generated so far, already formatted with its `~`. Live turns only. */
  tokens?: string
  /**
   * The model's reasoning while this run is live, held INSIDE the working fold.
   *
   * 🔴 One fold, not two. Owner, 2026-09-03: *"everything being inside a single Working fold with a
   * count of generated tokens"* — and principle 12(d) says the same thing on its own: state what is
   * in force in ONE line, with the rest on demand. A separate `Reasoning…` row beside a separate
   * `Working…` row is two lines about one wait, which is what the screenshot showed.
   */
  reasoning?: string
  /**
   * The SETTLED message's reasoning, held inside this fold as its own parts.
   *
   * 🔴 **This reverses the paragraph that used to stand here**, which said live-only was "the whole
   * distinction" and that a finished turn's reasoning must stay in its own fold because folding it
   * into stage timings "would bury it". The owner ruled otherwise the same day, holding a screenshot
   * of a four-step answer: *"the reasoning is not hidden inside of the Details fold, so clutters the
   * chat window. Most users will only look at the model reasoning if something is wrong."*
   *
   * Burying it was the point. A reader who wants the answer should see the answer; the trace is for
   * the reader who has a reason to look, and that reader is already opening Details. Four `Reasoning`
   * rows down the left of one reply is the same *two lines about one wait* defect as above, repeated
   * once per step.
   *
   * ⚠️ The PARTS, not their text joined: they keep their order against the tool cards, their own
   * `~N` counts and their streaming state, so nothing is lost by moving them — only their parent
   * changes. The Developer level opens them by default (`reasoningOpenDefault`), so a trace is still
   * one click away for the person who lives in it.
   */
  reasoningParts?: readonly SessionMessageAssistantReasoning[]
  /** The per-message reasoning token count, attributed only when there is exactly one part. */
  reasoningTokens?: number
}) {
  const i18n = useI18n()
  const timing = () => props.timing
  // One live line, one label. The transcript's own status row, this receipt's fallback and the
  // phase label are three places that can claim "the turn is live"; they must not do it in two
  // different words, and only the host app knows the translated one.
  const actions = useContext(TranscriptActionsContext)
  const working = () => i18n.t("ui.transcript.working")
  // ⚠️ The phase is NOT the title. It is one row inside, marked `data-current`, which is where a
  // reader looks for "which stage" — and it stops the fold renaming itself every few seconds while
  // the user is trying to read it.
  const liveLabel = () => working()
  const attempts = (value: TurnTiming) =>
    value.providerAttempts.filter((attempt) => attempt.outcome !== "completed" || value.providerAttempts.length > 1)
  // A stage that runs long gets a sentence saying WHY it might. Ticked once a second — the note
  // only changes at a 10 s threshold, so the 250 ms cadence the elapsed counters need would be
  // three quarters of a second of wasted work per counter.
  const [tick, setTick] = createSignal(Date.now())
  createEffect(() => {
    if (!props.live) return
    const timer = setInterval(() => setTick(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })
  const note = () => {
    const value = timing()
    if (!props.live || !value) return undefined
    const phase = currentPhase(value)
    return phase ? longStageNote(phase.phase, elapsedMs(phase.startedAt, phase.completedAt, tick())) : undefined
  }
  return (
    <Show
      when={timing()}
      fallback={
        <Show when={props.live}>
          <div data-slot="native-working" aria-live="polite">
            <span data-slot="native-working-dot" />
            <span>{working()}</span>
          </div>
        </Show>
      }
    >
      {(value) => (
        <>
          <details data-slot="native-turn-receipt" data-live={props.live ? "" : undefined}>
            <summary aria-live={props.live ? "polite" : undefined}>
              <span data-slot="native-turn-summary">
                <Show when={props.live}>
                  <span data-slot="native-working-dot" aria-hidden="true" />
                </Show>
                {/* Owner ruling 2026-08-11: the settled label is just "Details" — the internals are
                  there for whoever wants to open the hood, and a longer name advertises them. */}
                <span>{props.live ? liveLabel() : i18n.t("ui.transcript.details")}</span>
                <Show when={props.tokens}>{(count) => <span data-slot="native-turn-tokens">{count()}</span>}</Show>
                <ElapsedTime
                  startedAt={props.live ? (props.runStartedAt ?? value().startedAt) : value().startedAt}
                  completedAt={value().completedAt}
                  live={props.live}
                />
              </span>
            </summary>
            <Show when={props.reasoning}>
              {(text) => (
                <div data-slot="native-turn-reasoning">
                  <Markdown text={text()} cacheKey={props.messageID ? `${props.messageID}:reasoning` : undefined} />
                </div>
              )}
            </Show>
            <Show when={props.reasoningParts?.length}>
              <div data-slot="native-turn-reasoning-parts">
                <For each={props.reasoningParts}>
                  {(part) => (
                    <ReasoningPart
                      part={part}
                      tokens={props.reasoningTokens}
                      cacheKey={props.messageID ? `${props.messageID}:reasoning:${part.id}` : undefined}
                    />
                  )}
                </For>
              </div>
            </Show>
            <ol data-slot="native-turn-phases">
              <For each={value().phases}>
                {(phase) => (
                  <li data-current={phase.completedAt === undefined ? "" : undefined}>
                    <div data-slot="native-turn-phase">
                      <span>{phaseLabel(phase.phase)}</span>
                      <ElapsedTime startedAt={phase.startedAt} completedAt={phase.completedAt} live={props.live} />
                    </div>
                    <Show when={props.developer && phase.details?.length}>
                      <ul data-slot="native-turn-details">
                        <For each={phase.details}>
                          {(detail) => (
                            <li>
                              <span>{detailLabel(detail.phase)}</span>
                              <ElapsedTime
                                startedAt={detail.startedAt}
                                completedAt={detail.completedAt}
                                live={props.live}
                              />
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </li>
                )}
              </For>
              <For each={attempts(value())}>
                {(attempt) => (
                  <li data-kind={attempt.outcome === "retry" ? "retry" : "attempt"}>
                    <div data-slot="native-turn-phase">
                      <span>{attemptLabel(attempt)}</span>
                      <ElapsedTime
                        startedAt={attempt.dispatchedAt}
                        completedAt={attempt.completedAt}
                        live={props.live}
                      />
                    </div>
                  </li>
                )}
              </For>
            </ol>
          </details>
          {/* Outside the fold on purpose: the whole point is that it reaches someone who has NOT
            opened the receipt and is wondering whether the thing is stuck. */}
          <Show when={note()}>
            {(text) => (
              <div data-slot="native-turn-note" role="status">
                {text()}
              </div>
            )}
          </Show>
        </>
      )}
    </Show>
  )
}

function FaultCard(props: {
  messageID: string
  error: NonNullable<SessionMessageAssistant["error"]>
  fault: SessionErrorDisplay
  headline: string
  actions: TranscriptActions
}) {
  const i18n = useI18n()
  const [retrying, setRetrying] = createSignal(false)
  const labels = () => ({
    retry: i18n.t("ui.transcript.error.retry"),
    chooseModel: i18n.t("ui.transcript.error.chooseModel"),
    technicalDetails: i18n.t("ui.transcript.error.technicalDetails"),
    copyDetails: i18n.t("ui.transcript.error.copyDetails"),
    working: i18n.t("ui.transcript.working"),
  })
  const diagnostic = () => sessionErrorDiagnostic(props.error)
  const retry = async () => {
    if (retrying() || !props.actions.onRetry) return
    setRetrying(true)
    await Promise.resolve(props.actions.onRetry(props.messageID))
      .catch(() => undefined)
      .finally(() => setRetrying(false))
  }
  return (
    <div data-slot="native-error" role="alert">
      <div data-slot="native-error-headline">{props.headline}</div>
      <Show when={props.fault.detail}>{(detail) => <div data-slot="native-error-detail">{detail()}</div>}</Show>
      <details data-slot="native-error-details">
        <summary>{labels().technicalDetails}</summary>
        <pre>{diagnostic()}</pre>
      </details>
      <div data-slot="native-error-actions">
        <Show when={props.fault.canRetry && props.actions.onRetry}>
          <button type="button" disabled={retrying()} onClick={() => void retry()}>
            {labels().retry}
          </button>
        </Show>
        <Show when={props.actions.onChooseModel}>
          <button type="button" onClick={() => props.actions.onChooseModel?.()}>
            {labels().chooseModel}
          </button>
        </Show>
        <button type="button" onClick={() => void navigator.clipboard?.writeText(diagnostic())}>
          {labels().copyDetails}
        </button>
      </div>
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
function ReasoningPart(props: { part: SessionMessageAssistantReasoning; tokens?: number; cacheKey?: string }) {
  const i18n = useI18n()
  const foldMode = useContext(ReasoningFoldContext)
  const [override, setOverride] = createSignal<boolean | undefined>(undefined)
  const completed = () => !!props.part.time?.completed
  const open = () => override() ?? reasoningOpenDefault(foldMode().reasoning, completed(), foldMode().settled)
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
              <span>{i18n.t("ui.transcript.reasoning")}</span>
              <span data-slot="native-reasoning-count">{tokenLabel()}</span>
            </span>
          }
        >
          <span data-slot="native-reasoning-live">
            <span data-slot="native-reasoning-live-dot" />
            <span>{i18n.t("ui.transcript.reasoning.live")}</span>
            <span data-slot="native-reasoning-count">{tokenLabel()}</span>
          </span>
        </Show>
      </summary>
      <div data-slot="native-reasoning-body">
        <Markdown text={props.part.text} cacheKey={props.cacheKey} />
      </div>
    </details>
  )
}

function ToolPart(props: { part: SessionMessageAssistantTool }) {
  const i18n = useI18n()
  const messages = useContext(TranscriptMessagesContext)
  const meta = () => toolMeta(props.part, i18n, messages())
  // Level-aware default (UIX residue b): Developer sees tool cards expanded; others collapsed.
  const foldMode = useContext(ReasoningFoldContext)
  const faultText = useFaultText()
  const actions = useContext(TranscriptActionsContext)
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    if (props.part.name !== "bash" || props.part.state.status !== "running") return
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    onCleanup(() => clearInterval(timer))
  })
  const shellCommand = () => (props.part.name === "bash" ? str(toolInput(props.part.state).command) : undefined)
  const elapsed = () =>
    props.part.name === "bash"
      ? commandElapsed(props.part.time.ran ?? props.part.time.created, props.part.time.completed, now())
      : undefined
  return (
    <Switch>
      <Match when={props.part.name === "todowrite"}>
        <TodoTool part={props.part} />
      </Match>

      <Match when={props.part.name !== "bash" && props.part.state.status === "error" && props.part.state}>
        {(state) => (
          <ToolErrorCardV2
            data-slot="native-tool"
            title={meta().title}
            subtitle={faultText(sessionErrorDisplay(state().error))}
            suffix={<ToolBody part={props.part} />}
          />
        )}
      </Match>
      <Match when={true}>
        <BasicToolV2
          data-slot="native-tool"
          status={props.part.state.status}
          defaultOpen={toolOpenDefault(foldMode().tool)}
          expandWhilePending={props.part.name === "bash"}
          trigger={{
            icon: toolIcon(props.part.name),
            title:
              props.part.name === "bash" ? (props.part.title ?? shellActionTitle(shellCommand() ?? "")) : meta().title,
            subtitle: props.part.name === "bash" ? elapsed() : meta().subtitle,
            args: meta().args,
          }}
        >
          <ToolBody part={props.part} />
          <Show when={props.part.name === "bash" && props.part.state.status === "running" && actions().onStopCommand}>
            <CommandStop onStop={(reason) => actions().onStopCommand?.(reason)} />
          </Show>
        </BasicToolV2>
      </Match>
    </Switch>
  )
}

function CommandStop(props: { onStop: (reason: string) => void | Promise<void> }) {
  const i18n = useI18n()
  const [reason, setReason] = createSignal("")
  const [stopping, setStopping] = createSignal(false)
  const stop = async () => {
    const why = reason().trim()
    if (!why || stopping()) return
    setStopping(true)
    try {
      await props.onStop(why)
    } finally {
      setStopping(false)
    }
  }
  return (
    <div data-slot="native-command-stop">
      <input
        value={reason()}
        placeholder={i18n.t("ui.transcript.command.stopReason")}
        aria-label={i18n.t("ui.transcript.command.stopReason")}
        onInput={(event) => setReason(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") void stop()
        }}
      />
      <button type="button" disabled={!reason().trim() || stopping()} onClick={() => void stop()}>
        {stopping() ? i18n.t("ui.transcript.command.stopping") : i18n.t("ui.transcript.command.stop")}
      </button>
    </div>
  )
}

/** `todowrite` → an inline checklist (the one tool whose payload reads best expanded). */
function TodoTool(props: { part: SessionMessageAssistantTool }) {
  const i18n = useI18n()
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
      trigger={{
        icon: toolIcon(props.part.name),
        title: i18n.t("ui.transcript.todos"),
        subtitle: todos().length ? `${done()}/${todos().length}` : undefined,
      }}
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

function NoticeMessage(props: {
  kind: "system" | "synthetic"
  text: string
  messageID?: string
  sessionID?: string
  repair?: SessionMessageSynthetic["repair"]
}) {
  const i18n = useI18n()
  const actions = useContext(TranscriptActionsContext)
  const [repairState, setRepairState] = createSignal<"idle" | "pending" | "done">("idle")
  const unpinDevice = async () => {
    const handler = actions().onUnpinDevice
    if (!handler || !props.sessionID || repairState() === "pending") return
    setRepairState("pending")
    try {
      await handler(props.sessionID)
      setRepairState("done")
    } catch {
      setRepairState("idle")
    }
  }
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
        <Markdown text={props.text} cacheKey={props.messageID} />
        <Show when={props.repair?.type === "unpin-device" && actions().onUnpinDevice}>
          <button
            type="button"
            data-slot="native-notice-repair"
            disabled={repairState() !== "idle"}
            onClick={() => void unpinDevice()}
            style={{
              margin: "0.5rem 0 0",
              padding: "0.375rem 0.625rem",
              "border-radius": "6px",
              border: "1px solid var(--v2-border-border-muted)",
              background: "var(--v2-background-bg-layer-02)",
              color: "var(--v2-text-text-base)",
              cursor: repairState() === "idle" ? "pointer" : "default",
            }}
          >
            {repairState() === "done"
              ? i18n.t("ui.transcript.device.unpinned")
              : repairState() === "pending"
                ? i18n.t("ui.transcript.device.unpinning")
                : i18n.t("ui.transcript.device.unpin")}
          </button>
        </Show>
      </div>
    )
  return (
    <details data-slot="native-notice" data-kind="system">
      <summary>{i18n.t("ui.transcript.context")}</summary>
      <div data-slot="native-notice-body">
        <Markdown text={props.text} cacheKey={props.messageID} />
      </div>
    </details>
  )
}

const PERMISSION_KEY = {
  plan: "ui.transcript.permission.plan",
  ask: "ui.transcript.permission.ask",
  surgical: "ui.transcript.permission.surgical",
  bypass: "ui.transcript.permission.bypass",
  yolo: "ui.transcript.permission.yolo",
} as const

function PermissionChangedMessage(props: { message: SessionMessagePermissionChanged }) {
  const i18n = useI18n()
  const raised = () => props.message.op === "raise"
  return (
    <section
      data-slot="native-permission-card"
      data-direction={props.message.op}
      aria-label={i18n.t("ui.transcript.permission.aria")}
    >
      <div data-slot="native-permission-card-icon" aria-hidden="true">
        {raised() ? "↑" : "↓"}
      </div>
      <div data-slot="native-permission-card-body">
        <div data-slot="native-permission-card-title">
          {i18n.t(raised() ? "ui.transcript.permission.raised" : "ui.transcript.permission.lowered")}
        </div>
        <div data-slot="native-permission-card-levels">
          {i18n.t(PERMISSION_KEY[props.message.previous])} → {i18n.t(PERMISSION_KEY[props.message.mode])}
        </div>
        <blockquote data-slot="native-permission-card-reason">{props.message.justification}</blockquote>
        <div data-slot="native-permission-card-ceiling">
          {i18n.t("ui.transcript.permission.ceiling", { level: i18n.t(PERMISSION_KEY[props.message.ceiling]) })}
        </div>
      </div>
    </section>
  )
}

function CompactionMessage(props: { message: SessionMessageCompaction | SessionMessageCompactionStatus }) {
  const i18n = useI18n()
  const [now, setNow] = createSignal(Date.now())
  const running = () => props.message.type === "compaction-status" && props.message.status === "running"
  createEffect(() => {
    if (!running()) return
    const timer = setInterval(() => setNow(Date.now()), 250)
    onCleanup(() => clearInterval(timer))
  })
  const elapsed = () => seconds(elapsedMs(props.message.time.created, props.message.time.completed, now()))
  const label = () => {
    if (running())
      return i18n.t("ui.transcript.compacting", {
        tokens: Token.estimateFromChars(props.message.generatedChars ?? 0),
      })
    if (props.message.type === "compaction-status")
      return elapsed()
        ? i18n.t("ui.transcript.compaction.failed", { time: elapsed()! })
        : i18n.t("ui.transcript.compaction.failed.short")
    return elapsed() ? i18n.t("ui.transcript.compacted.in", { time: elapsed()! }) : i18n.t("ui.transcript.compacted")
  }
  return (
    <div data-slot="native-compaction">
      <div data-slot="native-compaction-divider" aria-live={running() ? "polite" : undefined}>
        {label()}
      </div>
      <Show when={props.message.type === "compaction" ? props.message.summary.trim() : ""}>
        <details data-slot="native-notice">
          <summary>{i18n.t("ui.transcript.summary")}</summary>
          <div data-slot="native-notice-body">
            <Markdown
              text={props.message.type === "compaction" ? props.message.summary : ""}
              cacheKey={`${props.message.id}:summary`}
            />
          </div>
        </details>
      </Show>
    </div>
  )
}

// ── helpers ─────────────────────────────────────────────────────────────────────

interface ToolMeta {
  title: string
  subtitle?: string
  args?: string[]
}

/** Per-tool label/subtitle/args, ported from the V1 `getToolInfo` switch.*/
function toolMeta(part: SessionMessageAssistantTool, i18n: UiI18n, messages: readonly SessionMessage[]): ToolMeta {
  const input = toolInput(part.state)
  switch (part.name) {
    case "read": {
      const args: string[] = []
      const offset = num(input.offset)
      const limit = num(input.limit)
      if (offset !== undefined) args.push(i18n.t("ui.transcript.tool.read.offset", { value: offset }))
      if (limit !== undefined) args.push(i18n.t("ui.transcript.tool.read.limit", { value: limit }))
      return { title: i18n.t("ui.transcript.tool.read"), subtitle: filePathOf(input), args }
    }
    case "list":
      return { title: i18n.t("ui.transcript.tool.list"), subtitle: basename(input.path) ?? str(input.path) }
    case "glob":
      return { title: i18n.t("ui.transcript.tool.glob"), subtitle: str(input.pattern) }
    case "grep":
      return { title: i18n.t("ui.transcript.tool.grep"), subtitle: str(input.pattern) }
    case "webfetch":
      return { title: i18n.t("ui.transcript.tool.webfetch"), subtitle: str(input.url) }
    case "websearch":
      return { title: i18n.t("ui.transcript.tool.websearch"), subtitle: str(input.query) }
    case "js":
      return { title: i18n.t("ui.transcript.tool.js") }
    case "task":
      return {
        title: str(input.subagent_type) ? cap(str(input.subagent_type)!) : i18n.t("ui.transcript.tool.task"),
        subtitle: part.title?.trim() || fallbackWorkerLabel(str(input.description) ?? ""),
      }
    case "spawn":
      return spawnRow(input, part.title, i18n.t)
    case "wait":
      return waitRow(input, messages, i18n.t)
    case "bash":
      return { title: i18n.t("ui.transcript.tool.bash"), subtitle: str(input.command) }
    // The file-mutating tools read as a compact action plus the file — "Edited pi.c" — and carry NO
    // +N/-M stat inline. The stat was noise on every edit, and the exact diff is one click away in this
    // row's own body (and properly presented in the git-changes tab). Pending input is decoded above,
    // so the target appears as soon as `path` finishes streaming rather than after the mutation settles.
    case "edit":
      return { title: i18n.t("ui.transcript.tool.edit"), subtitle: filePathOf(input) }
    case "write":
      return { title: i18n.t("ui.transcript.tool.write"), subtitle: filePathOf(input) }
    case "apply_patch": {
      const files = Array.isArray(input.files) ? input.files.length : undefined
      return {
        title: i18n.t("ui.transcript.tool.patch"),
        subtitle: files ? i18n.plural("ui.transcript.tool.patch.files", files) : undefined,
      }
    }
    // The agent turning aside to talk to ANOTHER agent — see `colleague-row.ts`, which holds the
    // rule and the test that runs it (this file cannot be imported by `bun test`).
    case "colleague":
      return colleagueRow(input, i18n.t)
    case "skill":
      return { title: str(input.name) ?? i18n.t("ui.transcript.tool.skill") }
    default:
      return { title: part.name }
  }
}

function toolInput(state: SessionMessageAssistantTool["state"]): Record<string, unknown> {
  return toolInputForDisplay(state)
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
