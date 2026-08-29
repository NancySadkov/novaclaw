export * as SessionRunnerLLM from "./llm"

import {
  LLM,
  LLMClient,
  LLMError,
  LLMEvent,
  Message,
  SystemPart,
  isContextOverflowFailure,
  mediaLimitFailure,
  type FinishReason,
  type ProviderErrorEvent,
} from "@novaclaw/llm"
import { Cause, Clock, DateTime, Duration, Effect, Exit, FiberSet, Layer, Option, Semaphore, Stream } from "effect"
import path from "path"
import { AgentV2 } from "../../agent"
import { AgentModelFit } from "../../agent/model-fit"
import { ModelHealth } from "./model-health"
import { Config } from "../../config"
import { ConfigToolRouting } from "../../config/tool-routing"
import { Global } from "../../global"
import { ascending } from "@novaclaw/schema/identifier"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { Location } from "../../location"
import { ProviderCapability } from "../../provider-capability"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import { QuestionV2 } from "../../question"
import { SystemContext } from "../../system-context/index"
import { SystemContextRegistry } from "../../system-context/registry"
import { ToolCatalogueGuidance } from "../../tool-catalogue-guidance"
import { ToolDiscovery } from "../../tool-discovery"
import { SkillGuidance } from "../../skill/guidance"
import { ReferenceGuidance } from "../../reference/guidance"
import { ToolRegistry } from "../../tool/registry"
import { ToolOutputStore } from "../../tool-output-store"
import { SessionContextEpoch } from "../context-epoch"
import { SessionCompaction } from "../compaction"
import { SessionCompactionArchive } from "../compaction-archive"
import { SessionCompactionRequest } from "../compaction-request"
import { SessionEvent } from "../event"
import { SessionHistory } from "../history"
import { SessionInput } from "../input"
import { SessionMessage } from "../message"
import { SessionPatch } from "../patch"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionTodo } from "../todo"
import { SessionComponentRegistry } from "../component-registry"
import { Log } from "@novaclaw/schema/log"
import { SessionStatusEvent } from "@novaclaw/schema/session-status-event"

import { rootSessionType, stanceOf } from "../config-resolve"
import { SessionEffectiveConfig } from "../effective-config"
import { AgentJail } from "../../agent-jail"
import { MessengerStore } from "../../messenger/store"
import { Offline } from "../../offline"
import { PermissionV2 } from "../../permission"
import { PluginV2 } from "../../plugin"
import { SessionScheduler } from "../scheduler"
import { SpawnTool } from "../../tool/spawn"
import { WaitTool } from "../../tool/wait"
import { type RunError, Service } from "./index"
import { SessionRunnerModel } from "./model"
import { SessionMaintenance } from "./maintenance"
import { SystemAccounting } from "./system-accounting"
import { Scratch } from "../../scratch"
import { SystemCompose } from "./system-compose"
import { TierScaffold } from "./tier-scaffold"
import { SessionRecall } from "./recall"
import { MemoryCorrection } from "./memory-correction"
import { Memory } from "../../kb-graph/memory"
import { KbEmbedder } from "../../kb-graph/embedder"
import { MemoryAccessLedger } from "../../kb-graph/access-ledger"
import { MemoryClient } from "../../kb-graph/memory-client"
import { MemoryRanking } from "../../kb-graph/ranking"
import { MemoryRerank } from "../../kb-graph/rerank"
import { MemorySetting } from "../../kb-graph/memory-setting"
import { HarnessConfig } from "./harness-config"
import { StrictDrain } from "./strict-drain"
import { createLLMEventPublisher } from "./publish-llm-event"
import { SessionExecutionAttempt } from "../execution-attempt"
import { attachmentModality, needsCapabilityEvidence, toLLMMessages, unreadableTurnAttachments } from "./to-llm-message"
import { AdhocGuidance } from "../../adhoc-tools/guidance"
import { Affective } from "./affective"
import { SessionDrive } from "./drive"
import { FinishRecovery } from "./finish-recovery"
import { UtilityCap } from "./utility-cap"
import { UtilityPass } from "./utility-pass"
import { ContextPack } from "./context-pack"
import { RequestFootprint } from "./footprint"
import { ContextBudget } from "./context-budget"
import { ShortChat } from "./short-chat"
import {
  detectDoomLoop,
  redirectMessage,
  detectFailureStreak,
  failureStreakMessage,
  detectRunaway,
  RUNAWAY_THRESHOLD,
  runawayMessage,
  toolCallsSinceLastUser,
  announcedToolButCalledNone,
  isEmptyAssistantTurn,
  lastAssistantText,
  shouldReground,
  ANNOUNCED_TOOL_RECOVERY,
  EMPTY_TURN_RECOVERY,
  EMPTY_TURN_DIAGNOSTIC,
  REGROUND_NUDGE,
} from "./doom-loop"
import { TextualCall } from "./textual-call"
import { Introspection } from "./introspection"
import { MAX_STEPS_PROMPT } from "./max-steps"
import { ProviderRetry } from "./provider-retry"
import { ProviderDispatch } from "./provider-dispatch"
import { TurnTiming } from "./turn-timing"
import { ProviderStreamLiveness } from "./provider-stream-liveness"
import { Quality } from "./quality"
import { SessionQualityCheck } from "../quality-check"
import { QualityProvision } from "./quality-provision"
import { Snapshot } from "../../snapshot"
import { AppProcess } from "../../process"
import { ChildProcess } from "effect/unstable/process"
import { makeLocationNode } from "../../effect/app-node"
import { llmClient } from "../../effect/app-node-platform"
import { AttachmentPaths } from "./attachment-paths"
import { TodoReminder } from "./todo-reminder"
import { CalloutPolicy } from "../../callout-policy"
import { ProjectGrounding } from "./project-grounding"
import { UnfinishedSet } from "./unfinished-set"
import { UnjoinedChildren } from "./unjoined-children"
import { SessionTitle } from "../title"
import { lastRealUserText } from "../steer-provenance"
import { ColleagueHop } from "../colleague-hop"
import { ColleagueTool } from "../../tool/colleague"
import { ColleagueBound } from "../colleague-bound"
import { VisionCopy } from "./vision-copy"

// Ordering can only choose among retrieved candidates — fetch wider than the recall budget.

/**
 * Runs one durable coding-agent Session until it settles.
 *
 * Keep this as orchestration over smaller collaborators rather than rebuilding the legacy
 * `SessionPrompt` monolith. Implement the unchecked items in small reviewed slices:
 *
 * - Session ownership and controls
 *   - [x] Coordinate one local active drain per Session; explicit resumes join and prompt wakeups coalesce.
 *   - [ ] Replace local ownership with durable multi-node ownership when clustered.
 *   - [ ] Mark busy, retrying, idle, interrupted, or terminal-failure status durably.
 *   - [ ] Honor interruption and reject stale work after runtime attachment replacement.
 *   - [x] Honor optional agent step limits.
 *   - [ ] Bound provider retries and repeated identical tool calls.
 *
 * - Runtime context assembly
 *   - Track V1 runtime-context parity canonically in `specs/v2/session.md`.
 *
 * - One provider turn
 *   - [x] Translate every projected V2 Session message variant into canonical
 *     `@novaclaw/llm` messages.
 *   - [ ] Resolve policy-filtered built-in, MCP, plugin, and structured-output tool definitions.
 *   - [x] Stream each provider turn through the shared provider-dispatch bracket.
 *   - [x] Persist assistant text and usage events incrementally as they arrive.
 *   - [ ] Persist snapshots, patches, and retry notices incrementally as they arrive.
 *   - [x] Persist reasoning, provider errors, and tool-call events incrementally as they arrive.
 *
 * - Tool settlement and continuation
 *   - [x] Durably record each tool call before side effects begin.
 *   - [x] Authorize and execute recorded local calls through a core-owned registry hook.
 *   - [x] Persist typed success, failure, and provider-executed tool outcomes.
 *   - [x] Start each recorded local call eagerly and await all settlements before continuation.
 *   - [ ] Add scoped runtime context, progress updates, attachment normalization,
 *     plugins, and cancellation settlement.
 *   - [x] Reload projected history and start the next explicit provider turn after local tool results.
 *   - [x] Continue for durable user steering accepted during an active provider turn.
 *   - [ ] Continue for compaction or another continuation condition when required.
 *
 * - Post-run maintenance
 *   - [ ] Settle final status and expose durable output events to replayable consumers.
 *   - [ ] Coalesce streamed deltas and add covering projected-history indexes.
 *   - [x] Auto-title after the drain settles (SessionTitle; owner directive — the title
 *     grounds the user and the model across compactions, generated while the user reads).
 *   - [ ] Update summaries, compaction state, and cleanup in bounded background work.
 *
 * Use `ProviderDispatch` for each provider turn. Keep tool execution and continuation here.
 * Durable continuation recovery remains a separate future slice with an explicit retry policy.
 *
 * The current slice loads V2 history, translates it, resolves a model through a core service, and persists one
 * provider turn. Registry definitions are advertised, local tool calls are settled durably, and an
 * explicit loop starts the next provider turn after local settlement. Configured agent step limits bound the loop.
 */

/** How often the generation loop may ask the DB whether a steer has landed. Hot path — keep it coarse. */
const STEER_POLL_MS = 400

/**
 * When a harness stage stops being ordinary and becomes worth recording.
 *
 * ⚠️ Deliberately the same number as the UI's `LONG_STAGE_MS`
 * (`session-ui/src/v2/components/turn-receipt.ts`), and deliberately NOT shared with it: that one
 * decides when to explain a wait to a person, this one decides when to keep evidence for us. They
 * agree today because the same 10 s is the answer to both questions. If one moves, the other does
 * not have to — but say so where you move it, because a reader will assume they are one knob.
 */
const SLOW_STAGE_MS = 10_000

/**
 * How long the recall re-ranker may hold up the user's turn before we keep the deterministic order.
 *
 * Sized against what the pass is worth, not against what a model might want: it re-orders at most a
 * handful of already-retrieved memories, the fallback ordering is computed before the call, and the
 * user is staring at "Choosing useful memories" the whole time. Thinking-off on the current test
 * model this pass lands well inside a second, so the deadline only fires when something is wrong —
 * a model ignoring `enable_thinking:false`, a cold server, a device under load.
 */
const RERANK_DEADLINE = "4 seconds"

/**
 * Write the just-compacted conversation into the colleague's own memory as searchable passages.
 *
 * 🔴 One chat per colleague means the chat never ends, so compaction is the only moment the older
 * half of its working life would otherwise stop being reachable — the summary is a paragraph, the
 * conversation was hours. The decisions (whether to archive at all, what the passages are called,
 * what counts as content) live in `session/compaction-archive.ts` where tests reach them; this is
 * the wiring.
 *
 * ⚠️ Best-effort by design, and the caller ignores its failure: the compaction is already durable
 * when this runs, and an unreachable embedder or a slow store must not turn a successful compaction
 * into a failed turn. A missing archive costs recall; a thrown one would cost the turn.
 */
/** Swallow an archive failure so the compaction stands — but SAY it happened. */
const reportArchiveFailure =
  (sessionID: SessionSchema.ID, agentID: string | undefined) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Log.event("session.compaction.archive.failed", {
          "session.id": sessionID,
          // "(none)" rather than an omitted key: a colleague-less session is a real case (the
          // archive skips it), and an absent attribute would read as "we did not record which".
          "agent.id": agentID ?? "(none)",
          // `Log.fault`, not `Cause.pretty(...).slice(...)`: seam 1 of `log-attributes.test.ts` —
          // one normalization for every fault column, so a reader never has to know which site
          // truncated and which did not.
          "archive.reason": Log.fault(cause),
        }),
      ),
      Effect.asVoid,
    )

const archiveCompactedChat = Effect.fn("SessionRunner.archiveCompactedChat")(function* (input: {
  readonly entries: readonly SessionCompaction.Entry[]
  readonly agent: AgentV2.Selection
  readonly memory: MemoryClient.Interface
  readonly session: { readonly id: SessionSchema.ID; readonly title?: string | undefined }
}) {
  const agentID = input.agent.id
  if (!agentID) return
  if (
    !SessionCompactionArchive.shouldArchive({
      memory: input.agent.info?.memory,
      archiveChats: input.agent.info?.archiveChats,
    })
  )
    return
  const passages = SessionCompactionArchive.plan({
    messages: input.entries.map((entry) => entry.message),
    title: input.session.title,
    at: new Date(),
  })
  if (passages.length === 0) return
  for (const passage of passages) {
    // Embedded on write so the vector leg can reach it later; degrades to FTS-only when no device is
    // configured, exactly as `kb ingest` does.
    const embedding = yield* Effect.promise(() => KbEmbedder.embedOne(passage.text))
    yield* input.memory
      .addMemory({
        id: passage.id,
        kind: "passage",
        text: passage.text,
        name: passage.label,
        // The colleague's OWN cabinet — not `global`. An archived conversation is the most personal
        // thing a colleague holds, and putting it in the household scope would hand every other
        // agent a transcript of work they were not part of.
        scope: `agent:${agentID}`,
        relation: "staged",
        source: "chat-archive",
        ...(embedding === undefined ? {} : { embedding }),
      })
      .pipe(Effect.ignore)
  }
  yield* Log.event("session.compaction.archived", {
    "session.id": input.session.id,
    "agent.id": agentID,
    "archive.passages": passages.length,
  })
})

/**
 * May the generation loop check for (and cut on) a steer right now?
 *
 * Extracted and exported ONLY so the safety invariant is testable: once a tool call has been emitted this
 * step, the answer must be `false` forever after — a tool settles inside the stream loop, and cutting there
 * risks a half-written file or a half-sent message. Reasoning and answer text carry no such risk, which is
 * the whole reason a steer may interrupt them.
 */
export const shouldCheckForSteer = (input: {
  readonly sawToolCall: boolean
  readonly alreadyCut: boolean
  readonly now: number
  readonly lastCheck: number
}): boolean => !input.sawToolCall && !input.alreadyCut && input.now - input.lastCheck >= STEER_POLL_MS

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const llm = yield* LLMClient.Service
    const agents = yield* AgentV2.Service
    const tools = yield* ToolRegistry.Service
    const models = yield* SessionRunnerModel.Service
    const store = yield* SessionStore.Service
    // THE config entry point (`session/effective-config.ts`). Every reader in this runner resolves
    // through it, which is what lets a folder's tune reach the turn at all.
    const effective = yield* SessionEffectiveConfig.Service
    const location = yield* Location.Service
    const systemContext = yield* SystemContextRegistry.Service
    const toolCatalogueGuidance = yield* ToolCatalogueGuidance.Service
    const skillGuidance = yield* SkillGuidance.Service
    const referenceGuidance = yield* ReferenceGuidance.Service
    const adhocGuidance = yield* AdhocGuidance.Service
    const config = yield* Config.Service
    const snapshots = yield* Snapshot.Service
    // Strict's half of the ONE host-execution gate (ruling 6): the chain-root type comes from
    // `store`, the messenger trust of the turn from here, and the OFF-C egress overlay from the
    // SHARED offline service (never a second policy load — it would drift from the HttpClient's).
    const messengerStore = yield* MessengerStore.Service
    const offline = yield* Offline.Service
    const scheduler = yield* SessionScheduler.Service
    const compactionRequests = yield* SessionCompactionRequest.Service
    const memory = Memory.client(yield* Memory.node.service)
    const maintenance = yield* SessionMaintenance.Service
    const components = yield* SessionComponentRegistry.Service
    const db = (yield* Database.Service).db
    /**
     * B7 tier-1 / ruling 3 — the harness configuration, derived ONCE PER TURN and never at layer
     * scope. This used to be `const configEntries = yield* config.entries()` right here, with every
     * runtime-settings derivation closed over for the life of the location. `Config.entries()` reading through to the settings
     * store did not help them: the read happened once, so every one of those values stayed frozen at
     * location boot and a Settings edit still needed a restart to take.
     *
     * ⚠️ It is an `Effect.fn`, i.e. a suspended computation, NOT a value. That is the invariant:
     * turning it back into `const harness = yield* …` here would re-freeze every value silently — same
     * names, same types, same call sites, green compile. `test/runner-config-per-turn.test.ts`
     * ratchets it.
     *
     * The B4 note that used to live here still holds: the user profile is not injected into the
     * system prompt — the model reads it ON DEMAND via the `profile` tool (tool/profile.ts).
     */
    const harnessConfig = Effect.fn("SessionRunner.harnessConfig")(function* () {
      const derived = HarnessConfig.derive(yield* config.entries(), {
        notesDir: path.join(Global.Path.data, "notes"),
        platform: process.platform,
        ...(process.env.COMSPEC === undefined ? {} : { comspec: process.env.COMSPEC }),
      })
      // Built off `derived.entries`, i.e. the SAME read — a second `config.entries()` inside one
      // turn could hand the compactor a different snapshot than the system prompt was composed from.
      return {
        ...derived,
        compaction: SessionCompaction.make({
          events,
          llm,
          config: derived.entries,
          prefixHash: (sessionID, prefixSeq) => SessionHistory.prefixHash(db, sessionID, prefixSeq).pipe(Effect.orDie),
        }),
      }
    })
    /** One turn's frozen view of the runtime-editable settings. Threaded, never re-derived per use. */
    type Harness = HarnessConfig.Derived & { readonly compaction: ReturnType<typeof SessionCompaction.make> }
    // QE (QE-B): the deterministic 5-step verify loop over the PROVISIONED commands.
    // Default OFF; failures steer the agent to fix and re-run (observation, never a halt).
    const appProcess = yield* AppProcess.Service
    const permission = yield* PermissionV2.Service
    const plugins = yield* PluginV2.Service
    const runQualityCheck = Effect.fn("SessionRunner.qualityCheck")(function* (
      sessionID: SessionSchema.ID,
      shell: string,
      check: { readonly label: string; readonly command: string; readonly timeoutMs?: number },
    ) {
      /**
       * The DURABLE record of this run — `todo/verified-autonomy.md` V1's only new write.
       *
       * ⚠️ Best-effort, and that is a contract rather than laziness: this is bookkeeping inside a
       * drain step whose own header says *"a broken check command must never break the drain it
       * guards"*. A write that could fail the drain would make the evidence table a new way for the
       * harness to break the thing it is watching.
       *
       * ⚠️ It records ALONGSIDE the log line, never instead of it. The log is how a human reads what
       * happened live; the table is what a receipt composes from. Replacing one with the other would
       * lose a reader.
       */
      const evidence = (
        outcome: SessionQualityCheck.Outcome,
        rest: {
          readonly at: number
          readonly exitCode?: number
          readonly timedOut?: boolean
          readonly durationMs?: number
        },
      ) =>
        SessionQualityCheck.record(db, {
          sessionID,
          label: check.label,
          command: check.command,
          outcome,
          ...rest,
        }).pipe(
          Effect.catchCause((cause) =>
            Log.event("session.quality.check.errored", {
              "session.id": sessionID,
              "session.cause": Log.fault(cause),
            }),
          ),
        )
      // ⚠️ THE EXECUTION GATE, and it must be spelled `bash` — the same argument
      // `tool/quality-provision.ts` records at its own verify loop, arrived at from the other side.
      // This runs a command string through the agent shell with the host user's authority, and the
      // string is not necessarily the user's: `quality_provision` with `verify: false` PERSISTS
      // model-supplied commands without ever running them, and they execute here instead. Until now
      // they executed with no permission assert at all — so `plan` mode, which denies `bash` and
      // promises read-only, still had the harness running shell commands after every turn.
      //
      // `assert`, not `ask`: `ask` publishes a consent card and registers it as pending, so a
      // background maintenance step calling it would litter the dock with cards nobody awaits.
      // `assert` resolves to allow under the shipped `bypass` default (no card at all), parks on a
      // real card under an `ask` posture — where a human IS present to answer it, and one
      // "always" covers that command for every tool that runs it, this one included — and
      // deny-fasts under an unattended root (B4c) instead of hanging the drain.
      //
      // Resources and `save` are the command STRING, matching `tool/bash.ts` and
      // `quality-provision.ts`: one vocabulary, so an "always allow" answered once is the same
      // grant whichever surface spends it. `agent` is deliberately omitted — `configured()` falls
      // back to the session's own agent, which is exactly whose authority this runs under.
      const refused = yield* permission
        .assert({ action: "bash", resources: [check.command], save: [check.command], sessionID })
        .pipe(
          Effect.as(false),
          Effect.catchTag("PermissionV2.DeniedError", () => Effect.succeed(true)),
        )
      if (refused) {
        // A policy refusal is not a broken check — the caller's `errored` log would misreport it as
        // one, and the harness must not steer the model about the user's own posture.
        yield* Log.event("session.quality.check.refused", {
          "session.id": sessionID,
          "session.quality.label": check.label,
        })
        yield* evidence("refused", { at: yield* Clock.currentTimeMillis })
        return false
      }
      const policy = CalloutPolicy.qualityGate(check.timeoutMs ?? 60_000)
      const command = ChildProcess.make(check.command, [], {
        cwd: location.directory,
        shell,
        stdin: "ignore",
        detached: process.platform !== "win32",
        forceKillAfter: Duration.seconds(3),
      })
      const startedAt = yield* Clock.currentTimeMillis
      const result = yield* appProcess
        .run(command, {
          combineOutput: true,
          timeout: Duration.millis(policy.timeoutMs),
          maxOutputBytes: 32_768,
        })
        .pipe(
          Effect.map((run) => ({ ok: true as const, run })),
          Effect.catchTag("AppProcessError", (error) => Effect.succeed({ ok: false as const, error })),
        )
      const failed = !result.ok
        ? {
            output: String(result.error.stderr ?? result.error.message ?? ""),
            timedOut: /Timed out/i.test(
              String((result.error.cause as { message?: string } | undefined)?.message ?? ""),
            ),
          }
        : result.run.exitCode !== 0
          ? { output: result.run.output?.toString("utf8") ?? "", exit: result.run.exitCode }
          : undefined
      const finishedAt = yield* Clock.currentTimeMillis
      if (!failed) {
        yield* Log.event("session.quality.check.passed", {
          "session.id": sessionID,
          "session.quality.label": check.label,
        })
        yield* evidence("passed", {
          at: finishedAt,
          durationMs: finishedAt - startedAt,
          ...(result.ok ? { exitCode: result.run.exitCode } : {}),
        })
        return false
      }
      yield* Log.event("session.quality.check.failed", {
        "session.id": sessionID,
        "session.quality.label": check.label,
      })
      yield* evidence("failed", {
        at: finishedAt,
        durationMs: finishedAt - startedAt,
        // ⚠️ `exitCode` stays ABSENT when the process never produced one (a spawn fault or a
        // timeout kill). Writing 0 there would say "exited cleanly" on a check that failed.
        ...("exit" in failed && typeof failed.exit === "number" ? { exitCode: failed.exit } : {}),
        ...(failed.timedOut === true ? { timedOut: true } : {}),
      })
      yield* SessionInput.steer(
        db,
        events,
        sessionID,
        Quality.failureMessage({ label: check.label, command: check.command, ...failed }),
      )
      return true
    })
    const getSession = Effect.fn("SessionRunner.getSession")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
      return session
    })

    const getContext = Effect.fn("SessionRunner.getContext")(function* (sessionID: SessionSchema.ID) {
      return yield* store.context(sessionID)
    })

    // P3: per-session mood state for the affective engine (in-memory per location; bounded). The
    // mood MAP is location state, not config — only the affective SETTINGS moved to per-turn.
    const moods = new Map<string, Affective.Mood>()
    const MAX_MOODS = 500
    const rememberMood = (sessionID: string, mood: Affective.Mood) => {
      if (moods.size >= MAX_MOODS && !moods.has(sessionID)) moods.clear()
      moods.set(sessionID, mood)
    }
    // A9.5: delivery state for provider-only checklist reminders. The checklist itself is the durable
    // `plan` component set; this bounded map only prevents repeated projection within one message bucket.
    // A process restart may repeat one reminder, which is safer than silently skipping a horizon.
    const todoReminderStates = new Map<string, TodoReminder.ReminderState>()
    const MAX_TODO_REMINDER_STATES = 500
    const rememberTodoReminder = (sessionID: string, state: TodoReminder.ReminderState) => {
      if (todoReminderStates.size >= MAX_TODO_REMINDER_STATES && !todoReminderStates.has(sessionID))
        todoReminderStates.clear()
      todoReminderStates.set(sessionID, state)
    }
    // Fast Chat: provider-only cwd/project horizons. Like todo reminders, this map is only a bounded
    // delivery latch; a restart may safely repeat one reminder instead of silently losing grounding.
    const projectGroundingStates = new Map<string, ProjectGrounding.State>()
    const MAX_PROJECT_GROUNDING_STATES = 500
    const rememberProjectGrounding = (sessionID: string, state: ProjectGrounding.State) => {
      if (projectGroundingStates.size >= MAX_PROJECT_GROUNDING_STATES && !projectGroundingStates.has(sessionID))
        projectGroundingStates.clear()
      projectGroundingStates.set(sessionID, state)
    }
    // QE-A: sessions already nudged to provision quality commands (once per session).
    const provisionNudged = new Set<string>()

    // P2 (2A/2B): the out-of-band judge call. Best-effort by design — ANY failure (judge
    // model unreachable, resolution error, empty reply) is logged and swallowed; the judge
    // must never break the session it watches. Returns a small text completion.
    const judgeCompletion = Effect.fn("SessionRunner.introspectionJudge")(function* (
      sessionID: SessionSchema.ID,
      introspection: Introspection.Resolved,
      prompt: string,
    ) {
      const session = yield* getSession(sessionID)
      const model = yield* models.resolve(
        introspection.model === undefined
          ? session
          : {
              ...session,
              model: {
                providerID: ProviderV2.ID.make(introspection.model.providerID),
                id: ModelV2.ID.make(introspection.model.id),
              },
            },
      )
      // ⚠️ **This pass used to be the MOST exposed of the three, and 2026-08-11 fixed the cause
      // rather than the symptom.** It alone carried no `NO_THINKING` overlay, so it ran
      // thinking-ENABLED: the 2026-08-06 table puts the empty-completion cliff at ~450 tokens in that
      // mode against a 512 cap — about 1.65× margin — where the overlaid passes sit near 100 and have
      // roughly 4×. It was therefore both the likeliest to burn its whole budget reasoning and return
      // nothing, and (via `memory-rerank`) the slowest thing the user watches during a turn, under the
      // label "Choosing useful memories". Nothing here wants reasoning: the callers ask for a yes/no
      // verdict, one short interjection, and an ordering of numbers. `UtilityCap` below stays the
      // mechanical backstop for models that ignore the request.
      const chunks: string[] = []
      let cap = 512
      for (let attempt = 0; ; attempt++) {
        chunks.length = 0
        let finish: FinishReason | undefined
        const attemptCap = cap
        yield* llm
          .stream(
            LLM.request({
              model,
              messages: [Message.user(prompt)],
              tools: [],
              generation: { maxTokens: attemptCap },
              http: { body: UtilityPass.NO_THINKING }, // else the budget goes to reasoning and the reply is EMPTY
            }),
          )
          .pipe(
            Stream.runForEach((event) => {
              if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
              else if (event.type === "finish") finish = event.reason
              return Effect.void
            }),
          )
        const verdict = UtilityCap.decide({ finish, text: chunks.join(""), attempt, cap: attemptCap })
        if (!verdict.retry) break
        cap = verdict.cap
      }
      return chunks.join("")
    })

    const introspect = Effect.fn("SessionRunner.introspect")(function* (
      sessionID: SessionSchema.ID,
      introspection: Introspection.Resolved,
    ) {
      const excerpt = Introspection.judgeExcerpt(yield* getContext(sessionID))
      if (!excerpt) return
      const verdict = yield* judgeCompletion(
        sessionID,
        introspection,
        Introspection.judgePrompt(introspection.prompt, excerpt),
      )
      if (!Introspection.isYesVerdict(verdict)) return
      let interjection = introspection.interjection
      if (introspection.generateInterjection) {
        const generated = yield* judgeCompletion(sessionID, introspection, Introspection.generatePrompt(excerpt)).pipe(
          Effect.orElseSucceed(() => ""),
        )
        if (generated.trim()) interjection = generated.trim()
      }
      yield* Log.event("session.introspection.interject", { "session.id": sessionID })
      yield* SessionInput.steer(db, events, sessionID, interjection)
    })
    // Auto-title (owner directive): runs right AFTER the drain settles — the user is busy
    // reading the response, the model is idle — because the title grounds BOTH the user (the
    // chat list) and the model across compactions (the title survives them). Fires only while
    // the title is still a creation default, so a user rename is never clobbered and a failed
    // attempt simply retries at the next drain end. Seeds from the first REAL user message
    // (harness steers carry the 1N provenance prefix and never title a session).
    // Utility calls ask for a short string or a JSON array — never for extended reasoning. Left
    // unconstrained, reasoning models frequently spend the ENTIRE token
    // budget reasoning and return EMPTY content, which parses to "nothing to record" and silently
    // no-ops the whole pass.
    //
    // MEASURED 2026-07-20 against `dgx-spark/qwen3.6-35b` (the PrismaQuant-4.75bit build), shipped
    // extraction prompt:
    //   max_tokens= 512 -> finish=stop,   completion= 348, content 132 chars (valid JSON)
    //   max_tokens=2048 -> finish=length, completion=2048, content 0 chars
    //   max_tokens=4096 -> finish=length, completion=4096, content 0 chars
    // That table was read as an INVERSION — "a bigger output limit is WORSE (a runaway thinking
    // loop)".
    //
    // ⚠️ RE-MEASURED 2026-08-06 against `holo3.1` (Hcompany/Holo-3.1-35B-A3B-NVFP4, the current test
    // model per AGENTS.md), same prompt, temperature 0. **THE INVERSION DID NOT SURVIVE.** Above the
    // cliff a bigger cap is NEUTRAL, not worse — the model stops on its own and the answers are
    // byte-identical:
    //   thinking ENABLED (no chat_template_kwargs):     <=384 -> finish=length, 0 content chars
    //                                                    512/2048/4096 -> finish=stop, 260-310 completion, valid JSON
    //   thinking DISABLED (the NO_THINKING overlay):     64 -> finish=length
    //                                                    128..4096 -> finish=stop, ~126 completion, valid JSON
    // So the real mechanism is a CLIFF, not an inversion: a reasoner cut off mid-think returns
    // NOTHING rather than something partial, and where the cliff sits depends entirely on whether it
    // is reasoning. The 2026-07-20 runaway was a property of that BUILD, not of reasoning models.
    // ⚠️ Do not re-derive "bigger is worse" from the first table — it is kept for provenance, not as
    // current behaviour. Any change here needs a fresh table naming the build it was taken on.
    // ⚠️ `enable_thinking:false` IS honoured by holo3.1 (reasoning chars drop to 0 and latency
    // roughly halves, ~3.5s -> ~1.7s). That is a per-model fact and not a guarantee — the standing
    // ruling that the HARNESS enforces no-thinking itself exists precisely because a growing class of
    // models ignores the flag. It stays a cheap first line, never the only one.
    //
    // Auto-title therefore uses the provider-neutral stages of the shared
    // ReasoningBudget controller first: observe reasoning tokens, stop at checkpoints, and nudge the
    // model toward its tiny answer. Its final mechanical backstop remains the best-effort
    // `chat_template_kwargs` switch for providers that support it. The other utility passes still use
    // that direct switch and should migrate through the same controller independently.
    const failInterruptedTools = Effect.fn("SessionRunner.failInterruptedTools")(function* (
      sessionID: SessionSchema.ID,
      faultMessage = "Tool execution interrupted",
    ) {
      for (const message of yield* getContext(sessionID)) {
        if (message.type !== "assistant") continue
        for (const tool of message.content) {
          if (tool.type !== "tool" || (tool.state.status !== "pending" && tool.state.status !== "running")) continue
          yield* events.publish(SessionEvent.Tool.Failed, {
            sessionID,
            timestamp: yield* DateTime.now,
            assistantMessageID: message.id,
            callID: tool.id,
            // The tag is the STRUCTURAL answer to "was this a fault or a stop?". Without it the
            // transcript had to sniff `/interrupted/i` out of the sentence to decide between a
            // calm "Interrupted" divider and a red error box — which is unlocalisable, and wrong
            // the moment a provider's own message happens to contain the word. `message` stays
            // exactly as it was: the tag is additional structure, never a replacement.
            error: { type: "unknown", _tag: "Interrupted", message: faultMessage },
            provider: {
              executed: tool.provider?.executed === true,
              ...(tool.provider?.metadata === undefined ? {} : { metadata: tool.provider.metadata }),
            },
          })
        }
      }
    })

    const awaitToolFibers = (fibers: FiberSet.FiberSet<void, ToolOutputStore.Error>) =>
      Effect.raceFirst(FiberSet.join(fibers), FiberSet.awaitEmpty(fibers))

    // Match V1: dismissing a question halts the loop instead of becoming model-facing tool output.
    const isQuestionRejected = (cause: Cause.Cause<unknown>) =>
      cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect instanceof QuestionV2.RejectedError)

    /**
     * What an endpoint told us about its per-request IMAGE CAP, keyed `providerID/modelID`.
     *
     * 🔴 Measured 2026-08-19: a session that read four images died on the fourth with
     * `At most 3 image(s) may be provided in one prompt`, and — this is the defect — every LATER turn
     * re-lowered the same history and re-failed identically. A dead-end, which "the UI never crashes
     * to a dead-end" forbids.
     *
     * ⚠️ **In-process, deliberately, and this is a bounded claim rather than a shortcut.** A
     * persisted verdict is a claim about an ENDPOINT, and `provider-capability.ts` spells out what
     * that costs to get right: a fingerprint over endpoint+model+protocol, a three-state discipline,
     * and a rule for forgetting it when the server moves. A cap learned here is worth exactly one
     * process lifetime — it saves every later turn in the session one rejected request, and a
     * restart re-learns it at the price of a single 400 that costs no prefill. Promoting it to the
     * capability store is `todo/vision.md` work; guessing a default for a stranger's endpoint is not.
     */
    const discoveredImageLimits = new Map<string, number>()
    /**
     * What the user asked for, decided ONCE per session and kept for the life of the process.
     *
     * 🔴 `asksForSet`/`requestedLimit` describe the user's words, which cannot change while the drive
     * runs — but the context they were read from shrinks. Compaction removes the original prompt,
     * `lastRealUserText` stops returning it, and the drive concludes it was never a set request:
     * measured run 11 as `asked: false` with ~290 files still to go, and it is the ~100 ceiling every
     * run in that task hit.
     *
     * ⚠️ Session-scoped rather than drain-scoped, because a drain local does NOT survive this. Every
     * steer admits a prompt and starts a new drain; run 12 had three, and a per-drain latch re-derived
     * from the compacted window each time and never fired. Same lifetime as `discoveredImageLimits`
     * above: this process, no schema, and a restart simply re-derives while the prompt is still there.
     */
    const setRequests = new Map<string, { readonly asked: boolean; readonly limit?: number }>()
    /**
     * Every file this SESSION has opened for the current set request, accumulated across drains.
     *
     * 🔴 `toolCallsSinceLastUser` counts from the last real user turn, and compaction moves that
     * boundary — so the coverage the drive reads collapses to the last few reads. Measured run 13:
     * `opened` went 12 → 1 → 3 → 38 → 1 → 36, and the drive told a model that had already described
     * ~100 icons that 399 remained, sending it back to `icon_001`. 180 read calls, 100 distinct.
     *
     * ⚠️ A half-corrected controller is worse than a stopped one. With the request latched but
     * coverage still per-window, the drive kept steering — backwards — and scored WORSE than the run
     * where it went quiet (67 grounded against 192).
     */
    const setOpened = new Map<string, Set<string>>()
    /**
     * Consecutive steer rounds that opened nothing new, per session.
     *
     * 🔴 The THIRD value in this drive to be found in a drain local, and it failed the same way: every
     * steer admits a prompt and starts a new drain, so `barren` reset to 0 each round and never
     * reached `MAX_BARREN_ROUNDS`. Measured run 15 — `opened` stuck at 199 while the drive kept
     * steering through rounds 96, 97, 98, spending the remaining budget on a model that had stopped
     * opening files.
     *
     * ⚠️ The stop condition is the one piece of this drive that MUST outlive a drain: it exists
     * precisely to notice that several rounds in a row achieved nothing, and a per-drain counter can
     * only ever see one.
     */
    const setBarrenBySession = new Map<string, { barren: number; lastOpened: number }>()
    /**
     * Every CHILD this session has joined — the ids it called `wait` on and got an answer for.
     *
     * 🔴 Session-scoped for the reason the three maps above it are, and it is not a style choice: a
     * `wait` call sits in the transcript window, compaction rewrites that window, and a drain-local
     * set would therefore forget joins the session really made and steer the parent to re-join
     * children it already read. The measured version of this trap cost the set drive three separate
     * corrections (`setRequests`, `setOpened`, `setBarrenBySession` all carry the same note).
     *
     * ⚠️ Accumulate-only, exactly like `setOpened`: a join is something the session HAS DONE, and no
     * later read of a shrunken window may take it back.
     */
    const childrenJoined = new Map<string, Set<string>>()
    /**
     * How many times this session has been steered back to its unaccounted children. Bounded by
     * `UnjoinedChildren.MAX_RESTART_ROUNDS` — a restart can itself spawn a child that fails, so this
     * drive needs a ceiling for the same reason the set drive does, and session-scoped for the same
     * reason: every steer admits a prompt and starts a new drain, so a drain-local counter resets
     * before it can ever reach its bound.
     */
    const childRestartRounds = new Map<string, number>()
    /**
     * ⚠️ **`models.ref` is declared `… | undefined` and really is undefined in practice**, so this
     * takes an optional and answers `undefined` rather than dereferencing.
     *
     * 🔴 The first version took a required reference. It compiled, `tsgo -b` was clean, and every
     * runner test hung for 5 s and timed out — 102 of them — because the test seam's `ref` defaults
     * to `undefined` and `${reference.providerID}` threw inside the turn, so the turn never settled.
     * A raw failure count would have read as one of this platform's known runner quirks; what found
     * it was reverting `llm.ts` alone to its pre-change version and watching 7 failures become 7
     * passes. **An accessor whose type says `| undefined` means it, and the seams are where it is
     * undefined most often.**
     */
    const imageLimitKey = (reference: { readonly providerID: string; readonly id: string } | undefined) =>
      reference === undefined ? undefined : `${reference.providerID}/${reference.id}`

    type TurnTransition =
      // Automatic compaction completed; rebuild the request from compacted history.
      | { readonly _tag: "ContinueAfterCompaction"; readonly step: number }
      // Overflow compaction completed; rebuild once through the path without overflow recovery.
      | { readonly _tag: "ContinueAfterOverflowCompaction"; readonly step: number }
      // The endpoint named its image cap; re-lower this same turn under it. Distinct from the
      // overflow arm because the recovery differs: compaction summarises TEXT and removes no image.
      | { readonly _tag: "RetryUnderImageBudget"; readonly step: number }

    class TurnTransitionError extends Error {
      constructor(readonly transition: TurnTransition) {
        super()
      }
    }

    const continueAfterCompaction = (step: number) => new TurnTransitionError({ _tag: "ContinueAfterCompaction", step })
    const retryUnderImageBudget = (step: number) => new TurnTransitionError({ _tag: "RetryUnderImageBudget", step })
    const continueAfterOverflowCompaction = (step: number) =>
      new TurnTransitionError({ _tag: "ContinueAfterOverflowCompaction", step })

    const loadSystemContext = (agent: AgentV2.Selection, sessionID: SessionSchema.ID, shortChat = false) =>
      shortChat
        ? Effect.succeed(SystemContext.empty)
        : Effect.all(
            [
              systemContext.load(),
              skillGuidance.load(agent),
              referenceGuidance.load(),
              adhocGuidance.load(sessionID),
              toolCatalogueGuidance.load(),
            ],
            { concurrency: "unbounded" },
          ).pipe(Effect.map(SystemContext.combine))

    /**
     * The pre-turn assembly, shared by `runTurnAttempt` and `runManualCompaction`.
     *
     * ⚖️ **Why this is one function and not a copied prefix.** Both callers must answer the same six
     * questions in the same order before anything else can happen — is this session OURS · what does
     * the config-inheritance walk decide · which agent · which context epoch · which model · which
     * history — and the manual-compaction copy had already drifted: it resolved its model from a
     * session overlay carrying `model` but not `device`. That difference is inert (`resolve` reads
     * only `session.model`; `device` is cashed by `SessionRunnerModel.device`, which compaction never
     * calls), which is exactly why it survived — a divergence nothing can observe is a divergence
     * nobody fixes, until the day something observes it.
     *
     * The two callers differ in three things, and each is a PARAMETER rather than a fork:
     *
     *  - **whose session it is.** Returning `undefined` lets the drain `Effect.interrupt` and the
     *    compaction cycle plainly `return`, instead of this function guessing which one is wanted.
     *  - **whether a failure is spoken.** `onFailure` taps the four fallible steps. The drain surfaces
     *    a calm Synthetic notice (these run before any assistant row exists, so `step.failed` cannot
     *    carry them and the turn would fail silently); the compaction cycle has its own outer notice
     *    and passes nothing.
     *  - **input promotion.** It sits BETWEEN `initialize` and the `prepare` fallback deliberately —
     *    the epoch update must publish AFTER any user message promoted into this turn. A caller with
     *    no promotion pays nothing and gets `promoted: 0`.
     */
    const prepareTurn = Effect.fn("SessionRunner.prepareTurn")(function* (
      sessionID: SessionSchema.ID,
      options: {
        readonly promotion?: SessionInput.Delivery | undefined
        readonly onFailure?: ((error: unknown) => Effect.Effect<void>) | undefined
      } = {},
    ) {
      const onFailure = options.onFailure
      const tap = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        onFailure === undefined ? effect : effect.pipe(Effect.tapError(onFailure))
      const session = yield* getSession(sessionID)
      // Not ours. The caller decides what that means — see the header.
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return undefined
      // Agent, catalog, command and reference state are materialized by one deferred plugin boot
      // batch. Selecting the agent before that latch opened made the FIRST worker turn miss global
      // permission rules even though model resolution (later in this function) correctly waited.
      // Permissions may never degrade to an unconfigured allow: a slow boot must wait, and a broken
      // boot must refuse the turn by name instead of silently weakening policy. Thirty seconds keeps
      // the failure bounded while accommodating source-mode/WSL module startup.
      yield* plugins.ready.pipe(
        Effect.timeoutOrElse({
          duration: "30 seconds",
          orElse: () =>
            Effect.die(new Error("Initial plugin and permission policy boot did not finish within 30 seconds")),
        }),
      )
      // Agent-OS Phase 1 (architecture.md): resolve model + agent through the config-inheritance
      // walk, so a child session inherits its parent's unless overridden. Behavior-preserving at the
      // root (the chain is just [session] -> config.* === session.*). config.* carry the real branded
      // values (they flow from session.* through the walk; only the static type is widened -> cast).
      // ⚠️ Through `SessionEffectiveConfig`, not a bare walk: this resolution is what `prepared`
      // carries into `runTurnAttempt`, so it is the value the in-turn readers (affective/shortChat,
      // the context budget) see. A folder layer folded at some readers and not others is a switch
      // that is half on — the hazard `project-defaults.ts` exists to prevent.
      const config = yield* tap(effective.resolve(session.id))
      const agent = yield* tap(agents.select(config.agent as typeof session.agent))
      const initialized = yield* SessionContextEpoch.initialize(
        db,
        loadSystemContext(agent, session.id, ShortChat.enabled(config.shortChat)),
        session.id,
      )
      let promoted = 0
      if (options.promotion) {
        const cutoff = yield* EventV2.latestSequence(db, session.id)
        if (options.promotion === "steer") promoted = yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
        if (options.promotion === "queue") {
          promoted += Number(yield* SessionInput.promoteNextQueued(db, events, session.id))
          promoted += yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
        }
      }
      const system =
        initialized ??
        (yield* tap(
          SessionContextEpoch.prepare(
            db,
            events,
            loadSystemContext(agent, session.id, ShortChat.enabled(config.shortChat)),
            session.id,
            (update) =>
              SessionExecutionAttempt.contextUpdatedCurrent({ ...update.data, snapshot: update.snapshot }, () =>
                SessionContextEpoch.publishUpdate(db, events, update.data, update.snapshot),
              ),
          ),
        ))
      // The RESOLVED config overlaid on the row, so every `models.*` read downstream sees what the
      // chain decided rather than what this row happens to declare. `device` joins `model` here for
      // exactly the reason `model` is here: a sub-agent that declared neither must inherit both, and
      // `SessionRunnerModel.device` is where the declaration is cashed into a scheduler key.
      const modelSession = {
        ...session,
        model: config.model as typeof session.model,
        device: config.device,
      }
      // ⚠️ `requested` is read from the RAW ROW, not from the overlay. `modelSession.model` is the
      // chain-resolved answer, which includes the colleague's own configuration — so asking it "did
      // the user name this?" always says yes. The row is where an explicit `--model`, a switch or a
      // per-turn override actually lands.
      const model = yield* tap(models.resolve(modelSession, { requested: session.model !== undefined }))
      const entries = yield* SessionHistory.entriesForRunner(db, session.id, system.baselineSeq)
      return { session, config, agent, system, modelSession, model, entries, promoted }
    })

    const runTurnAttempt = Effect.fn("SessionRunner.runTurn")(function* (
      sessionID: SessionSchema.ID,
      // ⚠️ PASSED IN, not read here (B7 tier-1). It could not be read here even if we wanted to: the
      // session-config walk below shadows `config` for this whole block, so the Config SERVICE is
      // unreachable from inside the turn. Threading it is also the point — one derivation per turn,
      // so the system prompt, the compactor and the sampling overlay cannot disagree about settings.
      harness: Harness,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      recoverOverflow?: Harness["compaction"]["compactAfterOverflow"],
      timing: TurnTiming.Recorder = TurnTiming.make(),
    ) {
      const publishLiveTiming = () =>
        Effect.suspend(() =>
          events.publish(SessionStatusEvent.Status, {
            sessionID,
            status: { type: "busy", timing: timing.live() },
          }),
        ).pipe(Effect.ignore)
      const timingStart = (phase: SessionMessage.TurnPhase) =>
        Effect.sync(() => timing.start(phase)).pipe(Effect.andThen(publishLiveTiming()))
      /**
       * Close a phase, and record it if it ran long.
       *
       * Only stages that close through HERE are considered, which is every harness stage and no
       * provider one — `provider-prefill` and `generation` close via `attemptSettled`, and a model
       * taking a while is not a defect worth a warning. The receipt already shows the wait; what it
       * cannot show later is the breakdown, which is why this reads the sub-timings at the one
       * moment they exist (see the ledger entry for the 10.6 s that went unexplained).
       */
      const timingEnd = (phase: SessionMessage.TurnPhase) =>
        Effect.sync(() => timing.end(phase)).pipe(
          Effect.tap((closed) => {
            if (!closed?.completedAt) return Effect.void
            const elapsed = closed.completedAt - closed.startedAt
            if (elapsed < SLOW_STAGE_MS) return Effect.void
            const slowest = (closed.details ?? [])
              .filter((detail) => detail.completedAt !== undefined)
              .map((detail) => ({ phase: detail.phase, ms: detail.completedAt! - detail.startedAt }))
              .sort((a, b) => b.ms - a.ms)[0]
            return Log.event("session.turn.stage.slow", {
              "session.id": sessionID,
              "session.stage": phase,
              "session.stage.ms": elapsed,
              // `none`/`0` rather than omitting the pair: a stage with no sub-timings and a stage
              // whose slowest sub-timing we failed to read must not look the same in a query.
              "session.stage.detail": slowest?.phase ?? "none",
              "session.stage.detail.ms": slowest?.ms ?? 0,
            })
          }),
          Effect.andThen(publishLiveTiming()),
        )
      // ⚠️ Three DIFFERENT stretches of this function used to open a phase called `prepare`, so a
      // finished turn's receipt listed "Preparing your prompt" three times and read as a stutter.
      // Each has its own name now — this one covers loading the session: the config walk, the agent,
      // the model, and the conversation itself.
      yield* timingStart("context-load")
      // Surface ANY pre-turn setup failure (config / agent / context-prep / model) IN THE CHAT, not just
      // the server log — these run before any assistant row exists, so `step.failed` (which carries its
      // error on an assistant message) can't convey them; the turn would otherwise fail silently. Emit a
      // calm Synthetic notice explaining WHY, then let the error propagate. Best-effort (`Effect.ignore`).
      const surfacePreTurnFailure = (error: unknown) =>
        Effect.gen(function* () {
          const modelRef =
            // A capability refusal carries providerID/modelID too, but its own `message` is already
            // the complete, accurate sentence — routing it through the "…is unavailable" template
            // below would describe the fault falsely (ruling 2). The model is not unavailable; it
            // is present, reachable, and simply cannot read what was attached.
            error instanceof SessionRunnerModel.ModelInputUnsupportedError
              ? undefined
              : error !== null && typeof error === "object" && "providerID" in error && "modelID" in error
                ? `${(error as { providerID: string }).providerID}/${(error as { modelID: string }).modelID}`
                : undefined
          const text = modelRef
            ? `⚠️ This turn couldn't run — the selected model \`${modelRef}\` is unavailable. Pick an available model in Settings, or check that its backend is running.`
            : `⚠️ This turn couldn't run — ${error instanceof Error && error.message ? error.message : "an unexpected error occurred"}.`
          yield* events.publish(SessionEvent.Synthetic, {
            // `sessionID`, not `session.id`: this notice must be publishable BEFORE the assembly has
            // produced a session — the first fallible step it taps is the config walk.
            sessionID,
            messageID: SessionMessage.ID.create(),
            timestamp: yield* DateTime.now,
            text,
          })
        }).pipe(Effect.ignore)
      const prepared = yield* prepareTurn(sessionID, { promotion, onFailure: surfacePreTurnFailure })
      // The session moved to another location while this drain was queued — not ours to run.
      if (prepared === undefined) return yield* Effect.interrupt
      const { session, config, agent, system, modelSession, model, entries } = prepared
      const toolFibers = yield* FiberSet.make<void, ToolOutputStore.Error>()
      let needsContinuation = false
      /** A pre-action policy returned `halt` for one of this turn's tool calls. See `tool-policy.ts`. */
      let policyHalted = false
      /**
       * How many images this ASSISTANT TURN has been handed. Declared here so its lifetime IS the
       * turn — the scope resets on the next provider turn without anyone remembering to clear it,
       * which is the property the whole mechanism rests on: a fresh turn means the model has just
       * spoken, so its budget genuinely starts again. See `tool/tool.ts` → `imageBudget`.
       */
      let imagesHeldThisTurn = 0
      // A promoted user message restarts the step allowance: what the agent is answering changed.
      let currentStep = prepared.promoted > 0 ? 1 : step
      const maxProviderAttempts = ProviderRetry.maxAttempts(yield* models.retryAttempts(modelSession))
      // Catalog identity, not the provider wire id: a model may deliberately route API requests
      // under `api.id` while users and live config know it by a different stable catalog id.
      const modelRef = yield* models.ref(modelSession)
      // Models item (c): scaffold the system prompt harder for a weak model (jh.md thesis). Reads
      // the resolved model's capability tier; best-effort (never gates the turn).
      const tier = yield* models.tier(modelSession)
      const tierHint = TierScaffold.tierScaffold(tier)
      // 🔴 ROLE/MODEL FIT — tell the colleague when the model behind it is beneath what its role
      // declared (`agent/model-fit.ts`; `notes/named-agents.md`). It warns and never refuses.
      //
      // Placed HERE because this is the first point that holds all three facts at once: the role's
      // floor, the model the turn will actually run on (after any fallback), and its tier. Reading
      // the floor at config-write time instead would miss the case this exists for — a colleague put
      // onto the default model because its own was unavailable or failing.
      //
      // ⚠️ **"Once" means once per CONTEXT, and that is the honest reading rather than a shortcut.**
      // The check scans `entries`, the transcript this turn was assembled from, so after a compaction
      // drops the earlier notice the colleague is told again. That is correct: the notice exists to
      // inform the MODEL, and a model whose context no longer holds it does not know. A durable
      // "warned once" flag would leave a compacted colleague confidently unaware.
      //
      // ⚠️ Best-effort. A notice that cannot be published must never cost the turn it was about.
      if (
        AgentModelFit.below({ needs: prepared.agent.info?.needsTier, bound: tier }) &&
        prepared.agent.info?.needsTier !== undefined &&
        tier !== undefined
      ) {
        // ⚠️ The CATALOG identity (`models.ref`), not the wire id. Two reasons, and the second is the
        // one that made this a bug worth avoiding: the catalog id is what the user sees in Settings,
        // so a notice naming it is a notice they can act on — and `session-runner-model.test.ts`
        // ratchets that the per-model `provider/id` expression survives ONLY as the device-key
        // fallback, which a second copy here would have quietly broken.
        const boundName = modelRef ? `${modelRef.providerID}/${modelRef.id}` : String(model.id)
        const told = AgentModelFit.alreadyTold({
          transcript: entries.map((entry) => SessionCompaction.serializeMessage(entry.message)),
          model: boundName,
        })
        if (!told)
          yield* events
            .publish(SessionEvent.Synthetic, {
              sessionID: session.id,
              messageID: SessionMessage.ID.create(),
              timestamp: yield* DateTime.now,
              text: AgentModelFit.notice({
                needs: prepared.agent.info.needsTier,
                bound: tier,
                model: boundName,
              }),
            })
            .pipe(Effect.ignore)
      }
      // Per-model pre-prompt (owner 2026-07-29): the resolved model's optional user-authored
      // behaviour correction, wrapped as a distinct labelled section. Read best-effort off the
      // resolved catalog model exactly like the tier above; undefined ⇒ inert (see system-compose.ts).
      const modelPrePrompt = SystemCompose.modelPrePromptSection(yield* models.prePrompt(modelSession))
      const context = entries.map((entry) => entry.message)
      const discoveredTools = ToolDiscovery.discovered(context)
      const todoReminderConfig = TodoReminder.resolve(harness.context?.todo_reminder)
      let todoReminder: string | undefined
      if (!todoReminderConfig.enabled) {
        // Re-enabling is an explicit request to resume reminders, including in the current bucket.
        todoReminderStates.delete(session.id)
      } else {
        const reminderState = TodoReminder.due(
          entries.at(-1)?.seq ?? 0,
          todoReminderConfig,
          todoReminderStates.get(session.id),
        )
        if (reminderState !== undefined) {
          // Settle the bucket even for an empty list: repeated provider steps in one bucket must not
          // turn this into a database poll. A later todowrite result already shows its new list and
          // the periodic reminder begins at the next durable-message crossing.
          rememberTodoReminder(session.id, reminderState)
          todoReminder = TodoReminder.render(yield* SessionTodo.readTodos(db, session.id), todoReminderConfig.maxTokens)
        }
      }
      // CAPABILITY GATE (v0.2.0 prep §10). The full reasoning — why the turn's OWN input refuses
      // while history degrades to a placeholder, and why that one rule also covers a Computer Use
      // screenshot — is at `unreadableTurnAttachments` in to-llm-message.ts, next to the pure
      // decision it names. Here we only act on the verdict: refuse BEFORE the request is built, so
      // the user reads "this model can't read images" instead of a provider's media-type 400.
      //
      // The catalog read is gated on there being MEDIA at all, so the overwhelmingly common
      // media-free turn pays nothing; `undefined` capabilities is the pass-everything answer, which
      // is exactly what a media-free turn wants anyway.
      // ⚠️ The predicate is `to-llm-message`'s and NOT an inline test, and that is the whole point:
      // this line used to read "some user message has files", which is the ATTACHMENT door only. A
      // tool-returned image (`read.ts` emits one for jpeg/png/gif/webp today) rides an assistant
      // message, so the inline form made the capability gate inert for exactly the case Computer Use
      // will produce — a gate that looked complete and covered one of two doors.
      //
      // ⚠️ **NO LONGER GATED ON MEDIA, and the old note claiming a saving was wrong.** It read "the
      // catalog read is gated on there being MEDIA at all, so the media-free turn pays nothing" —
      // but `models.capabilities` resolves through the very same `select(session)` that `tier` and
      // `prePrompt` above already call unconditionally on every turn. The gate saved a third copy of
      // a read this turn had made twice, and it cost the perception section its input on exactly the
      // turns that need it: a media-free turn is where a model DECIDES whether to go and look, and
      // under the gate it was told nothing. Measured 2026-08-19 — see `perceptionSection`.
      const modelCapabilities = yield* models.capabilities(modelSession)
      // How many images this endpoint takes in one request; `undefined` = unlimited. Without it a
      // session that looked at more images than the server allows DEAD-ENDS — every later turn
      // re-lowers the same history and re-fails the same 400. See `budgetImages`.
      const declaredImageLimit = yield* models.imageLimit(modelSession)
      // The DECLARED cap wins when there is one — a catalog entry is the operator's statement and a
      // learned value is an inference. Otherwise use whatever this endpoint told us it allows.
      const learnedKey = imageLimitKey(modelRef)
      // A cold process has an empty map, so consult what a PREVIOUS one learned. Order is deliberate:
      // a DECLARED catalog value is the operator's statement and outranks any measurement; the
      // in-process map is this run's own newer knowledge; the persisted value is the last resort.
      const persistedImageLimit = modelRef === undefined ? undefined : yield* models.learnedImageLimit(modelRef)
      // Precedence and the one-image floor both live in `resolveImageLimit`, where a test can reach
      // them — restating the chain inline is how it went uncovered through a change of default.
      const modelImageLimit = SessionRunnerModel.resolveImageLimit({
        declared: declaredImageLimit,
        discovered: learnedKey === undefined ? undefined : discoveredImageLimits.get(learnedKey),
        persisted: persistedImageLimit,
      })
      const unreadable = unreadableTurnAttachments(context, modelCapabilities)
      if (unreadable.length > 0) {
        // Name the model the USER picked, not the wire id: `model.id` is the API-side id
        // (`fromCatalogModel` builds the route from `api.id`), which can differ from the catalog
        // entry shown in the model picker. Falling back to the wire id covers the default-model
        // case, where the session pinned nothing.
        const picked = config.model as typeof session.model
        const refusal = new SessionRunnerModel.ModelInputUnsupportedError({
          providerID: ProviderV2.ID.make(picked?.providerID ?? model.provider),
          modelID: ModelV2.ID.make(picked?.id ?? model.id),
          modality: [...new Set(unreadable.map((file) => attachmentModality(file.mime) ?? "this"))].join(" or "),
          files: unreadable.map((file) => file.name ?? file.mime),
        })
        yield* surfacePreTurnFailure(refusal)
        return yield* refusal
      }
      // The files the USER attached, by canonical identity — resolved ONCE here rather than per tool
      // call, so a mutation cannot be judged against a set that shifted mid-turn. Every mutation tool
      // forwards this to `permission.assert`, which is what makes overwriting the user's own source
      // ask first instead of proceeding silently under the default `bypass` mode.
      const attachmentPaths = yield* AttachmentPaths.resolve(context)
      // Auto-recall (kb-graph §1.3.1): surface relevant memories (this session ∪ global) into the
      // system prompt so the model "just remembers" — no kb-tool call needed. Best-effort: memory
      // off/unavailable → no block, the turn proceeds. Budgeted DOWN for weak models (the JH floor).
      const recallQuery = SessionRecall.recallQuery(context)
      yield* timingEnd("context-load")
      let memoryRecall: string | undefined
      // Kept for the duration of this provider step so a failed `read` can correct the exact
      // remembered file claim that was actually put on the model's horizon.
      let recalledMemories: ReadonlyArray<MemoryClient.SearchHit> = []
      // Which filing cabinets this turn may open (AGENTS.md — the structural metaphor). The set is
      // built in `recall.ts` where a test can reach it, because "which scopes" IS the per-agent
      // memory promise: it cannot be enforced by a label in the roster UI or by asking the model
      // nicely. `undefined` = a throwaway agent with no memory at all, and it skips the whole leg —
      // embedding and searching for a probe that must receive nothing is pure cost.
      const memoryScopes = SessionRecall.recallScopes({
        sessionID: session.id,
        agentID: agent.id,
        memory: agent.info?.memory,
      })
      if (
        recallQuery !== undefined &&
        memoryScopes !== undefined &&
        !ShortChat.enabled(config.shortChat) &&
        // ⚠️ No `MemorySetting.memoryEnabled()` here any more: the instance ceiling is applied
        // when the config resolves, so a reader that forgets it can no longer be off by omission.
        stanceOf("memory", config.memory)
      ) {
        // The VECTOR leg: one short embedding of the recall query lets the engine fuse vector KNN with
        // FTS (measured 85% vs 77% keyword-only). Bounded + degrading — no device, unreachable, or slow
        // ⇒ undefined ⇒ keyword-only recall. Never blocks the turn on a failure.
        yield* timingStart("memory-embed")
        const recallVector = yield* Effect.promise(() => KbEmbedder.embedOne(recallQuery))
        yield* timingEnd("memory-embed")
        const budget = SessionRecall.recallBudget(tier)
        /**
         * The id that links THIS recall's ledger rows to what the turn ends up doing with them.
         *
         * ⚠️ Minted here rather than by the store, because only this end of the call knows which of
         * the returned pool survives the context budget. The store writes a row per RETURNED memory;
         * `markUsed` below promotes the ones that actually reached the model. Without a shared id
         * the report would have to guess which rows it just caused ("the newest for these ids"),
         * which is wrong the moment two sessions recall at once.
         */
        const recallID = "rcl_" + ascending()
        // P8 ordering: over-fetch candidates, then re-rank by recency × authority and keep `budget` of
        // them. What the model sees each turn is the SHORT list, so ordering matters most here — a
        // recent authoritative fact must beat an old passive musing that merely echoes the wording.
        // Bounded (ranking.ts) and a no-op when hits share provenance and age.
        yield* timingStart("memory-search")
        const recallCandidates = yield* memory
          .search({
            query: recallQuery,
            k: SessionRecall.recallPoolSize(budget),
            scopes: memoryScopes,
            surface: "auto-recall",
            recallID,
            ...(recallVector === undefined ? {} : { embedding: recallVector }),
          })
          .pipe(Effect.orElseSucceed(() => []))
        yield* timingEnd("memory-search")
        // P8d: let the MODEL order what it will actually see. Metadata ordering can't read
        // authoritativeness out of the TEXT — a definitive older statement should outrank a newer
        // offhand musing (measured 4/4 vs 1/4 for metadata alone). One short call (~0.4s at 5
        // candidates). ANY failure — gate off, model down, unparseable reply — falls back to the
        // deterministic ranker, so ordering degrades but the turn never breaks.
        let ordered: ReadonlyArray<MemoryClient.SearchHit> = MemoryRanking.rankHits(recallCandidates, Date.now())
        if (MemorySetting.rerankEnabled() && recallCandidates.length > 1) {
          yield* timingStart("memory-rerank")
          const prompt = MemoryRerank.buildRerankPrompt(recallQuery, recallCandidates, Date.now())
          // ⚠️ This is the ONE utility pass sitting inside the user's own turn — it runs before the
          // request is even built, and the user watches it as "Choosing useful memories". `ordered`
          // above already holds the deterministic ranking, so a slow model costs ORDERING QUALITY
          // here and nothing else. Bound it: past the deadline we keep what we have rather than make
          // someone wait for a list of numbers. (The `NO_THINKING` overlay on `judgeCompletion` makes
          // the deadline the rare path; a model that ignores the overlay makes it the common one.)
          const reply = yield* judgeCompletion(
            session.id,
            harness.introspection,
            `${prompt.system}\n\n${prompt.user}`,
          ).pipe(
            Effect.timeoutOrElse({ duration: RERANK_DEADLINE, orElse: () => Effect.succeed("") }),
            Effect.orElseSucceed(() => ""),
          )
          const order = MemoryRerank.parseRerankOrder(reply, recallCandidates.length)
          if (order) ordered = order.map((index) => recallCandidates[index]!)
          yield* timingEnd("memory-rerank")
        }
        /**
         * A FIXED TOKEN BUDGET, with the user's standing constraints protected from truncation.
         *
         * ⚠️ `budget` above still caps the pool the reranker chooses from; what the model is SHOWN
         * is bounded in tokens, because five one-line preferences and five ingested passages are not
         * the same amount of window. `recall.ts` holds the tiering, the estimator and what the
         * estimate's error costs.
         */
        const pack = SessionRecall.packRecall(ordered, SessionRecall.recallTokenBudget(tier))
        recalledMemories = pack.shown
        memoryRecall = SessionRecall.formatRecall(pack)
        // 🔴 The other half of the P3 ledger: RETURNED is not USED. The store recorded the whole
        // pool; this says which of it survived the budget and actually reached the model, which is
        // the signal the pruning policy weighs and the "never used" list is the absence of.
        // Best-effort — a measurement must never cost a turn.
        yield* MemoryAccessLedger.markUsed(db, {
          recallID,
          ids: pack.shown.map((hit) => hit.id),
          at: Date.now(),
        })
      }
      // The exact wire text of the tail-injected recall block. Carries the 1N provenance prefix for
      // the same reason the todo reminder does: it rides the `user` role, and every real-user walk
      // (context-pack's anchor, compaction, title generation) must not mistake it for speech. The
      // packer matches on this exact string to apply the `memory` category budget, so it — not the
      // bare `memoryRecall` — is what goes to `packRequest`.
      const recallMessage = memoryRecall === undefined ? undefined : SessionInput.applySteerProvenance(memoryRecall)
      // Everything the model is actually sent: the tool definitions, the composed system prompt, the
      // sampling overlay, and the request itself.
      yield* timingStart("request-build")
      const isLastStep = agent.info?.steps !== undefined && currentStep >= agent.info.steps
      // 🔴 The harness is the controller for a set request, so a sub-agent is a SECOND controller
      // over the same work — with its own context, coverage the parent cannot see, and a join the
      // parent blocks on. Measured over nine runs of one 400-icon prompt (2026-08-20): the run that
      // did NOT delegate covered 100 files in ~7 minutes; every run that DID lost 10–30 minutes to
      // stalls around spawn/wait and covered less (83 in 58 minutes, 31, and 7).
      //
      // ⚠️ Mechanical, because the informational version did not convert. The fan-out advice was
      // rewritten the same day to key on image SIZE and to say small images should not be delegated,
      // and the model kept spawning — the third informational lever here to fail. Withholding the
      // tool is the lever that decides it.
      //
      // Narrow by construction: only while THIS request asks for a set, and only `spawn`. Every
      // other turn keeps it.
      // ⚠️ Derived from the live context, and therefore SUBJECT to the compaction defect that
      // `session-set-latch.test.ts` documents: once the original prompt leaves the window this reads
      // false and `spawn` is re-offered mid-set. The drive's own latch lives in the drain scope,
      // which this per-step builder cannot see, so sharing it needs a parameter threaded through the
      // request build — worth doing, not worth doing carelessly.
      //
      // Tolerable in the meantime because the failure is benign in one direction: the worst case is
      // that delegation becomes available again late in a long run, which is the behaviour that
      // shipped before the gate existed.
      // ⚠️ …UNLESS THE USER ASKED FOR DELEGATION. The gate below withholds `spawn` for the whole of a
      // set request, which is right for *"describe each icon in this folder"* — but *"spawn a fleet of
      // 6 sub-agents, each summarising a sixth"* trips the same `each` cue while the delegation IS the
      // instruction. Measured on Qwen3.6-35B 2026-08-22: the officer called `spawn` six times and every
      // call returned "Unknown tool: spawn", because the user's own order had withheld it.
      // ⚠️ **LATCHED, not re-derived.** This used to read `lastRealUserText(context)` every step, so
      // the gate flipped on ordinary speech mid-session and — worse — went FALSE once compaction
      // evicted the original prompt, re-offering `spawn` in the middle of the very set request it was
      // withheld for. `setRequests` is the session-scoped decision the drive already keeps for exactly
      // this reason (see its note above: run 11 read `asked: false` with ~290 files still to go), so
      // the two halves of the harness now agree by construction instead of by coincidence.
      //
      // Each flip also re-prefilled the whole prompt: the `spawn` tool DEFINITION sits ahead of the
      // system blocks, so a flip invalidated the cache down to `base` plus the entire transcript
      // (NC-PROMPT-CACHE-001).
      //
      // Falls back to the live read only before the latch exists — the first step of a fresh session,
      // where the prompt is still in the window and the two answers are identical anyway.
      const latched = setRequests.get(session.id)
      const userText = lastRealUserText(context) ?? ""
      const drivingASet =
        latched?.asked ?? (UnfinishedSet.asksForSet(userText) && !UnfinishedSet.asksToDelegate(userText))
      const toolMaterialization = isLastStep
        ? undefined
        : yield* tools.materialize(
            agent.info?.permissions,
            (name) =>
              !(drivingASet && name === SpawnTool.name) &&
              ShortChat.offered(config.shortChat, name) &&
              ConfigToolRouting.offered(harness.toolRouting, {
                mode: config.permissionMode,
                providerID: modelRef?.providerID ?? model.provider,
                modelID: modelRef?.id ?? model.id,
              })(name),
            discoveredTools,
            // 🔴 WITHHELD AT THE CAP, not advertised and refused. `ask`/`ask_group` cannot succeed
            // once the chain is at `HOP_CAP`, so offering them spends a turn on a refusal the model
            // then has to interpret. `list`, `hire` and `retire` are unrelated to the bound and stay,
            // which is why this is a variant rather than withholding the tool.
            //
            // ⚠️ Free to consult: the hop rides the transcript this turn already holds
            // (`ColleagueHop.fromContext`), not a database read — the concern the item raised, and
            // measured away.
            (name) =>
              name === ColleagueTool.name &&
              ColleagueBound.exceedsHopCap(ColleagueBound.nextHop(ColleagueHop.fromContext(context)))
                ? ColleagueTool.CAPPED
                : undefined,
          )
      const promptCacheKey = /^ses_[0-9a-f]{64}$/.test(session.id) ? session.id.slice(4) : session.id
      // P3 (3A/3B): appraise the per-session mood from what has happened so far (runs BEFORE
      // this turn's request, afpro-style), modulate sampling AROUND the model's configured
      // baseline, and at high frustration/urgency steer a one-shot redirect (rising-edge only —
      // decay naturally re-arms it). The per-session stance (the composer's Tuning toggle,
      // resolved through the config walk) wins; no stance = the global config decides.
      let affectiveGeneration: ReturnType<typeof Affective.toSampling> | undefined
      if (!ShortChat.enabled(config.shortChat) && (config.affective ?? harness.affective?.enabled === true)) {
        const previous = moods.get(session.id) ?? Affective.calmMood
        const mood = Affective.appraise(previous, context)
        rememberMood(session.id, mood)
        const defaults = model.route.defaults.generation
        affectiveGeneration = Affective.toSampling(
          mood,
          {
            // `|| undefined`: a config temperature of 0 means "cleared from the settings tab"
            // (updateGlobal can't remove keys over the wire), not a real 0 baseline.
            temperature: defaults?.temperature ?? (harness.affective?.temperature || undefined),
            topP: defaults?.topP,
            topK: defaults?.topK,
            frequencyPenalty: defaults?.frequencyPenalty,
            presencePenalty: defaults?.presencePenalty,
          },
          {
            toolsPresent: (toolMaterialization?.definitions.length ?? 0) > 0,
            extended: harness.affective?.extended === true,
          },
        )
        // Behavioural nudges ("act NOW", "stop repeating") are pressure for a model working
        // ALONE. In an ATTENDED chain the user is present and talking IS the deliverable —
        // urgency climbs on every talk-only step and never decays, so a normal discussion
        // used to trip the "stop deliberating" steer within a few replies. Attendance is the
        // chain ROOT's property (the Agent Jail doctrine — AgentJail.attendedRoot); sampling
        // modulation above stays active either way.
        const nudge = Affective.intervention(mood)
        const wasCalm = Affective.intervention(previous) === undefined
        if (nudge && wasCalm) {
          const rootType = yield* rootSessionType(session.id, (id) => store.get(id as SessionSchema.ID))
          if (!AgentJail.attendedRoot(rootType)) yield* SessionInput.steer(db, events, session.id, nudge)
        }
      }
      // 🔴 ONE assembly, two configurations — so both postures are measurable in the same vocabulary.
      // The Chat posture used to build its own `[persona, GUIDANCE]` array; expressed as named blocks
      // it is `persona` + `base`, which `composeSystemParts` emits in that order, so the prompt is
      // byte-identical (`short-chat.test.ts` pins it). What it buys is that
      // `SystemAccounting` can now count a chit-chat role's prompt and an engineering one's on the
      // same scale — the comparison `notes/named-agents.md` asks for and had no instrument to make.
      const promptParts: SystemCompose.SystemPromptParts = ShortChat.enabled(config.shortChat)
        ? { ...(harness.chatPersona === undefined ? {} : { persona: harness.chatPersona }), base: ShortChat.GUIDANCE }
        : {
            persona: harness.persona,
            modelPrePrompt,
            expertiseHint: harness.expertiseHint,
            tierHint,
            systemPromptOverride: config.systemPromptOverride,
            agentSystem: agent.info?.system,
            // The tool list the model is about to receive is `toolMaterialization.definitions`; the
            // catalogue it CANNOT see is `.deferred`. Saying how many there are is the whole point —
            // see the section's own note on why a count and not a hedge.
            toolDiscovery: SystemCompose.toolDiscoverySection(toolMaterialization?.deferred.length ?? 0),
            // That the model can SEE, when the catalog says it can. The `canSpawn` half is read off
            // the tools the model is ACTUALLY about to receive rather than off the registry: the
            // delegation paragraph is an instruction, and an instruction naming a tool this turn
            // cannot call is the false description ruling 2 forbids.
            perception: SystemCompose.perceptionSection({
              capabilities: modelCapabilities,
              // ⚠️ The literal, not `SpawnTool.name`: `tool/spawn.ts` reaches `session/spawner.ts`,
              // which is on this runner's own import path, so naming the module here would close a
              // cycle for one string. The coupling is pinned instead by
              // `test/session-system-compose.test.ts`, which fails if `SpawnTool.name` ever moves.
              canSpawn: (toolMaterialization?.definitions ?? []).some((tool) => tool.name === "spawn"),
            }),
            // ⚠️ From the AGENT record, not from the session's resolved memory stance: `memory:
            // "none"` is a property of WHO this colleague is — a throwaway keeps nothing by
            // construction — while the session-level switch can turn recall off for a colleague that
            // normally remembers, which is a different sentence and not this one.
            memoryStance: SystemCompose.memoryStanceSection({
              memory: prepared.agent.info?.memory,
              archiveChats: prepared.agent.info?.archiveChats,
            }),
            // 🔴 Both flags read from the tools this turn ACTUALLY received, never from the registry
            // or the ruleset — a section naming a tool the turn cannot call is a false description.
            // Same source `perception`'s `canSpawn` already uses, and for the same reason.
            delegation: SystemCompose.delegationSection({
              // Read from the SAME condition that withheld the ops, so the sentence and the tool
              // list cannot disagree — "a section naming a tool the turn cannot call is a false
              // description", and a silent absence is the converse.
              colleaguesAtCap: ColleagueBound.exceedsHopCap(ColleagueBound.nextHop(ColleagueHop.fromContext(context))),
              canSpawn: (toolMaterialization?.definitions ?? []).some((tool) => tool.name === "spawn"),
              canAddressColleagues: (toolMaterialization?.definitions ?? []).some((tool) => tool.name === "colleague"),
            }),
            projectScope: SystemCompose.projectScopeSection(config.permissionMode),
            // ⚠️ The scratch path is derived from the AGENT id, not from the session: a colleague's
            // workspace is a property of who it is, and every chat it has reaches the same one. A
            // session-derived path would give it a fresh empty folder per conversation, which is the
            // opposite of the durable place these instructions promise.
            workspace: SystemCompose.workspaceSection({
              directory: session.location?.directory,
              scratch: prepared.agent.id ? Scratch.forAgent(String(prepared.agent.id)) : undefined,
            }),
            base: system.baseline,
          }
      const promptAccounting = SystemAccounting.of(promptParts)
      // Beside `session.request.footprint`, which measures the request in three lumps and therefore
      // cannot say WHICH part of the system prompt grew. Debug level: one line a turn, and the line a
      // regression is read from.
      yield* Log.event("session.prompt.blocks", {
        "session.id": session.id,
        "prompt.tokens": promptAccounting.tokens,
        "prompt.chars": promptAccounting.chars,
        "prompt.blocks": promptAccounting.blocks.length,
        "prompt.largest": promptAccounting.largest?.block ?? "none",
        "prompt.largest.tokens": promptAccounting.largest?.tokens ?? 0,
      })
      const systemParts = SystemCompose.composeSystemParts(promptParts).map(SystemPart.make)
      const providerMessages = toLLMMessages(context, model, modelCapabilities, modelImageLimit)
      const latestCompactionID = context.findLast((message) => message.type === "compaction")?.id
      const strictEnabled = { ...(harness.strict ?? {}), ...(config.strict ?? {}) }.enabled === true
      const groundingDecision = ProjectGrounding.decide(
        {
          enabled: !strictEnabled && !ShortChat.enabled(config.shortChat),
          directory: location.directory,
          ...(latestCompactionID === undefined ? {} : { compactionID: latestCompactionID }),
          contextTokens: RequestFootprint.measure({ system: [], messages: providerMessages, tools: [] })
            .estimatedTokens,
        },
        projectGroundingStates.get(session.id),
      )
      if (groundingDecision.state !== undefined) rememberProjectGrounding(session.id, groundingDecision.state)
      // The folder's CONTENTS ride the grounding message, not just its path — see
      // `project-grounding.ts` for the measurement (the model invented a filename from the folder's
      // own name rather than listing it). Read only when a message is actually due, so this costs
      // one bounded `readdir` per grounding cadence and nothing on an ordinary turn; a failure
      // yields `undefined` and the message is exactly what it was before.
      const groundingListing = groundingDecision.due
        ? yield* Effect.promise(() => ProjectGrounding.readListing(location.directory))
        : undefined
      const projectGrounding = groundingDecision.due
        ? SessionInput.applySteerProvenance(ProjectGrounding.render(location, groundingListing))
        : undefined
      const fullRequest = LLM.request({
        model,
        // Order + placement of the per-model pre-prompt live in system-compose.ts (a pure, tested
        // unit): the pre-prompt sits directly after the persona baseline; every other part keeps its
        // position, so an absent pre-prompt yields a byte-identical prompt to before the feature.
        // `projectScope` is the guidance half of the owner's 2026-07-30 directive — present in every
        // mode but `yolo`, from the RESOLVED (already-narrowed) mode. See system-compose.ts.
        system: systemParts,
        messages: [
          ...providerMessages,
          ...(projectGrounding === undefined ? [] : [Message.user(projectGrounding)]),
          // Derived provider context only — never a transcript row. The provenance prefix makes
          // every downstream real-user detector treat it as harness guidance rather than speech.
          //
          // Auto-recall rides the TAIL, not the system prompt (see system-compose.ts's ⚠️ header):
          // it is recomputed and re-ranked every turn, so in the system array it invalidated the
          // server-side prefix cache for the entire request — measured 0.3s -> 12.9s to first token
          // on a 13.5K-token agent turn. Here, a change costs only the tokens after it.
          ...(recallMessage === undefined ? [] : [Message.user(recallMessage)]),
          ...(todoReminder === undefined ? [] : [Message.user(todoReminder)]),
          ...(isLastStep ? [Message.assistant(MAX_STEPS_PROMPT)] : []),
        ],
        // A text-only model is not told a picture "arrives as a picture you can see" (owner,
        // 2026-08-20). Applied HERE rather than in the registry because this is the first point
        // that knows both the tool list and the resolved model's declared modalities; `undefined`
        // capabilities mean nobody told us and keep today's wording. See `vision-copy.ts`.
        tools: VisionCopy.forCapabilities(toolMaterialization?.definitions ?? [], modelCapabilities?.input),
        callableTools: isLastStep ? [] : [...discoveredTools],
        toolChoice: isLastStep ? "none" : undefined,
        ...(affectiveGeneration === undefined ? {} : { generation: affectiveGeneration }),
      })
      yield* timingEnd("request-build")
      // ⚠️ `compactIfNeeded` is a CHECK that usually declines — window unknown, no summary model, or
      // simply under its threshold. Timing it is right; RECORDING it as a phase is not, because the
      // receipt then says "Compacting the conversation" over a conversation nobody compacted. The
      // owner saw exactly that two messages into a fresh session on a packaged build (2026-08-11).
      // A receipt is a claim about what happened, so a stage that declined is withdrawn rather than
      // reported.
      yield* timingStart("compaction")
      const compacted = yield* harness.compaction.compactIfNeeded({
        sessionID: session.id,
        entries,
        model,
        request: fullRequest,
      })
      // The conversation that just got compressed away is written into this colleague's OWN memory
      // as passages, so `kb search` can find it later (`session/compaction-archive.ts` holds the
      // why). Best-effort and AFTER the compaction is durable: an archive that failed must never
      // turn a successful compaction into a failed turn — the summary is already committed, and the
      // transcript rows are still in the database either way.
      if (compacted)
        yield* archiveCompactedChat({ entries, agent, memory, session }).pipe(
          // Best-effort means the TURN survives, not that nobody is told. `Effect.ignore` here made
          // an empty archive indistinguishable from an archive that was never attempted — which is
          // exactly the question a person debugging one would be asking.
          reportArchiveFailure(session.id, agent.id),
        )
      if (compacted) yield* timingEnd("compaction")
      else yield* Effect.sync(() => timing.discard("compaction")).pipe(Effect.andThen(publishLiveTiming()))
      if (compacted) return yield* Effect.die(continueAfterCompaction(currentStep))
      // 1M — the deterministic fail-safe under compaction: pack the outgoing request to the
      // server's HONORED window so an Ollama-class server never silently front-truncates the
      // system prompt away. Reached when compaction declined (window unknown, summary model
      // unavailable, or simply under ITS threshold) — history in the DB stays intact.
      // The deterministic packer: what had to be dropped for the request to fit the window.
      yield* timingStart("context-fit")
      const preparedDispatch = ProviderDispatch.prepare({
        request: fullRequest,
        promptCacheKey,
        contextSize: model.route.defaults.limits?.context,
        profile: ContextBudget.enabled(harness.context, config.contextBudget)
          ? ContextBudget.resolve(harness.context, config.type)
          : undefined,
        memoryRecall: recallMessage,
      })
      yield* timingEnd("context-fit")
      const packed = preparedDispatch.packed
      if (packed.dropped > 0)
        yield* Log.event("session.context.pack.evicted", {
          "session.id": session.id,
          "session.dropped": packed.dropped,
          "session.kept.tokens": packed.estimatedTokens,
          "session.context.size": packed.contextSize,
        })
      const request = preparedDispatch.request
      // Measured AFTER packing, because packing is what actually goes out — reading `fullRequest`
      // would report a request that was never sent and hide eviction entirely. Numbers only, at
      // `debug`: this fires every turn, and the value is the series rather than any one line.
      yield* Log.event("session.request.footprint", {
        "session.id": session.id,
        ...RequestFootprint.attributes(
          RequestFootprint.measure({ system: request.system, messages: request.messages, tools: request.tools }),
        ),
      })
      const startSnapshot = ShortChat.enabled(config.shortChat)
        ? undefined
        : yield* Effect.gen(function* () {
            // The BASELINE — what the files looked like before the model ran. Its twin after the
            // step settles is `snapshot-after`; both used to be called `snapshot`, so the receipt
            // said "Checking your files" twice for two different things.
            yield* timingStart("snapshot-before")
            const captured = yield* snapshots.capture({ timing: { start: timing.detailStart, end: timing.detailEnd } })
            yield* timingEnd("snapshot-before")
            return captured
          })
      yield* timingStart("provider-setup")
      const assistantMessageID = SessionMessage.ID.create()
      const attemptModelRef = {
        id: ModelV2.ID.make(model.id),
        providerID: ProviderV2.ID.make(model.provider),
        ...(session.model?.variant === undefined ? {} : { variant: session.model.variant }),
      }
      const publisher = createLLMEventPublisher(events, {
        sessionID: session.id,
        assistantMessageID,
        agent: agent.id,
        model: attemptModelRef,
        snapshot: startSnapshot,
        executionBoundary: SessionExecutionAttempt.advanceCurrent,
        providerToolProtocol: SessionExecutionAttempt.providerToolProtocolCurrent,
        toolSideEffects: toolMaterialization?.sideEffects,
        toolDispatched: SessionExecutionAttempt.toolDispatchedCurrent,
        toolSettled: SessionExecutionAttempt.toolSettledCurrent,
        onFirstOutput: () => Effect.sync(timing.firstToken).pipe(Effect.andThen(publishLiveTiming())),
      })
      const withPublication = Semaphore.makeUnsafe(1).withPermit
      const publish = (event: LLMEvent, outputPaths: ReadonlyArray<string> = []) =>
        withPublication(publisher.publish(event, outputPaths))
      let overflowFailure: ProviderErrorEvent | undefined
      let mediaLimitFailureEvent: ProviderErrorEvent | undefined
      // 1D: an attempt that produced durable ASSISTANT output is never replayed (that could
      // duplicate text or tool side effects). Protocol bookkeeping such as `step-start` alone
      // is safe to discard, so failures before the assistant begins reconnect in-place below.
      let brokenResponse = false
      let handledResponseFailure = false
      // MindControl thinking budget (reasoning-budget.ts): when the model carries a budget and this
      // isn't the tool-less final step, run the turn through the budget controller — it monitors the
      // reasoning stream and, only if the model runs past the budget still thinking, stops and
      // continues with a nudge (and a forced `</think>` close at the end). A model that answers on
      // its own streams through untouched. Skipped when thinking is explicitly disabled for the turn.
      const thinkingBudget = model.route.defaults.limits?.thinkingBudget ?? 0
      // Per-chat override (the composer's Tuning control): `false` runs the turn with the controller OFF so
      // the model reasons to its own stop, which is what makes a budget change A/B-able in one chat without
      // editing the instance default. Absent = inherit the chain, then the model's own budget.
      const budgetEnforced = !ShortChat.enabled(config.shortChat) && stanceOf("thinkingBudget", config.thinkingBudget)
      const budgetedSource = ProviderDispatch.stream({
        llm,
        request,
        enabled: budgetEnforced && !isLastStep,
        budget: thinkingBudget,
      })
      // STEER INTERRUPT (owner 2026-07-26). Reasoning and the answer can be cut safely — the only thing that
      // must not be interrupted is a TOOL, because a half-written file or a half-sent message is real damage.
      // So a durable steer arriving mid-generation stops the stream at the next event and the following step
      // promotes it, instead of the user waiting out a three-minute think.
      //
      // `sawToolCall` is the guard: tool calls settle INSIDE the loop below (and fork into `toolFibers`), so
      // once one has been emitted this step we let the step finish normally — the next step boundary picks
      // the steer up anyway, and that is a short wait. The DB check is throttled because it sits on the
      // per-event hot path.
      let steerInterrupt = false
      let sawToolCall = false
      let lastSteerCheck = Date.now()
      const providerStream = ProviderStreamLiveness.withStallTimeout(
        budgetedSource,
        harness.providerStallTimeoutMs,
      ).pipe(
        Stream.takeUntil(() => steerInterrupt),
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (event.type === "tool-call") sawToolCall = true
            // WHICH process served this turn. A server restarted behind the same URL keeps its
            // address, so this is the only signal that a stored capability verdict describes a
            // process that is gone. `observeServing` cannot fail — no capability record is worth
            // failing a turn for — while `servedByCurrent` dies like every other attempt write, since
            // a receipt that omits provenance while looking complete is the worse outcome.
            if (event.type === "finish") {
              const reported = ProviderCapability.servingIdentityOf(event.providerMetadata)
              if (reported !== undefined) {
                yield* models.observeServing({ providerID: model.provider, id: model.id }, reported)
                // The same fact serves two readers with opposite lifetimes: the capability store
                // keeps ONE current verdict per model and discards it on a move, while the receipt
                // keeps what served THIS attempt forever. Neither can be derived from the other.
                yield* SessionExecutionAttempt.servedByCurrent(reported)
              }
            }
            if (
              shouldCheckForSteer({
                sawToolCall,
                alreadyCut: steerInterrupt,
                now: Date.now(),
                lastCheck: lastSteerCheck,
              })
            ) {
              lastSteerCheck = Date.now()
              steerInterrupt = yield* SessionInput.hasPending(db, session.id, "steer").pipe(
                Effect.orElseSucceed(() => false),
              )
              if (steerInterrupt) {
                // Another step must run, or the steer would sit unread until the next drain.
                needsContinuation = true
                yield* Log.event("session.steer.stream.interrupted", { "session.id": session.id })
              }
            }
            if (overflowFailure || publisher.hasProviderError()) return
            if (LLMEvent.is.providerError(event)) {
              if (isContextOverflowFailure(event) && !publisher.hasAssistantStarted()) {
                overflowFailure = event
                return
              }
              // The endpoint named its image cap. Swallow the event exactly as the overflow arm does
              // — publishing it would put a raw `parameter=image` 400 in the user's chat for a fault
              // the product is about to recover from by itself.
              if (mediaLimitFailure(event) !== undefined && !publisher.hasAssistantStarted()) {
                mediaLimitFailureEvent = event
                return
              }
            }
            yield* publish(event)
            if (event.type !== "tool-call" || event.providerExecuted) return
            if (!toolMaterialization) {
              yield* withPublication(
                publisher.failUnsettledTools({
                  message: "Tools are disabled after the maximum agent steps",
                  _tag: "ToolFailure",
                }),
              )
              return
            }
            needsContinuation = true
            const assistantMessageID = yield* publisher.assistantMessageID(event.id)
            // ⭐ A TOOL IS NOT GENERATION — free the device before running one.
            //
            // 🔴 Measured 2026-08-20. A parent called `wait` on the child it had just spawned. A
            // sub-agent is BATCH class, admitted only while no interactive turn holds the device;
            // the parent is interactive and held it for the whole tool call. The child's first step
            // landed 599.3 s later, released by the join's own 600 s timeout — on a warm model that
            // cold-loads in 288 s. Its every later step took 0–3 s.
            //
            // ⚠️ Releasing before the dispatch's SETTLEMENT callback was not enough and shipped as a
            // fix that did nothing: tools run here, inside the stream, strictly earlier. The unit
            // tests passed throughout because their `settle` blocked — faithful to the documented
            // design, wrong about the system. This is the real boundary.
            //
            // No re-admit: a tool call ends the step, and the next step's dispatch admits again
            // (`step.ended → provider-attempt.started` in any session's events). Re-acquiring here
            // would mean blocking inside a finalizer.
            yield* scheduler.release(dispatchSlot)
            yield* Effect.uninterruptibleMask((restore) =>
              restore(
                toolMaterialization.settle({
                  sessionID: session.id,
                  agent: agent.id,
                  assistantMessageID,
                  attachmentPaths,
                  // The mechanical half of the vision fix (`tool/tool.ts` → `imageBudget`). Counted
                  // PER ASSISTANT TURN, which is what makes it sound: within one turn there is no
                  // assistant text between tool calls, so every image past the cap is necessarily
                  // undescribed and `budgetImages` would elide one to fit it. `read` returns a
                  // sentence instead, the turn ends, the model describes what it holds — and the
                  // descriptions are what survive when the pixels later go.
                  ...(modelImageLimit === undefined
                    ? {}
                    : { imageBudget: { limit: modelImageLimit, held: imagesHeldThisTurn } }),
                  timing: {
                    begin: (phase) =>
                      Effect.gen(function* () {
                        const close = timing.begin(phase)
                        yield* publishLiveTiming()
                        return () => Effect.sync(close).pipe(Effect.andThen(publishLiveTiming()))
                      }),
                  },
                  call: event,
                }),
              ).pipe(
                Effect.flatMap((settlement) =>
                  Effect.gen(function* () {
                    // A pre-action policy halted. The call did not run; the refusal is already the
                    // tool result the model sees, and this latch is the half a `deny` does not have —
                    // it ends the drain rather than letting the model route around the refusal.
                    if (settlement.halted === true) policyHalted = true
                    // Count the images this turn has actually been handed, so the NEXT call in the
                    // same turn sees an accurate `held`. Counting the settled RESULT rather than the
                    // call is deliberate: a read that failed, was denied, or returned the withheld
                    // notice hands over no pixels and must not consume the budget.
                    if (settlement.result.type === "content")
                      for (const entry of settlement.result.value)
                        if (entry.type === "file" && entry.mime.toLowerCase().startsWith("image/")) imagesHeldThisTurn++
                    // A missing file is authoritative negative evidence. If recalled memory led this
                    // exact step to that path, invalidate the claim before the next step recalls again.
                    // Re-stat instead of parsing the generic tool error: permission, binary, size, and
                    // transient I/O failures must never erase a valid memory.
                    if (
                      event.name === "read" &&
                      settlement.result.type === "error" &&
                      typeof event.input === "object" &&
                      event.input !== null &&
                      "path" in event.input &&
                      typeof event.input.path === "string"
                    ) {
                      const requested = event.input.path.trim()
                      if (requested !== "") {
                        const resolved = path.resolve(location.directory, requested)
                        // A CLAIM that CITED this file is flagged for review by traversal: it need not
                        // have been recalled this turn, and its wording is never consulted. Flagged,
                        // not forgotten — a moved citation is no evidence the fact is false.
                        const flagged = yield* MemoryCorrection.reviewMovedEvidence({ memory, requested, resolved })
                        if (flagged > 0)
                          yield* Log.event("session.memory.evidence.moved", {
                            "session.id": session.id,
                            "session.memory.flagged": flagged,
                          })
                        const count = yield* MemoryCorrection.correctMissingRead({
                          memory,
                          recalled: recalledMemories,
                          requested,
                          resolved,
                        })
                        if (count > 0)
                          yield* Log.event("session.memory.invalidate.stale", {
                            "session.id": session.id,
                            "session.memory.invalidated": count,
                          })
                      }
                    }
                    yield* publish(
                      LLMEvent.toolResult({
                        id: event.id,
                        name: event.name,
                        result: settlement.result,
                        output: settlement.output,
                      }),
                      settlement.outputPaths ?? [],
                    )
                  }),
                ),
              ),
            ).pipe(FiberSet.run(toolFibers))
          }),
        ),
        Effect.ensuring(withPublication(publisher.flush())),
      )

      // `ProviderDispatch.run` owns scheduler admission, bounded pre-output retry, fairness
      // accounting and unconditional release for BOTH engines. Its slot covers generation only;
      // tool settlement below therefore cannot deadlock a parent against its own child.
      // ⚠️ A DEVICE IS A BACKEND, NOT A MODEL. This was `${model.provider}/${model.id}`, so two
      // models served by ONE vLLM process were two devices with independent `MAX_BATCH` capacity
      // and separate fairness ledgers — a claim about the hardware that is false, and one that
      // oversubscribes exactly the box the gate above exists to protect. `deviceKeyFor` keys on the
      // normalized endpoint ORIGIN instead; see its own comment for the cloud-model carve-out and
      // for why this is the substrate for `deviceKey = resolvedDevice` rather than the whole of it.
      // The `??` keeps a scheduling key from ever failing a turn: `device` is best-effort, and the
      // old per-model key is always safe (it can only over-partition, never over-share).
      const scheduledDevice = yield* models.device(modelSession)
      const dispatchSlot = {
        sessionID: session.id as string,
        deviceKey: scheduledDevice?.key ?? `${model.provider}/${model.id}`,
        sessionClass: SessionScheduler.classForSessionType(config.type),
        ...(config.priority > 0 ? { priority: config.priority } : {}),
        ...(scheduledDevice?.concurrency === undefined ? {} : { concurrency: scheduledDevice.concurrency }),
        ...(scheduledDevice?.locality === undefined ? {} : { locality: scheduledDevice.locality }),
      }
      const generation = (stream: Exit.Exit<void, LLMError>, restore: ProviderDispatch.Restore) =>
        Effect.gen(function* () {
          const failure =
            stream._tag === "Failure" ? Option.getOrUndefined(Cause.findErrorOption(stream.cause)) : undefined
          // ⚠️ AHEAD of the overflow arm, and the order is the decision. Compaction summarises TEXT
          // and removes not one image, so recovering an image-cap refusal that way would burn a
          // compaction and then fail again identically — with the history now shorter and the same
          // four images still in it.
          const discovered = mediaLimitFailure(mediaLimitFailureEvent ?? failure)
          if (discovered !== undefined && !publisher.hasAssistantStarted()) {
            // No key means no identity to remember it against; the turn still recovers, it just
            // re-learns the cap next time rather than caching it under a name it does not have.
            const key = imageLimitKey(modelRef)
            const known = key === undefined ? undefined : discoveredImageLimits.get(key)
            // Only re-run when this is NEWS. A cap we already applied and still hit is a different
            // fault (or a cap that does not mean what its message says), and re-running on it would
            // be an unbounded loop dressed as a recovery.
            if (known === undefined || discovered < known) {
              if (key !== undefined) discoveredImageLimits.set(key, discovered)
              // ⭐ PERSIST it through the model seam, so the NEXT process starts warm. The
              // in-process map is why a cold run still loses images: its whole first turn runs with
              // the cap unknown, so `read`'s withholding gate has no number to fire on.
              // ⚠️ Best-effort — a store that will not write must not fail the turn that just
              // recovered, and the map still holds it for this process either way.
              if (modelRef !== undefined) yield* models.rememberImageLimit(modelRef, discovered).pipe(Effect.ignore)
              yield* Log.event("session.media.limit.learned", {
                "session.id": session.id,
                "media.limit": discovered,
              })
              return yield* Effect.die(retryUnderImageBudget(currentStep))
            }
            if (mediaLimitFailureEvent) yield* publish(mediaLimitFailureEvent)
          }
          if (
            recoverOverflow &&
            !publisher.hasAssistantStarted() &&
            isContextOverflowFailure(overflowFailure ?? failure) &&
            (yield* restore(recoverOverflow({ sessionID: session.id, entries, model, request })))
          )
            return yield* Effect.die(continueAfterOverflowCompaction(currentStep))
          if (overflowFailure) yield* publish(overflowFailure)
          const llmFailure = failure instanceof LLMError ? failure : undefined
          if (
            llmFailure &&
            !publisher.hasProviderError() &&
            publisher.stepSettlement() !== undefined &&
            ProviderRetry.isBrokenResponse(llmFailure)
          ) {
            // Some compatible servers send a valid finish_reason and then sever the SSE body before
            // `[DONE]`. The semantic reply is already complete; the damaged transport epilogue is not
            // allowed to retroactively turn it into an error or provoke an unnecessary continuation.
            handledResponseFailure = true
            yield* Log.event("session.provider.response.broken", {
              "session.id": session.id,
              "session.provider.reason": llmFailure.reason._tag,
              "session.provider.message": llmFailure.reason.message,
            })
          } else if (
            llmFailure &&
            !publisher.hasProviderError() &&
            publisher.hasAssistantStarted() &&
            publisher.stepSettlement() === undefined &&
            ProviderRetry.isBrokenResponse(llmFailure)
          ) {
            brokenResponse = true
            handledResponseFailure = true
            needsContinuation = true
            yield* Log.event("session.provider.response.broken", {
              "session.id": session.id,
              "session.provider.reason": llmFailure.reason._tag,
              "session.provider.message": llmFailure.reason.message,
            })
            yield* withPublication(publisher.breakAssistant())
          } else if (llmFailure && !publisher.hasProviderError()) {
            yield* withPublication(
              publisher.failUnsettledTools(
                { message: "Provider did not return a tool result", _tag: "ToolFailure" },
                true,
              ),
            )
            // ⚠️ `retryable` is the RUNNER's verdict, not `LLMError.retryable`. The schema getter answers
            // "does this reason class permit a retry" and says **false** for `Transport` — while the
            // runner's own retry loop above treats exactly that as transient and retries it. The user's
            // question is the runner's, so it is the runner's answer that goes on the wire.
            yield* withPublication(
              publisher.failAssistant({
                message: llmFailure.reason.message,
                _tag: llmFailure.reason._tag,
                retryable: ProviderRetry.isTransientProviderFailure(llmFailure),
                ...(ProviderRetry.statusCode(llmFailure) === undefined
                  ? {}
                  : { status: ProviderRetry.statusCode(llmFailure) }),
              }),
            )
          } else if (
            stream._tag === "Success" &&
            !publisher.hasAssistantStarted() &&
            !publisher.hasProviderError() &&
            overflowFailure === undefined &&
            !steerInterrupt &&
            !needsContinuation
          ) {
            // 🔴 A stream that SUCCEEDS having emitted nothing. Every branch above is gated on
            // `llmFailure`, so this case fell through all of them and the turn ended silently: one
            // provider request, no assistant row, and the drain settling `Exit Success` with a
            // transcript holding only the user's message.
            //
            // That is ruling 2 — *a failed mutation never reports success* — broken at the drain
            // itself, and it is invisible from above: R5's retry/stop UI, the execution-attempt ledger
            // and an agent awaiting `exit()` all read "success" and see the user's turn simply not
            // answered, with nothing to retry and nothing naming a fault.
            //
            // `InvalidProviderOutput` rather than a new tag: an empty body IS invalid provider output,
            // and that tag already carries a display arm and its localisations. `retryable` is true
            // because it usually is — a local server under load returns an empty body and the same
            // request succeeds on the next attempt.
            //
            // ⚠️ The four negative guards are all load-bearing, and each one names a LEGITIMATE way a
            // turn ends without assistant output: an overflow being recovered, a provider error already
            // published, a steer cutting the stream, or a continuation already scheduled. Without them
            // this would report a fault on paths that are working correctly — which is the same ruling
            // broken in the other direction.
            yield* Log.event("session.provider.response.empty", { "session.id": session.id })
            yield* withPublication(
              publisher.failAssistant({
                message: "The provider returned an empty response",
                _tag: "InvalidProviderOutput",
                retryable: true,
              }),
            )
          }
          // 🔴 HEALTH BOOKKEEPING for the owner's "or gives errors" fallback — recorded here because
          // this is the point where a turn's outcome is finally known, after the retry loop has done
          // everything it can. A failure that reaches here is an endpoint that failed, was retried to
          // exhaustion, and failed again; `runner/model.ts` routes the NEXT turn around a model that
          // does that twice inside ten minutes, and back onto it the moment one turn works.
          //
          // ⚠️ Deliberately not counting a turn that produced assistant output and then broke: the
          // endpoint plainly served, and demoting on a damaged epilogue would move a colleague off a
          // working model. Both branches are best-effort — health tracking must never fail a turn.
          //
          // ⚠️ Keyed on the model the turn RAN on (`model.provider`/`model.id` — the same pair
          // `observeServing` uses), never on `modelRef`. `models.ref` reports what the session
          // SELECTED, which after a fallback is the sick model rather than the one that answered:
          // keying on it would let a successful turn on the healthy substitute clear the sick model's
          // record, send the next turn back to it, and flap one failed turn per cycle forever.
          // ⚠️ **CATALOG identity, and the wire id is a different string.** `fromCatalogModel` builds
          // the route with `id: model.api.id` — a model may deliberately route requests under an api
          // id while the catalog, the config and the user know it by another (`test-model` vs
          // `api-test-model` in `session-runner-model.test.ts`). `runner/model.ts` asks
          // `ModelHealth.sick(selected)` with the CATALOG entry, so recording under the wire id would
          // file every failure where nothing ever looks for it — the tracker would count forever and
          // the fallback would never fire. It happens to agree for `spark-holo/holo3.1`, which is
          // exactly why this survived being driven.
          const ranOn = modelRef ?? { providerID: String(model.provider), id: String(model.id) }
          // ⚠️ **`hasAssistantFailed`, and the two obvious predicates are both WRONG here** — the
          // integration test caught each in turn. `llmFailure` alone misses a provider that streams
          // its fault as a `providerError` EVENT (the ordinary shape for an OpenAI-compatible
          // endpoint) and leaves the thrown channel empty. And `!hasAssistantStarted()` is never true
          // after a failure, because `failAssistant` OPENS an assistant message to hang the failure
          // off — so "the model never started" reads false on exactly the turns that failed hardest.
          // What decides this is whether the turn ended in a durable assistant failure.
          //
          // ⚠️ `handledResponseFailure` excludes the turn that ANSWERED and then broke in its
          // epilogue: the endpoint plainly served, and demoting a colleague's model for a damaged
          // `[DONE]` would move it off something that works.
          const turnFailed = publisher.hasAssistantFailed() && !handledResponseFailure
          if (turnFailed) {
            ModelHealth.failed(ranOn, yield* Clock.currentTimeMillis)
          } else if (!publisher.hasAssistantFailed()) {
            ModelHealth.succeeded(ranOn)
          }
          if (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) yield* FiberSet.clear(toolFibers)
          const settled = yield* restore(awaitToolFibers(toolFibers)).pipe(Effect.exit)
          if (settled._tag === "Failure" && isQuestionRejected(settled.cause)) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(
              publisher.failUnsettledTools({
                message: "Tool execution interrupted",
                _tag: "Interrupted",
                retryable: false,
              }),
            )
            return yield* Effect.interrupt
          }
          if (
            (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) ||
            (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
          ) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(
              publisher.failUnsettledTools({
                message: "Tool execution interrupted",
                _tag: "Interrupted",
                retryable: false,
              }),
            )
            if (publisher.hasActiveAssistant())
              yield* withPublication(
                publisher.failAssistant({
                  message: "Provider turn interrupted",
                  _tag: "Interrupted",
                  retryable: false,
                }),
              )
          }
          if (settled._tag === "Failure" && !Cause.hasInterrupts(settled.cause)) {
            const failure = Cause.squash(settled.cause)
            const message = failure instanceof Error ? failure.message : String(failure)
            yield* withPublication(
              publisher.failUnsettledTools({ message: `Tool execution failed: ${message}`, _tag: "ToolFailure" }),
            )
          }
          if (brokenResponse)
            yield* withPublication(
              publisher.failUnsettledTools({
                message: "The model reply ended before this tool call was complete",
                _tag: "ToolFailure",
              }),
            )
          const stepSettlement = publisher.stepSettlement()
          if (stepSettlement && !publisher.hasProviderError()) {
            const endSnapshot = ShortChat.enabled(config.shortChat)
              ? undefined
              : yield* Effect.gen(function* () {
                  // The COMPARISON — diffed against the baseline to produce the changed-file list.
                  yield* timingStart("snapshot-after")
                  const captured = yield* snapshots.capture({
                    timing: { start: timing.detailStart, end: timing.detailEnd },
                  })
                  yield* timingEnd("snapshot-after")
                  return captured
                })
            const files =
              startSnapshot && endSnapshot
                ? yield* snapshots
                    .files({ from: startSnapshot, to: endSnapshot })
                    .pipe(Effect.catch(() => Effect.succeed(undefined)))
                : undefined
            yield* withPublication(
              events.publish(SessionEvent.Step.Ended, {
                sessionID: session.id,
                timestamp: yield* DateTime.now,
                assistantMessageID: yield* publisher.startAssistant(),
                finish: stepSettlement.finish,
                cost: 0,
                tokens: stepSettlement.tokens,
                context: {
                  window: packed.contextSize,
                  estimatedTokens: packed.estimatedTokens,
                  droppedMessages: packed.dropped,
                  elidedOutputs: packed.elided,
                  findings: [...packed.findings],
                },
                timing: timing.snapshot(),
                snapshot: endSnapshot,
                files,
              }),
            )
            // ps freshness (owner 2026-07-22): Step.Ended's projection just folded this step's
            // tokens into the session row (applyUsage), but nothing published the record — task
            // managers kept a stale token count until reload. Re-publish the full record so the
            // per-step totals tick live everywhere; the within-step estimate rides the delta
            // stream client-side. Identity merge = "publish the row as it now stands".
            yield* SessionPatch.patchSessionRecord({ db, events }, session.id, (info) => info).pipe(Effect.ignore)
            // 1M/A6(7) — ctx_pressure tripwire: the server-REPORTED prompt size vs the window.
            // At ≥95% the real prompt has outgrown the chars/4 estimate; the next request risks
            // silent server-side truncation. Logs actual-vs-estimate for calibration.
            const reportedPrompt =
              stepSettlement.tokens.input + stepSettlement.tokens.cache.read + stepSettlement.tokens.cache.write
            if (ContextPack.ctxPressure(reportedPrompt, packed.contextSize))
              yield* Log.event("session.context.pressure.high", {
                "session.id": session.id,
                "session.prompt.tokens": reportedPrompt,
                "session.estimated.tokens": packed.estimatedTokens,
                "session.context.size": packed.contextSize,
              })
          }
          if (publisher.hasProviderError())
            yield* withPublication(
              publisher.failUnsettledTools({
                message: "Tool execution interrupted",
                _tag: "Interrupted",
                retryable: false,
              }),
            )
          if (stream._tag === "Success" && !publisher.hasProviderError())
            yield* withPublication(
              publisher.failUnsettledTools(
                { message: "Provider did not return a tool result", _tag: "ToolFailure" },
                true,
              ),
            )
          if (stream._tag === "Failure" && !handledResponseFailure) return yield* Effect.failCause(stream.cause)
          if (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
            return yield* Effect.failCause(settled.cause)
          // F2: the settled provider finish reason travels out with the turn. It is the only
          // GROUND TRUTH about why the turn ended — every other tell the drain reads downstream
          // (empty turn, confident-sounding final text) is a heuristic over the text. `undefined`
          // means the step never settled at all (provider failure / interrupt), which is not a
          // truncation. `finish` is a widened `string` here because that is how the publisher
          // stashes `step-finish`'s reason; `finish-recovery.ts` pins the literal to the schema.
          return {
            needsContinuation: !publisher.hasProviderError() && needsContinuation,
            // ⚠️ REPORTED, never acted on here. A turn states the fact; the drain loop below is the
            // one place that decides what a halt does, because the decision has three parts (stop
            // continuing, skip the turn-end machinery, and do not restart from the queue or the
            // self-drive) and splitting them across two scopes is how one of them gets forgotten.
            policyHalted,
            step: currentStep,
            finish: stepSettlement?.finish,
            brokenResponse,
            maxProviderAttempts,
            offeredTools: toolMaterialization?.definitions.map((definition) => definition.name) ?? [],
          }
        })
      const attemptID = EventV2.ID.create()
      const startedAt = yield* DateTime.now
      const providerRecovery = {
        attemptID,
        assistantMessageID,
        model: attemptModelRef,
        startedAt,
        toolProtocol: false,
      }
      yield* SessionExecutionAttempt.providerStartedCurrent(providerRecovery)
      yield* events.publish(SessionEvent.ProviderAttempt.Started, {
        sessionID: session.id,
        timestamp: startedAt,
        recovery: providerRecovery,
      })
      yield* timingEnd("provider-setup")
      return yield* ProviderDispatch.runAndSettle(
        {
          events,
          scheduler,
          sessionID: session.id,
          slot: dispatchSlot,
          maxAttempts: maxProviderAttempts,
          hasOutput: publisher.hasAssistantStarted,
          costTokens: () => {
            if (publisher.hasProviderError()) return undefined
            const settlement = publisher.stepSettlement()
            return settlement === undefined ? undefined : settlement.tokens.input + settlement.tokens.output
          },
          attempt: providerStream,
          timing: {
            queued: timing.queued,
            admitted: timing.admitted,
            attemptStarted: timing.attemptStarted,
            attemptSettled: timing.attemptSettled,
            live: timing.live,
          },
        },
        generation,
      ).pipe(
        Effect.onExit((exit) =>
          events
            .publish(SessionEvent.ProviderAttempt.Settled, {
              sessionID: session.id,
              timestamp: DateTime.makeUnsafe(Date.now()),
              attemptID,
              outcome:
                exit._tag === "Success" ? "completed" : Cause.hasInterrupts(exit.cause) ? "interrupted" : "failed",
            })
            .pipe(Effect.andThen(SessionExecutionAttempt.providerSettledCurrent(attemptID)), Effect.ignore),
        ),
      )
    }, Effect.scoped)
    type RunTurn = (
      sessionID: SessionSchema.ID,
      harness: Harness,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      timing?: TurnTiming.Recorder,
    ) => Effect.Effect<
      {
        readonly needsContinuation: boolean
        /** A pre-action policy returned `halt`: end the whole drain, not just this turn. */
        readonly policyHalted: boolean
        readonly step: number
        readonly finish: string | undefined
        readonly brokenResponse: boolean
        readonly maxProviderAttempts: number
        readonly offeredTools: readonly string[]
      },
      RunError
    >

    // ⚠️ The compaction re-entries below carry the SAME `harness` deliberately. A turn that overflows
    // and is retried over compacted history is still ONE turn — re-deriving mid-retry would let the
    // second attempt compose a different system prompt than the first, which is the within-turn
    // incoherence B7 is trying not to introduce. The next turn re-derives (see `run`).
    const runAfterOverflowCompaction: RunTurn = Effect.fnUntraced(function* (
      sessionID,
      harness,
      promotion,
      step,
      timing = TurnTiming.make(),
    ) {
      return yield* runTurnAttempt(sessionID, harness, promotion, step, undefined, timing).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            // A learned cap is applied by REBUILDING the request, which the ordinary re-entry does.
            if (defect.transition._tag === "RetryUnderImageBudget")
              return yield* runAfterOverflowCompaction(sessionID, harness, undefined, defect.transition.step, timing)
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* Effect.die("Post-compaction provider attempt cannot recover another overflow")
            yield* Effect.yieldNow
            return yield* runAfterOverflowCompaction(sessionID, harness, undefined, defect.transition.step, timing)
          }),
        ),
      )
    })

    const runTurn: RunTurn = Effect.fnUntraced(function* (
      sessionID,
      harness,
      promotion,
      step,
      timing = TurnTiming.make(),
    ) {
      return yield* runTurnAttempt(
        sessionID,
        harness,
        promotion,
        step,
        harness.compaction.compactAfterOverflow,
        timing,
      ).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            yield* Effect.yieldNow
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* runAfterOverflowCompaction(sessionID, harness, undefined, defect.transition.step, timing)
            return yield* runTurn(sessionID, harness, undefined, defect.transition.step, timing)
          }),
        ),
      )
    })

    // F1a SLICE 7 - the manual-compaction cycle (consume-side of SessionCompactionRequest). Runs
    // `prepareTurn` - literally the same assembly as the drain, no longer a copy of it - but hands
    // the entries straight to the compactor and drains NO turn. It lives in the runner because only
    // the runner holds the shared LLMClient (the OFF-C offline chokepoint) and the model resolution.
    // Failures surface as a calm Synthetic notice (the "never breaks" rule: an invisible no-op
    // compact is a broken button) and never fail the drain.
    const runManualCompaction = Effect.fn("SessionRunner.manualCompaction")(function* (
      sessionID: SessionSchema.ID,
      // Passed in for the same two reasons `runTurnAttempt` takes its harness: the session-config
      // walk below shadows `config`, and a manual `/compact` must honour the compaction settings as
      // they are NOW, not as they were when the location booted.
      compaction: Harness["compaction"],
    ) {
      const prepared = yield* prepareTurn(sessionID)
      // Not ours: another location owns this session and will run its own compaction.
      //
      // ⚠️ It SAYS so. This used to return in silence, which is the same nothing the Compact button
      // produced before the marker became durable — and a user cannot tell "another location has
      // this" from "the button is broken" by looking at an unchanged screen. Every other outcome of
      // this cycle already speaks; this one was the last mute path.
      if (prepared === undefined) {
        yield* events.publish(SessionEvent.Synthetic, {
          sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          text: "⚠️ Compaction didn't run here — another window or instance owns this chat right now. Try again from there, or once it is idle.",
        })
        return
      }
      const { session, model, entries } = prepared
      // The compactor reads only `generation?.maxTokens` (else the model's own output limit)
      // from the request — a minimal envelope is enough.
      const request = LLM.request({ model, messages: [], tools: [] })
      const compacted = yield* compaction.compactAfterOverflow(
        { sessionID: session.id, entries, model, request },
        "manual",
      )
      // The archive runs on BOTH compaction paths, and it did not until now — the automatic branch
      // had it and this one did not, so a user who pressed Compact lost the older half of the
      // conversation to a summary while the same conversation compacted automatically kept it. One
      // rule, two doors: the same class of gap as `agent.remove` missing the refresh the config path
      // already had.
      if (compacted)
        yield* archiveCompactedChat({
          entries,
          agent: yield* agents.select(prepared.config.agent as typeof session.agent),
          memory,
          session,
        }).pipe(reportArchiveFailure(session.id, prepared.config.agent))
      yield* Log.event("session.compaction.manual.settled", { "session.id": session.id, compacted })
      if (!compacted)
        yield* events.publish(SessionEvent.Synthetic, {
          sessionID: session.id,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          text: "⚠️ Compaction didn't run — the conversation is still small enough that there is nothing to fold up, or the summary model was unavailable.",
        })
    })

    const runStrictDrain = StrictDrain.make({
      events,
      llm,
      models,
      store,
      location,
      snapshots,
      messengerStore,
      offline,
      maintenance,
      scheduler,
      db,
    })

    const run = Effect.fn("SessionRunner.run")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly force: boolean
    }) {
      // Arm the 30s title fallback for LONG turns. A short turn finishes first and titles at drain end as
      // before; a compile-test-retry turn gets a name while it is still working, instead of sitting in the
      // chat list as a placeholder for minutes.
      yield* maintenance.scheduleEarlyTitle(input.sessionID)
      // A manual compaction request is consumed FIRST: it may ride a wake with no pending input
      // (the early return below must not skip it), it must not force a model turn itself, and
      // when input IS pending the drain proceeds over the freshly compacted history.
      if (yield* compactionRequests.consume(input.sessionID)) {
        // B7 tier-1: derived HERE rather than at the top of `run`, because a wake with nothing to do
        // returns a few lines below and must not pay for a settings read it never uses.
        const manual = yield* harnessConfig()
        yield* runManualCompaction(input.sessionID, manual.compaction).pipe(
          Effect.catchCause((cause: Cause.Cause<unknown>) =>
            Log.event("session.compaction.manual.failed", {
              "session.id": input.sessionID,
              "session.cause": Log.fault(cause),
            }).pipe(
              Effect.andThen(
                Effect.gen(function* () {
                  yield* events.publish(SessionEvent.Synthetic, {
                    sessionID: input.sessionID,
                    messageID: SessionMessage.ID.create(),
                    timestamp: yield* DateTime.now,
                    text: "⚠️ Compaction couldn't run — see the server log for details.",
                  })
                }).pipe(Effect.ignore),
              ),
            ),
          ),
        )
      }
      const hasSteer = yield* SessionInput.hasPending(db, input.sessionID, "steer")
      const hasQueue = hasSteer ? false : yield* SessionInput.hasPending(db, input.sessionID, "queue")
      if (!input.force && !hasSteer && !hasQueue) return
      // B10: live control handoff — when a human operator has taken control, Nova does NOT
      // auto-respond. Input still QUEUES durably (nothing lost); it drains the moment control
      // is handed back to nova. Resolve via the config walk so a child inherits the parent's
      // responder unless it overrides.
      const handoff = yield* effective.resolve(input.sessionID)
      if (handoff.responder === "operator") {
        yield* Log.event("session.control.operator", { "session.id": input.sessionID })
        return
      }
      const providerRecovery =
        (yield* SessionExecutionAttempt.providerRecoveryCurrent()) ??
        (yield* store.get(input.sessionID))?.providerRecovery
      if (providerRecovery) {
        yield* events.publish(SessionEvent.Synthetic, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          text:
            "⚠️ NovaClaw recovered a provider turn interrupted by process loss. Any response content already saved is still here. " +
            (providerRecovery.toolProtocol
              ? "A tool may have changed its target, so inspect the workspace or external system before repeating it."
              : "The interrupted turn will not run again automatically."),
        })
        yield* failInterruptedTools(
          input.sessionID,
          "Tool outcome unknown after process restart; inspect target state before retrying",
        )
        yield* events.publish(SessionEvent.ProviderAttempt.Abandoned, {
          sessionID: input.sessionID,
          timestamp: yield* DateTime.now,
          attemptID: providerRecovery.attemptID,
          reason: "new-input",
        })
        yield* SessionExecutionAttempt.providerSettledCurrent(providerRecovery.attemptID)
      } else {
        yield* failInterruptedTools(input.sessionID)
      }
      yield* maintenance.markChangesIncomplete(input.sessionID)
      // B7 tier-1 / ruling 3 — the DRAIN-ENTRY derivation, placed after every early return so a wake
      // that does nothing reads nothing. It answers only the questions asked before any turn exists:
      // the Strict routing decision and the once-per-session quality-provision nudge. Each turn below
      // derives its OWN (see the inner loop) — this value is deliberately NOT reused there, because a
      // long drain is exactly the case where a settings change must land without waiting for the next
      // message.
      const entryHarness = yield* harnessConfig()
      // P14-minimal (jh-improve8 P3): the Strict-harness route. The effective strict config is the
      // global `config.strict` overlaid with the session's own override (the composer switch, resolved
      // through the config walk so children inherit) — it routes the drain through JhEngine.runTask
      // (jh.md — the harness owns decomposition/verification/recovery). It executes shell/write actions
      // autonomously, so it requires an autonomous permission mode; below that the toggle must not
      // silently bypass the permission model — the drain says why and answers normally instead.
      const strictEffective = { ...(entryHarness.strict ?? {}), ...(handoff.strict ?? {}) }
      if (strictEffective.enabled === true) {
        if (handoff.permissionMode === "bypass" || handoff.permissionMode === "yolo") {
          const outcome = yield* runStrictDrain(
            input.sessionID,
            entryHarness,
            handoff,
            hasSteer ? "steer" : hasQueue ? "queue" : undefined,
          )
          // "handled": engine work ran — its detached finalizer owns the maintenance (it must run
          // even after a Stop interrupts this fiber). "chat": the routed message is conversational —
          // fall THROUGH to the normal loop below (it runs the turn over the already-promoted
          // context and ends with its own post-run maintenance).
          if (outcome === "handled") return
        } else {
          yield* Effect.gen(function* () {
            yield* events.publish(SessionEvent.Synthetic, {
              sessionID: input.sessionID,
              messageID: SessionMessage.ID.create(),
              timestamp: yield* DateTime.now,
              text: "🛡️ Strict mode is enabled, but this chat's permission mode doesn't allow autonomous execution — switch the permission mode to Bypass to run the Strict harness. Answering normally instead.",
            })
          }).pipe(Effect.ignore)
        }
      }
      // 1E: track which repeated-call loops we have already redirected this drain, so a
      // persistent loop is nudged once (not every turn). 1N/A2 adds a per-target failure-streak
      // latch + a once-per-drain runaway latch; 1N/A3 a consecutive-empty-turn counter.
      const nudged = new Set<string>()
      const nudgedTargets = new Set<string>()
      let runawayNudged = false
      let consecutiveEmpty = 0
      let regrounded = false
      /** How many times this drain has steered the turn back to the rest of a set. Bounded by
       *  `UnfinishedSet.MAX_STEER_ROUNDS` — an automatic drive needs a visible ceiling, exactly as
       *  the self-drive's own round cap does. */
      // Latched per drain: one re-prompt for a narrated-but-uncalled tool. A second would mean the
      // call cannot get through at all, which is the empty-turn diagnostic's territory.
      // Latched per drain: one correction for describing files that were never opened. A second
      // would be arguing with a model that has already been told plainly.
      let groundingCorrected = false
      let announcedRecovered = false
      let setRounds = 0
      // Rounds in a row that opened nothing new — the drive's real stop condition. Tracked here
      // beside `setRounds` because both are per-request state that must survive a turn boundary.
      // Silent-no-op guard: one steer per drain when a no-tool-call turn looks like an attempted call.
      let textualNudged = false
      // F2 output-token truncation ledger — PER-DRAIN, like every latch above it (see
      // `finish-recovery.ts` `initialState` for why per-turn never trips and per-session never
      // clears). One steer back to the cutoff, then the drain stops honestly.
      const finishRecovery = FinishRecovery.initialState()
      let truncationHalted = false
      /**
       * A pre-action policy returned `halt` during this drain.
       *
       * Drain-level for `truncationHalted`'s reason: ending only the inner step loop would let the
       * queue promotion or the self-drive continuation below start the model straight back up, and a
       * halt that the next continuation undoes is not a halt. New input still wakes a FRESH drain
       * through the coordinator, where the policy is consulted again — a halt stops this run, it does
       * not disable the session.
       */
      let policyHalted = false
      const quality = Quality.initialState()
      // Self-drive state (architecture.md "run until exit()"): per-DRAIN round/wall counters —
      // a fresh drain (any new message) re-arms a cap-paused autonomous session.
      const driveState = SessionDrive.initialState(DateTime.toEpochMillis(yield* DateTime.now))
      // QE-A: quality mode with NO provisioned commands is inert — steer ONCE per session
      // to run the provisioner (deterministic manifest scan → verify → write project config).
      // Once-per-session, so the drain-entry view is the right one to judge it on.
      if (
        (handoff.quality ?? entryHarness.quality.enabled) &&
        !Object.values(entryHarness.quality.commands).some(Boolean) &&
        !provisionNudged.has(input.sessionID)
      ) {
        provisionNudged.add(input.sessionID)
        if (provisionNudged.size > 500) provisionNudged.clear()
        yield* SessionInput.steer(db, events, input.sessionID, QualityProvision.NUDGE)
      }
      let promotion: SessionInput.Delivery | undefined = hasSteer ? "steer" : hasQueue ? "queue" : undefined
      let shouldRun = input.force || hasSteer || hasQueue
      // The drain-stop (architecture.md step 5): `exit(result)` ends the RUN, not just the drive.
      // Snapshot the pre-drain state so only the exit TRANSITION stops this drain — a session
      // whose result was already recorded (the user talking to a completed chat) runs normally.
      const alreadyExited =
        (yield* store.get(input.sessionID).pipe(Effect.orElseSucceed(() => undefined)))?.result !== undefined
      let exitedMidDrain = false
      while (shouldRun) {
        let needsContinuation = true
        let step = 1
        let brokenResponseAttempts = 0
        while (needsContinuation) {
          // ⚠️ THE per-turn read (B7 tier-1 / ruling 3). One `config.entries()` per turn, threaded
          // through everything this turn does — the system prompt, the compactor, the sampling
          // overlay, the introspection judge, the quality gate. Deriving per USE instead would let a
          // single turn observe two different settings snapshots; deriving per DRAIN (or, as before,
          // per location boot) is what made "restart to apply" the honest answer. The T1 per-session
          // stances ride along: an explicit true/false on the config chain wins, no stance = global.
          const harness = yield* harnessConfig()
          const qualityOn = !ShortChat.enabled(handoff.shortChat) && (handoff.quality ?? harness.quality.enabled)
          const introspectionOn =
            !ShortChat.enabled(handoff.shortChat) && (handoff.introspection ?? harness.introspection.enabled)
          const result = yield* runTurn(input.sessionID, harness, promotion, step)
          needsContinuation = result.needsContinuation
          if (result.policyHalted) {
            policyHalted = true
            needsContinuation = false
            break
          }
          step = result.step + 1
          promotion = "steer"
          // exit(result) landed during this turn → stop the run NOW: no tool-call continuation,
          // no steer re-arm, no nudge machinery (post-exit, harness steers used to resurrect the
          // "finished" agent — owner-hit 2026-07-22 on a story-writing goal session). Input that
          // arrived meanwhile is safe: its admission fired a wake, and the coordinator's
          // pendingWake starts a FRESH drain (where alreadyExited = true → normal conversation).
          if (!alreadyExited) {
            const latest = yield* store.get(input.sessionID).pipe(Effect.orElseSucceed(() => undefined))
            if (latest?.result !== undefined) {
              exitedMidDrain = true
              yield* Log.event("session.drain.exit", {
                "session.id": input.sessionID,
                step,
              })
              break
            }
          }
          // A malformed stream tail is a damaged transport frame, not a fatal conversation. The
          // partial assistant turn is already durable with finish=`broken`; reconnect as a NEW turn
          // so its content and completed tool results ground the model without replaying actions.
          if (result.brokenResponse) {
            brokenResponseAttempts++
            if (brokenResponseAttempts < result.maxProviderAttempts) {
              const delay = ProviderRetry.retryDelayMs(brokenResponseAttempts)
              yield* events
                .publish(SessionStatusEvent.Status, {
                  sessionID: input.sessionID,
                  status: {
                    type: "retry",
                    attempt: brokenResponseAttempts + 1,
                    message: "The model reply ended early. NovaClaw kept the usable part and is reconnecting…",
                    next: Date.now() + delay,
                  },
                })
                .pipe(Effect.ignore)
              yield* Effect.sleep(Duration.millis(delay))
              needsContinuation = true
              continue
            }
            yield* events
              .publish(SessionEvent.Synthetic, {
                sessionID: input.sessionID,
                messageID: SessionMessage.ID.create(),
                timestamp: yield* DateTime.now,
                text: `The model connection ended early ${result.maxProviderAttempts} times. NovaClaw kept every usable part and stopped reconnecting for now. You can try again, reduce the response length, or check the model server's logs and timeout settings.`,
              })
              .pipe(Effect.ignore)
            needsContinuation = false
            break
          }
          brokenResponseAttempts = 0
          // F2 — the provider stopped this turn at its OUTPUT-TOKEN LIMIT (finish=length) and the
          // drain is not already continuing: the answer is truncated, not finished. This runs
          // BEFORE the heuristic nudge chain below and short-circuits it on purpose — those
          // branches (empty-turn recovery, textual-call, finish re-grounding) are guesses about
          // *why* a turn ended, and here the provider has told us; re-grounding a guillotined
          // sentence or diagnosing a reasoning-only truncation as a lost tool call would both be
          // the wrong advice. The steer rides `SessionInput.steer`, so it carries the 1N provenance
          // prefix and is never read back as the user speaking. `consecutiveEmpty` is deliberately
          // left as it stands: a truncated turn is neither progress nor an empty-turn strike.
          const truncation = FinishRecovery.decide(result.finish, result.needsContinuation, finishRecovery)
          if (truncation.kind === "continue") {
            yield* Log.event("session.finish.recover", {
              "session.id": input.sessionID,
              step,
              recoveries: finishRecovery.recoveries,
            })
            yield* SessionInput.steer(db, events, input.sessionID, truncation.message)
            needsContinuation = true
            continue
          }
          if (truncation.kind === "stop") {
            // The MECHANICAL half of the bound. Steering again would just buy another truncated
            // turn, so end the drain with a visible notice naming the actual fix. Any new input
            // re-wakes a FRESH drain through the coordinator's pendingWake (same guarantee the
            // exit-transition break above relies on), where the ledger starts at zero again.
            yield* Log.event("session.finish.recover.paused", {
              "session.id": input.sessionID,
              step,
            })
            yield* Effect.gen(function* () {
              yield* events.publish(SessionEvent.Synthetic, {
                sessionID: input.sessionID,
                messageID: SessionMessage.ID.create(),
                timestamp: yield* DateTime.now,
                text: truncation.notice,
              })
            }).pipe(Effect.ignore)
            truncationHalted = true
            break
          }
          const context = yield* getContext(input.sessionID)
          // 🔴 LATCH THE REQUEST HERE — on every turn, not at the finish branch.
          //
          // Measured run 16: the latch lived only in the set-completion branch, which runs when a
          // turn ENDS. That run compacted before its first turn ended, so by the time the branch
          // looked, the prompt was already summarised away: `asked: false`, one branch entry, the
          // drive never engaged, 81 files. Run 15's turns ended sooner, its latch caught the prompt
          // in time, and it reached 220 — the difference was entirely WHEN the latch got to look.
          //
          // ⚠️ A latch that only fires at a late point has not been latched at all; it has merely
          // moved the race. Here it runs on turn one, while the prompt is certainly present, and the
          // `has` guard keeps every later turn a no-op.
          if (!setRequests.has(input.sessionID)) {
            const firstText = lastRealUserText(context)
            if (firstText !== undefined)
              setRequests.set(input.sessionID, {
                // 🔴 An explicit DELEGATION order is not a set for the harness to drive. Same
                // exemption as the spawn gate above, applied at the latch so the STEER is suppressed
                // too. Measured on Qwen3.6-35B 2026-08-22: an officer told to spawn six sub-agents did
                // exactly that, reported the six child ids — and was then steered into reading
                // `.gitattributes`, `.gitignore`, `AGENTS.md` one at a time, because "each" had marked
                // the request as an unfinished set. The work was delegated; the set the harness went
                // looking for was its own invention.
                asked: UnfinishedSet.asksForSet(firstText) && !UnfinishedSet.asksToDelegate(firstText),
                ...(UnfinishedSet.requestedLimit(firstText) === undefined
                  ? {}
                  : { limit: UnfinishedSet.requestedLimit(firstText) }),
              })
          }
          // 1E doom-loop break: only while the model is still acting (made a tool call).
          // If its last few tool calls are byte-identical, inject a one-shot redirect as a
          // steer so the next turn is nudged to change approach.
          if (result.needsContinuation) {
            consecutiveEmpty = 0 // 1N/A3: a tool call is genuine progress — re-arm empty-turn recovery.
            const calls = context.flatMap((message) =>
              message.type === "assistant"
                ? message.content.flatMap((part) =>
                    part.type === "tool"
                      ? [
                          {
                            name: part.name,
                            input:
                              typeof part.state.input === "string"
                                ? part.state.input
                                : JSON.stringify(part.state.input),
                          },
                        ]
                      : [],
                  )
                : [],
            )
            const looping = detectDoomLoop(calls)
            const key = looping ? `${looping.name}\x00${looping.input}` : undefined
            if (looping && key !== undefined && !nudged.has(key)) {
              nudged.add(key)
              yield* SessionInput.steer(db, events, input.sessionID, redirectMessage(looping))
            }
            // 1N/A2: target-keyed failure streak + runaway self-check over the tool calls made
            // since the last user message. Catches the loops the byte-identical detector misses
            // (small models always reword) and the plausible non-failing re-read/re-grep runaway.
            const sinceUser = toolCallsSinceLastUser(context)
            const streak = detectFailureStreak(sinceUser)
            if (streak && !nudgedTargets.has(streak.target)) {
              nudgedTargets.add(streak.target)
              yield* Log.event("session.doom.streak.detected", {
                "session.id": input.sessionID,
                "session.tool": streak.name,
                "session.target": streak.target,
                count: streak.count,
              })
              yield* SessionInput.steer(db, events, input.sessionID, failureStreakMessage(streak))
            }
            // 🔴 The runaway threshold RISES with the work the harness itself asked for. Measured
            // 2026-08-20: a legitimate "describe the first 100 png files" made 96 calls, tripped the
            // 75-call detector, and the nudge — deliberately self-assessment, "if you're stuck, tell
            // the user where things stand" — invited the model to wrap up at ~78 of 100. A detector
            // built to break repetition was ending honest bulk work.
            //
            // ⚠️ Proportional, not disabled: each set-drive round explicitly asked for `STEER_BATCH`
            // more files, so the budget grows by exactly what was requested and by nothing else. With
            // no drive in progress (`setRounds === 0`) the threshold is unchanged, so a genuine loop
            // is caught exactly as before — which is the case this detector exists for.
            const runawayThreshold = RUNAWAY_THRESHOLD + setRounds * UnfinishedSet.STEER_BATCH
            if (!runawayNudged && detectRunaway(sinceUser.length, runawayThreshold)) {
              runawayNudged = true
              yield* Log.event("session.doom.runaway.detected", {
                "session.id": input.sessionID,
                "session.tool.calls": sinceUser.length,
              })
              yield* SessionInput.steer(db, events, input.sessionID, runawayMessage(sinceUser.length))
            }
            // P2 (2A): cadence-gated introspection judge — an out-of-band model call that
            // asks "is this agent stuck?"; a YES steers the interjection (2B). Best-effort:
            // never allowed to fail the drain it watches.
            // ⚠️ This read `Effect.catch`, which sees the ERROR channel only — a defect thrown
            // anywhere under `introspect` (a bug in the judge, a `die`, an unexpected throw inside
            // a `gen`) walked straight past it and killed the drain the comment promises it can
            // never fail. Every sibling best-effort at this level (`runQualityCheck` below,
            // `generateTitleOnce`, `extractMemory`) already uses `catchCause`; this one was the
            // odd one out. The interrupt arm is `execution/local.ts`'s idiom and it is ruling 2:
            // a Stop is not a judge failure, and logging it as one describes a fault falsely.
            if (introspectionOn && Introspection.shouldJudge(step, harness.introspection.cadence))
              yield* introspect(input.sessionID, harness.introspection).pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.void
                    : Log.event("session.introspection.judge.failed", {
                        "session.id": input.sessionID,
                        "session.cause": Log.fault(cause),
                      }),
                ),
              )
            // QE-B steps 1–3: per touched file after a write-class tool settles (syntax +
            // incremental check), whole-module typecheck every Nth write. Best-effort — a
            // broken check command must never break the drain it guards.
            if (qualityOn)
              for (const check of Quality.dueMidLoop(harness.quality, quality, Quality.writeTargets(context)))
                yield* runQualityCheck(input.sessionID, harness.shell, check).pipe(
                  Effect.catchCause((cause) =>
                    Log.event("session.quality.check.errored", {
                      "session.id": input.sessionID,
                      "session.cause": Log.fault(cause),
                    }),
                  ),
                )
          } else if (
            // ⚠️ Logged BEFORE the arms, so a run says which one it took. Measured 2026-08-20: a
            // parent made 66 read calls across 29 steps and `set.branch` never fired ONCE, and
            // nothing in the logs could say whether the drive declined or was never reached. The
            // arms are mutually exclusive `else if`s, so silence from all of them is indistinguishable
            // from silence from one — which is the same trap that cost this programme two days on
            // the fan-out. `false` so the chain below is unchanged.
            yield* Log.event("session.finish.arm", {
              "session.id": input.sessionID,
              "session.finish.empty": isEmptyAssistantTurn(context),
              "session.finish.announced": announcedToolButCalledNone(context),
              "session.finish.calls": toolCallsSinceLastUser(context).length,
            }).pipe(Effect.as(false))
          ) {
            // unreachable — the log arm above always yields false
          } else if (isEmptyAssistantTurn(context)) {
            // 1N/A3: the turn produced no text AND no tool call — typically a tool call streamed
            // into the reasoning channel and dropped by the server's parser. Inject ONE synthetic
            // re-prompt (re-armed on progress above); a SECOND consecutive empty means the re-prompt
            // isn't working, so stop and surface the server-side fix instead of looping silently.
            consecutiveEmpty++
            if (consecutiveEmpty === 1) {
              yield* Log.event("session.turn.empty.recovered", { "session.id": input.sessionID })
              yield* SessionInput.steer(db, events, input.sessionID, EMPTY_TURN_RECOVERY)
            } else {
              yield* Log.event("session.turn.empty.paused", { "session.id": input.sessionID })
              // T4 (1N residue): the user must see WHY the chat went quiet — surface the calm
              // in-chat notice too (it names the server-side fix), not just a server log. Once
              // per drain (consecutiveEmpty === 2 exactly); best-effort like every Synthetic.
              if (consecutiveEmpty === 2)
                yield* Effect.gen(function* () {
                  yield* events.publish(SessionEvent.Synthetic, {
                    sessionID: input.sessionID,
                    messageID: SessionMessage.ID.create(),
                    timestamp: yield* DateTime.now,
                    text: `⚠️ ${EMPTY_TURN_DIAGNOSTIC}`,
                  })
                }).pipe(Effect.ignore)
            }
          } else if (announcedToolButCalledNone(context) && !announcedRecovered) {
            // 🔴 Measured 2026-08-20: "First, let me get a complete listing of all files in the
            // folder:" — then finish=stop, no tool call, nothing done, and the harness recorded a
            // completed turn. `isEmptyAssistantTurn` cannot see it (that needs no text AND no call);
            // this turn is all text. Steer ONCE per drain: the model narrated the call instead of
            // making it, and asking for the call is the whole recovery.
            announcedRecovered = true
            consecutiveEmpty = 0
            yield* Log.event("session.turn.announced.recovered", { "session.id": input.sessionID })
            yield* SessionInput.steer(db, events, input.sessionID, ANNOUNCED_TOOL_RECOVERY)
          } else {
            consecutiveEmpty = 0
            // 2E/A7: finish re-grounding — a substantial turn ending with a clean, confident
            // summary gets ONE "walk your acceptance criteria" re-prompt. Suppressed when the
            // finish already admits an `unverified:` gap (the honesty exemption — re-prompting
            // an honest caveat has been seen to regress it into a confident "it works").
            const finalText = lastAssistantText(context)
            // The SILENT-NO-OP guard (notes/osint/silent-noop-bug.md): this branch means the turn ended
            // with text and NO tool call, which the runner otherwise settles as a finished answer. Three
            // live runs showed the model writing its call as MARKDOWN instead (a ```bash fence, an
            // invented adhoc-tool JSON, a repeated <thinking> block) and the run reporting SUCCESS having
            // done nothing — fatal for an unattended scheduled agent. Steer once; never execute what it
            // wrote (a ```bash fence is ordinary output, so running it would turn docs into execution).
            if (!textualNudged) {
              // Use the exact names this provider turn received. Re-materializing here would lose
              // the turn's agent permissions and model route, and could nudge the model to call a
              // tool that its own horizon never contained.
              const attempted = TextualCall.detect(finalText, result.offeredTools)
              if (attempted) {
                textualNudged = true
                yield* Log.event("session.tool.textual.recovered", {
                  "session.id": input.sessionID,
                  "session.tool.tell": attempted.tell,
                  "session.tool.detail": attempted.detail,
                })
                yield* SessionInput.steer(db, events, input.sessionID, TextualCall.recoveryMessage(attempted))
              }
            }
            // 🔴 The turn answered about SOME of a set the HARNESS enumerated and stopped. Measured
            // 2026-08-20: "please describe each glyph here" opened 1 of 6 images and ended. Checked
            // BEFORE `shouldReground` because that backstop needs 8 tool calls and this failure has
            // one — and because naming the unopened files is a stronger instruction than asking the
            // model to walk its own acceptance criteria. See `unfinished-set.ts` for why every clause
            // is a case that must not fire.
            // ⚠️ Ordered so an ordinary turn does NO work: the user's wording and the turn's own
            // tool calls are both in memory, and the folder is only read once both say a set was
            // asked for and partly covered. `groundingListing` itself lives in the per-provider-turn
            // scope and is not visible here.
            // `lastRealUserText` answers undefined for a files-only prompt (no words to read a set from).
            // Latched on the first turn that HAS a real user text, then never re-derived: after
            // compaction the honest answer to "what did the user ask?" is no longer in the window,
            // and asking again returns a confident wrong answer rather than an absent one.
            const realUserText = lastRealUserText(context)
            if (!setRequests.has(input.sessionID) && realUserText !== undefined)
              setRequests.set(input.sessionID, {
                // Same exemption as the sibling latch above — see its note.
                asked: UnfinishedSet.asksForSet(realUserText) && !UnfinishedSet.asksToDelegate(realUserText),
                ...(UnfinishedSet.requestedLimit(realUserText) === undefined
                  ? {}
                  : { limit: UnfinishedSet.requestedLimit(realUserText) }),
              })
            const setRequest = setRequests.get(input.sessionID)
            const askedForSet = setRequest?.asked ?? false
            // ⚠️ Logged BEFORE either gate. `set.considered` fires only after both pass, so a run that
            // logs it once cannot tell "the branch never ran" from "it ran and declined" — which is
            // exactly the question the 100-icon run left open.
            yield* Log.event("session.finish.set.branch", {
              "session.id": input.sessionID,
              "session.set.asked": askedForSet,
              "session.set.calls": toolCallsSinceLastUser(context).length,
            })
            const openedThisTurn = askedForSet
              ? toolCallsSinceLastUser(context).flatMap((call) => {
                  // ⚠️ `input` is a STRING — `JSON.stringify` of the tool input, or whatever raw text
                  // the model sent. Treating it as an object is why the first version of this check
                  // typechecked, ran, and never fired once.
                  if (call.name !== "read") return []
                  try {
                    const parsed: unknown = JSON.parse(call.input)
                    const path =
                      typeof parsed === "object" && parsed !== null && "path" in parsed
                        ? String((parsed as { readonly path?: unknown }).path ?? "")
                        : ""
                    return path.length > 0 ? [path] : []
                  } catch {
                    // A malformed argument is not a read we can attribute to a file.
                    return []
                  }
                })
              : []
            // 🔴 Was `openedThisTurn.length > 0`, which meant a turn that listed the folder and
            // opened nothing never even reached `shouldContinue` — measured twice on 2026-08-20,
            // `set.branch` fired and `set.considered` never did. The zero case is the one that most
            // needs steering; `MAX_BARREN_ROUNDS` bounds it.
            // ⚠️ `harness.drives.set` gates the whole block, not just the steer: the enumeration
            // below reads the folder from disk, and doing that work to then discard it would make
            // "off" cost the same as "on" while the operator believed it was measuring an unaided
            // model. Off means the drive does not run.
            if (askedForSet && harness.drives.set) {
              // ⚠️ NOT the prompt's 40-name cap — that bound exists so a grounding MESSAGE stays
              // small, and this check pays no prompt cost per name. It asks for exactly as many
              // as the drive could ever complete, so the set it reasons about is the set it can
              // actually finish, and no file is silently outside the world.
              /**
               * 🔴 **THE DIRECTORY THE SET IS IN — from what the model OPENED, not the session cwd.**
               *
               * `readListing` is a flat `readdir`, and `location.directory` is the session's working
               * directory. A request's files are routinely one level down (*"describe every image in
               * folder X"*), so this listed a folder containing none of them. Measured 2026-08-29:
               * `session.set.available: 2` for 40-, 100- AND 400-file corpora alike — the two
               * non-directory entries in the session root — after which the drive told a model that
               * had opened all 100 images to *"open these 2 next: novaclaw, run.log"*.
               *
               * ⚠️ The accumulated `opened` set is used, not this turn's, so the derivation survives
               * compaction for the same reason the coverage does.
               */
              // ⚠️ Union this turn's opens into the request's running total FIRST — the listing below
              // is derived from them. Compaction cannot take these back: they are what the session
              // has actually done.
              const opened = setOpened.get(input.sessionID) ?? new Set<string>()
              for (const name of openedThisTurn) opened.add(name)
              setOpened.set(input.sessionID, opened)
              const setDir = UnfinishedSet.setDirectory([...opened]) ?? location.directory
              const listing = yield* Effect.promise(() =>
                ProjectGrounding.readListing(setDir, UnfinishedSet.MAX_ENUMERATED_SET),
              )
              // ⚠️ Bounded by the REQUEST when the user named a count. Without this the drive works
              // toward the folder — measured 2026-08-20, "the first 100 of 400" drove toward 200
              // names — and a harness that keeps working after the job is done is as wrong as one
              // that stops early. An unnamed count means the whole enumerated set, as before.
              const allNames = (listing?.entries ?? []).filter((entry) => !entry.directory).map((entry) => entry.name)
              // From the same latch, for the same reason — a count read after compaction would
              // silently widen the job to the whole folder, or narrow it to nothing.
              const requested = setRequest?.limit
              const setCoverage = {
                available: requested === undefined ? allNames : allNames.slice(0, requested),
                // ⚠️ The accumulated set, never `openedThisTurn` — that is one window's worth and it
                // shrinks under compaction. See `setOpened`.
                opened: [...opened],
              }
              // ⚠️ Logged at the DECISION, not after it. This check has now failed to fire twice on
              // runs it was built for, and each time the cause was invisible afterwards — the same
              // trap that cost this programme two days on the fan-out. One line names every clause.
              // 🔴 GROUNDING FIRST — before asking for more files, check what was claimed about the
              // ones already "done". Measured 2026-08-20: denied `spawn`, the model globbed the folder
              // and emitted 351 description lines from 20 reads — 331 files it never opened, each
              // rendered as its own filename plus a grid position. Steering that turn toward the
              // REMAINING files would have asked it to fabricate more, faster.
              //
              // ⚠️ Ahead of the coverage check on purpose: a fabricated line makes a file look done,
              // so coverage read after it is measuring the invention.
              const invented = UnfinishedSet.describedWithoutOpening(openedThisTurn, finalText)
              if (invented.length > 0 && !groundingCorrected) {
                groundingCorrected = true
                yield* Log.event("session.finish.set.ungrounded", {
                  "session.id": input.sessionID,
                  "session.set.invented": invented.length,
                  "session.set.opened": openedThisTurn.length,
                })
                yield* SessionInput.steer(db, events, input.sessionID, UnfinishedSet.groundingMessage(invented))
                needsContinuation = true
              }
              yield* Log.event("session.finish.set.considered", {
                "session.id": input.sessionID,
                "session.set.available": setCoverage.available.length,
                "session.set.opened": setCoverage.opened.length,
                "session.set.rounds": setRounds,
              })
              // Counted BEFORE the decision: a round that opened nothing new is barren whether or not
              // the drive goes on to steer again.
              // Session-scoped: a drain-local counter resets on every steer and can never reach the
              // bound. See `setBarrenBySession`.
              const barrenState = setBarrenBySession.get(input.sessionID) ?? { barren: 0, lastOpened: 0 }
              barrenState.barren = setCoverage.opened.length > barrenState.lastOpened ? 0 : barrenState.barren + 1
              barrenState.lastOpened = Math.max(barrenState.lastOpened, setCoverage.opened.length)
              setBarrenBySession.set(input.sessionID, barrenState)
              if (
                UnfinishedSet.shouldContinue({
                  asked: true,
                  coverage: setCoverage,
                  rounds: setRounds,
                  barren: barrenState.barren,
                })
              ) {
                setRounds += 1
                const remaining = UnfinishedSet.untouched(setCoverage)
                yield* Log.event("session.finish.set.continue", {
                  "session.id": input.sessionID,
                  "session.set.remaining": remaining.length,
                })
                yield* SessionInput.steer(
                  db,
                  events,
                  input.sessionID,
                  UnfinishedSet.continueMessage(remaining, setCoverage.opened.length),
                )
              }
            }
            /**
             * 🔴 **THE FAN-OUT SUPERVISOR — a child that was never joined** (`todo/delegation.md`).
             *
             * Measured 2026-08-27 on the delegated 100-file run `4623-S2`: `spawn:10` against
             * `wait:9` and `exit:9`. Ten children started, nine joined, one launched and never
             * accounted for — and the run completed, reported success, and surfaced nothing. ⭐ The
             * nine successes are what hide the tenth: a merge of nine slices of ten has no ragged
             * edge to notice.
             *
             * ⚠️ **Placed BEFORE the reground, deliberately.** Reground asks the model to walk its
             * acceptance criteria; a model missing a whole slice will walk them against the nine it
             * has and conclude it is done — the reground would be answered honestly and wrongly. Close
             * the arithmetic gap first, then let reground check what is left.
             *
             * ⚠️ Runs on EVERY finished turn rather than behind a delegation cue, because the
             * evidence that this session delegated is that it has children — one indexed
             * `WHERE parent_id = ?` — and reading the user's prompt for a cue is the substring hazard
             * `unfinished-set.ts` paid 835,145 tokens to learn. A session with no children costs one
             * empty query and skips everything below.
             */
            // ⚠️ Gated BEFORE the query for the same reason: `off` must not pay for an indexed read
            // it will throw away.
            const kids = harness.drives.children
              ? yield* store.children(input.sessionID).pipe(Effect.orElseSucceed(() => []))
              : []
            if (kids.length > 0) {
              // ⚠️ Accumulated into the SESSION's set, never read fresh from the window — see
              // `childrenJoined`. `wait` carries the child id in its own input, so the parent's joins
              // are readable without a second source of truth.
              const joined = childrenJoined.get(input.sessionID) ?? new Set<string>()
              for (const call of toolCallsSinceLastUser(context)) {
                if (call.name !== WaitTool.name) continue
                try {
                  const parsed: unknown = JSON.parse(call.input)
                  const id =
                    typeof parsed === "object" && parsed !== null && "sessionID" in parsed
                      ? String((parsed as { readonly sessionID?: unknown }).sessionID ?? "")
                      : ""
                  if (id.length > 0) joined.add(id)
                } catch {
                  // A malformed argument is not a join we can attribute to a child.
                }
              }
              childrenJoined.set(input.sessionID, joined)
              const enumerated: UnjoinedChildren.Child[] = []
              for (const kid of kids) {
                const row = yield* store.get(kid).pipe(Effect.orElseSucceed(() => undefined))
                // ⚠️ The child's TITLE, not the `spawn` prompt. The prompt is only reachable from a
                // `spawn` call in the transcript window — which compaction takes back, and which
                // cannot be paired with the child id anyway, since the id arrives in the call's
                // OUTPUT and the trail carries only inputs. The title is on the durable row and is
                // derived from that same opening prompt. Omitted while it is still a creation
                // default, because "New session" names nothing and a slice must never be invented.
                const title = row?.title
                const slice = title !== undefined && title !== "" && !SessionTitle.isDefault(title) ? title : undefined
                enumerated.push({
                  id: kid,
                  exited: row?.result !== undefined,
                  ...(slice === undefined ? {} : { slice }),
                })
              }
              const orphaned = UnjoinedChildren.unaccounted({ children: enumerated, joined })
              const restartRounds = childRestartRounds.get(input.sessionID) ?? 0
              // ⚠️ Logged at the DECISION and BEFORE the gate, so a run that never steers can still
              // tell "the branch never ran" from "it ran and declined" — the trap that cost this
              // programme two days on the fan-out, and the reason `set.branch` exists beside
              // `set.considered`.
              yield* Log.event("session.finish.children.considered", {
                "session.id": input.sessionID,
                "session.children.spawned": kids.length,
                "session.children.joined": joined.size,
                "session.children.unaccounted": orphaned.length,
                "session.children.rounds": restartRounds,
              })
              if (UnjoinedChildren.shouldRestart({ unaccounted: orphaned, rounds: restartRounds })) {
                childRestartRounds.set(input.sessionID, restartRounds + 1)
                yield* Log.event("session.finish.children.restart", {
                  "session.id": input.sessionID,
                  "session.children.unaccounted": orphaned.length,
                })
                yield* SessionInput.steer(
                  db,
                  events,
                  input.sessionID,
                  UnjoinedChildren.restartMessage({
                    spawned: kids.length,
                    joined: joined.size,
                    unaccounted: orphaned,
                  }),
                )
                needsContinuation = true
              }
            }
            // 🔴 THE DRIVE THAT MADE "UNAIDED" UNMEASURABLE. `session.finish.reground` fires in
            // every session in BOTH of the rig's arms — the cue gates the set drive and never this
            // one — so every number `todo/batch-file-planning.md` has produced was taken with at
            // least one mitigation live. This switch is what lets that baseline finally be taken.
            if (harness.drives.reground && !regrounded && shouldReground(finalText, toolCallsSinceLastUser(context).length)) {
              regrounded = true
              yield* Log.event("session.finish.reground", { "session.id": input.sessionID })
              yield* SessionInput.steer(db, events, input.sessionID, REGROUND_NUDGE)
            }
            // QE-B steps 4–5: the turn-end gate — test + structural pass, once per drain,
            // only when the drain actually wrote something. A failure steers; the pending
            // steer below re-arms continuation so the model fixes it before "done".
            if (qualityOn)
              for (const check of Quality.dueTurnEnd(harness.quality, quality))
                yield* runQualityCheck(input.sessionID, harness.shell, check).pipe(
                  Effect.catchCause((cause) =>
                    Log.event("session.quality.check.errored", {
                      "session.id": input.sessionID,
                      "session.cause": Log.fault(cause),
                    }),
                  ),
                )
          }
          if (!needsContinuation) needsContinuation = yield* SessionInput.hasPending(db, input.sessionID, "steer")
        }
        // F2: the truncation halt ends the RUN, not just the inner step loop — otherwise the
        // queue promotion or the self-drive continuation below would immediately steer the same
        // starved model straight back into the same wall, and the two-strike bound would be
        // decorative. Pending input is safe for the same reason it is safe on the exit path.
        if (exitedMidDrain || truncationHalted || policyHalted) break
        shouldRun = yield* SessionInput.hasPending(db, input.sessionID, "queue")
        promotion = shouldRun ? "queue" : undefined
        if (!shouldRun) {
          const driveConfig = yield* effective.resolve(input.sessionID)
          if (ShortChat.enabled(driveConfig.shortChat)) break
          // The auto-prompt SELF-DRIVE (architecture.md "run until exit()"): an auto-prompting /
          // goal-oriented session whose queue ran dry keeps working — the harness injects the next
          // prompt as a provenance-prefixed steer — until `exit(result)` lands on the session row
          // or the round/wall caps trip (todo.md Vision: goal agents carry budget/step caps + a
          // watchdog). Keyed on the session's OWN declared type (never the inherited walk) so
          // spawned children and forks don't silently self-drive; Stop interrupts this very
          // fiber, so it remains the unconditional kill switch. See runner/drive.ts.
          const latest = yield* store.get(input.sessionID).pipe(Effect.orElseSucceed(() => undefined))
          const goalEntry = yield* components.get({ sessionID: input.sessionID, kind: "goal" }).pipe(
            Effect.catch((error: unknown) =>
              Log.event("session.drive.goal.unavailable", {
                "session.id": input.sessionID,
                "session.cause": Log.fault(error),
              }).pipe(Effect.as(undefined)),
            ),
          )
          const planEntries = yield* components.list({ sessionID: input.sessionID, kind: "plan" }).pipe(
            Effect.catch((error: unknown) =>
              Log.event("session.drive.plan.unavailable", {
                "session.id": input.sessionID,
                "session.cause": Log.fault(error),
              }).pipe(Effect.as([])),
            ),
          )
          const decision = SessionDrive.decide(latest, driveState, DateTime.toEpochMillis(yield* DateTime.now), {
            goal:
              typeof goalEntry?.value === "object" && goalEntry.value !== null && "text" in goalEntry.value
                ? String(goalEntry.value.text)
                : undefined,
            steps: planEntries.map((entry) => {
              const value = entry.value as SessionComponentRegistry.PlanStep
              return { text: value.text, status: value.status, verdict: value.verdict }
            }),
          })
          if (decision.kind === "continue") {
            driveState.rounds++
            yield* Log.event("session.drive.continue", {
              "session.id": input.sessionID,
              round: driveState.rounds,
            })
            yield* SessionInput.steer(db, events, input.sessionID, decision.message)
            shouldRun = true
            promotion = "steer"
          } else if (decision.kind === "cap") {
            yield* Log.event("session.drive.cap.reached", {
              "session.id": input.sessionID,
              rounds: driveState.rounds,
            })
            yield* Effect.gen(function* () {
              yield* events.publish(SessionEvent.Synthetic, {
                sessionID: input.sessionID,
                messageID: SessionMessage.ID.create(),
                timestamp: yield* DateTime.now,
                text: decision.notice,
              })
            }).pipe(Effect.ignore)
          } else if (decision.kind === "settle") {
            // 🔴 A spawned child that answered and stopped WITHOUT calling `exit`. Its parent may be
            // blocked on `wait`, and before this it stayed blocked for the whole timeout while the
            // child's answer sat in its transcript (measured 2026-08-20: five children, five hangs,
            // five discarded answers). The join is made TOTAL here — `exit` is a cooperative act by
            // a model, and a primitive that only completes when the model remembers a tool call is
            // not a primitive.
            //
            // The result is the child's OWN last words, which is what a supervisor would have read
            // anyway. An empty transcript still completes: the parent gets an honest "it produced
            // nothing" instead of a two-minute wait for the same answer.
            const timestamp = yield* DateTime.now
            // `lastAssistantText` reads a MESSAGE LIST, not a session id — the child's own transcript
            // is the only place its answer exists, since it never called `exit` to record one.
            const settled = yield* getContext(input.sessionID).pipe(Effect.catch(() => Effect.succeed([])))
            const said = lastAssistantText(settled).trim()
            yield* Log.event("session.drive.settle", {
              "session.id": input.sessionID,
              "session.settled.chars": said.length,
            })
            yield* events.publish(SessionEvent.Completed, {
              sessionID: input.sessionID,
              timestamp,
              result: said.length > 0 ? said : "(the helper session ended without an answer)",
            })
            yield* events.publish(SessionStatusEvent.Status, {
              sessionID: input.sessionID,
              status: { type: "exited" },
            })
          } else if (decision.kind === "complete") {
            const timestamp = yield* DateTime.now
            yield* events.publish(SessionEvent.Completed, {
              sessionID: input.sessionID,
              timestamp,
              result: decision.result,
            })
            yield* events.publish(SessionStatusEvent.Status, {
              sessionID: input.sessionID,
              status: { type: "exited" },
            })
          }
        }
      }
      // 🔴 The turn is OVER at this line, and the status has to say so BEFORE the housekeeping.
      // `postRun` is the changes summary, the auto-title and memory extraction — and two of those
      // three are model calls, so on a local endpoint it routinely runs for tens of seconds. It used
      // to run while the session was still `busy`, which is what made the composer's "Working…" hang
      // around after the answer was complete, pointing at a phase list from a turn that had already
      // ended: nothing the user asked for was still running, and the spinner said otherwise. Its own
      // doc comment says the title is generated "while the user reads the response" — that intent
      // only holds if the user is not being shown a spinner for it.
      //
      // Idle FIRST, then the housekeeping, still inside the drain and under the same lease (so
      // nothing about lifetime, interruption or ordering changes — only what the UI is told).
      // `execution/local.ts` publishes idle again in its `ensuring`; a repeat is a no-op.
      // ⚠️ Guarded on `result` for the same reason that finalizer is: `exit(result)` makes `exited`
      // the terminal status (K1), and a trailing idle would stomp it.
      const settled = yield* store.get(input.sessionID).pipe(Effect.orElseSucceed(() => undefined))
      if (settled?.result === undefined)
        yield* events
          .publish(SessionStatusEvent.Status, { sessionID: input.sessionID, status: { type: "idle" } })
          .pipe(Effect.ignore)
      yield* maintenance.postRun(input.sessionID)
    })

    return Service.of({
      run,
    })
  }),
)

export const defaultLayer = layer

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    EventV2.node,
    llmClient,
    AgentV2.node,
    ToolRegistry.node,
    ToolCatalogueGuidance.node,
    SessionRunnerModel.node,
    SessionMaintenance.node,
    SessionStore.node,
    SessionEffectiveConfig.node,
    Location.node,
    SystemContextRegistry.node,
    SkillGuidance.node,
    ReferenceGuidance.node,
    AdhocGuidance.node,
    Config.node,
    Snapshot.node,
    SessionScheduler.node,
    SessionCompactionRequest.node,
    Database.node,
    AppProcess.node,
    Memory.node,
    // Strict's host-execution context (ruling 6): the messenger trust of the chain + the shared
    // OFF-C policy. Both are global nodes, so this adds no per-location state.
    MessengerStore.node,
    Offline.node,
    // The quality gate executes persisted (possibly model-supplied) commands through the agent
    // shell, so it asserts `bash` like every other execution surface — see `runQualityCheck`.
    PermissionV2.node,
    PluginV2.node,
    SessionComponentRegistry.node,
  ],
})
