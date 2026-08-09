export * as SessionRunnerLLM from "./llm"

import {
  LLM,
  LLMClient,
  LLMError,
  LLMEvent,
  Message,
  SystemPart,
  isContextOverflowFailure,
  type FinishReason,
  type ProviderErrorEvent,
} from "@novaclaw/llm"
import { Cause, DateTime, Duration, Effect, Exit, FiberSet, Layer, Option, Semaphore, Stream } from "effect"
import path from "path"
import { AgentV2 } from "../../agent"
import { Config } from "../../config"
import { ConfigToolRouting } from "../../config/tool-routing"
import { Global } from "../../global"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { Location } from "../../location"
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

import { resolveSessionConfig, rootSessionType, EFFECTIVE_CONFIG_DEFAULTS } from "../config-resolve"
import { AgentJail } from "../../agent-jail"
import { MessengerStore } from "../../messenger/store"
import { Offline } from "../../offline"
import { PermissionV2 } from "../../permission"
import { PluginV2 } from "../../plugin"
import { SessionScheduler } from "../scheduler"
import { type RunError, Service } from "./index"
import { SessionRunnerModel } from "./model"
import { SessionMaintenance } from "./maintenance"
import { SystemCompose } from "./system-compose"
import { TierScaffold } from "./tier-scaffold"
import { SessionRecall } from "./recall"
import { MemoryCorrection } from "./memory-correction"
import { Memory } from "../../kb-graph/memory"
import { KbEmbedder } from "../../kb-graph/embedder"
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
import { ContextPack } from "./context-pack"
import { RequestFootprint } from "./footprint"
import { ContextBudget } from "./context-budget"
import {
  detectDoomLoop,
  redirectMessage,
  detectFailureStreak,
  failureStreakMessage,
  detectRunaway,
  runawayMessage,
  toolCallsSinceLastUser,
  isEmptyAssistantTurn,
  lastAssistantText,
  shouldReground,
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
import { QualityProvision } from "./quality-provision"
import { Snapshot } from "../../snapshot"
import { AppProcess } from "../../process"
import { ChildProcess } from "effect/unstable/process"
import { makeLocationNode } from "../../effect/app-node"
import { llmClient } from "../../effect/app-node-platform"
import { AttachmentPaths } from "./attachment-paths"
import { TodoReminder } from "./todo-reminder"
import { CalloutPolicy } from "../../callout-policy"

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
      if (!failed) {
        yield* Log.event("session.quality.check.passed", {
          "session.id": sessionID,
          "session.quality.label": check.label,
        })
        return false
      }
      yield* Log.event("session.quality.check.failed", {
        "session.id": sessionID,
        "session.quality.label": check.label,
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
      // ⚠️ This pass is the MOST exposed of the three, and for a reason worth stating: unlike the
      // two extraction passes it carries no `NO_THINKING` overlay, so it runs thinking-ENABLED. The
      // 2026-08-06 table puts the empty-completion cliff at ~450 tokens in that mode against a 512
      // cap — about 1.65× margin — where the `NO_THINKING` passes sit near 100 and have roughly 4×.
      // So it is the one most likely to spend its budget on reasoning and return nothing at all.
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

    type TurnTransition =
      // Automatic compaction completed; rebuild the request from compacted history.
      | { readonly _tag: "ContinueAfterCompaction"; readonly step: number }
      // Overflow compaction completed; rebuild once through the path without overflow recovery.
      | { readonly _tag: "ContinueAfterOverflowCompaction"; readonly step: number }

    class TurnTransitionError extends Error {
      constructor(readonly transition: TurnTransition) {
        super()
      }
    }

    const continueAfterCompaction = (step: number) => new TurnTransitionError({ _tag: "ContinueAfterCompaction", step })
    const continueAfterOverflowCompaction = (step: number) =>
      new TurnTransitionError({ _tag: "ContinueAfterOverflowCompaction", step })

    const loadSystemContext = (agent: AgentV2.Selection, sessionID: SessionSchema.ID) =>
      Effect.all(
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
      const config = yield* tap(
        resolveSessionConfig(EFFECTIVE_CONFIG_DEFAULTS, session.id, (id) => store.get(id as SessionSchema.ID)),
      )
      const agent = yield* tap(agents.select(config.agent as typeof session.agent))
      const initialized = yield* SessionContextEpoch.initialize(db, loadSystemContext(agent, session.id), session.id)
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
          SessionContextEpoch.prepare(db, events, loadSystemContext(agent, session.id), session.id, (update) =>
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
      const model = yield* tap(models.resolve(modelSession))
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
      timing.start("prepare")
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
      const modelCapabilities = needsCapabilityEvidence(context) ? yield* models.capabilities(modelSession) : undefined
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
      timing.end("prepare")
      let memoryRecall: string | undefined
      // Kept for the duration of this provider step so a failed `read` can correct the exact
      // remembered file claim that was actually put on the model's horizon.
      let recalledMemories: ReadonlyArray<MemoryClient.SearchHit> = []
      if (recallQuery !== undefined && MemorySetting.memoryEnabled()) {
        // The VECTOR leg: one short embedding of the recall query lets the engine fuse vector KNN with
        // FTS (measured 85% vs 77% keyword-only). Bounded + degrading — no device, unreachable, or slow
        // ⇒ undefined ⇒ keyword-only recall. Never blocks the turn on a failure.
        timing.start("memory-embed")
        const recallVector = yield* Effect.promise(() => KbEmbedder.embedOne(recallQuery))
        timing.end("memory-embed")
        const budget = SessionRecall.recallBudget(tier)
        // P8 ordering: over-fetch candidates, then re-rank by recency × authority and keep `budget` of
        // them. What the model sees each turn is the SHORT list, so ordering matters most here — a
        // recent authoritative fact must beat an old passive musing that merely echoes the wording.
        // Bounded (ranking.ts) and a no-op when hits share provenance and age.
        timing.start("memory-search")
        const recallCandidates = yield* memory
          .search({
            query: recallQuery,
            k: SessionRecall.recallPoolSize(budget),
            scopes: [`session:${session.id}`, "global"],
            ...(recallVector === undefined ? {} : { embedding: recallVector }),
          })
          .pipe(Effect.orElseSucceed(() => []))
        timing.end("memory-search")
        // P8d: let the MODEL order what it will actually see. Metadata ordering can't read
        // authoritativeness out of the TEXT — a definitive older statement should outrank a newer
        // offhand musing (measured 4/4 vs 1/4 for metadata alone). One short call (~0.4s at 5
        // candidates). ANY failure — gate off, model down, unparseable reply — falls back to the
        // deterministic ranker, so ordering degrades but the turn never breaks.
        let ordered: ReadonlyArray<MemoryClient.SearchHit> = MemoryRanking.rankHits(recallCandidates, Date.now())
        if (MemorySetting.rerankEnabled() && recallCandidates.length > 1) {
          timing.start("memory-rerank")
          const prompt = MemoryRerank.buildRerankPrompt(recallQuery, recallCandidates, Date.now())
          const reply = yield* judgeCompletion(
            session.id,
            harness.introspection,
            `${prompt.system}\n\n${prompt.user}`,
          ).pipe(Effect.orElseSucceed(() => ""))
          const order = MemoryRerank.parseRerankOrder(reply, recallCandidates.length)
          if (order) ordered = order.map((index) => recallCandidates[index]!)
          timing.end("memory-rerank")
        }
        recalledMemories = ordered.slice(0, budget)
        memoryRecall = SessionRecall.formatRecall(recalledMemories)
      }
      // The exact wire text of the tail-injected recall block. Carries the 1N provenance prefix for
      // the same reason the todo reminder does: it rides the `user` role, and every real-user walk
      // (context-pack's anchor, compaction, title generation) must not mistake it for speech. The
      // packer matches on this exact string to apply the `memory` category budget, so it — not the
      // bare `memoryRecall` — is what goes to `packRequest`.
      const recallMessage = memoryRecall === undefined ? undefined : SessionInput.applySteerProvenance(memoryRecall)
      timing.start("prepare")
      const isLastStep = agent.info?.steps !== undefined && currentStep >= agent.info.steps
      const toolMaterialization = isLastStep
        ? undefined
        : yield* tools.materialize(
            agent.info?.permissions,
            ConfigToolRouting.offered(harness.toolRouting, {
              mode: config.permissionMode,
              providerID: modelRef?.providerID ?? model.provider,
              modelID: modelRef?.id ?? model.id,
            }),
            discoveredTools,
          )
      const promptCacheKey = /^ses_[0-9a-f]{64}$/.test(session.id) ? session.id.slice(4) : session.id
      // P3 (3A/3B): appraise the per-session mood from what has happened so far (runs BEFORE
      // this turn's request, afpro-style), modulate sampling AROUND the model's configured
      // baseline, and at high frustration/urgency steer a one-shot redirect (rising-edge only —
      // decay naturally re-arms it). The per-session stance (the composer's Tuning toggle,
      // resolved through the config walk) wins; no stance = the global config decides.
      let affectiveGeneration: ReturnType<typeof Affective.toSampling> | undefined
      if (config.affective ?? harness.affective?.enabled === true) {
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
      const fullRequest = LLM.request({
        model,
        // Order + placement of the per-model pre-prompt live in system-compose.ts (a pure, tested
        // unit): the pre-prompt sits directly after the persona baseline; every other part keeps its
        // position, so an absent pre-prompt yields a byte-identical prompt to before the feature.
        // `projectScope` is the guidance half of the owner's 2026-07-30 directive — present in every
        // mode but `yolo`, from the RESOLVED (already-narrowed) mode. See system-compose.ts.
        system: SystemCompose.composeSystemParts({
          persona: harness.persona,
          modelPrePrompt,
          expertiseHint: harness.expertiseHint,
          tierHint,
          systemPromptOverride: config.systemPromptOverride,
          agentSystem: agent.info?.system,
          projectScope: SystemCompose.projectScopeSection(config.permissionMode),
          base: system.baseline,
        }).map(SystemPart.make),
        messages: [
          ...toLLMMessages(context, model, modelCapabilities),
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
        tools: toolMaterialization?.definitions ?? [],
        callableTools: isLastStep ? [] : [...discoveredTools],
        toolChoice: isLastStep ? "none" : undefined,
        ...(affectiveGeneration === undefined ? {} : { generation: affectiveGeneration }),
      })
      timing.end("prepare")
      timing.start("compaction")
      const compacted = yield* harness.compaction.compactIfNeeded({
        sessionID: session.id,
        entries,
        model,
        request: fullRequest,
      })
      timing.end("compaction")
      if (compacted) return yield* Effect.die(continueAfterCompaction(currentStep))
      // 1M — the deterministic fail-safe under compaction: pack the outgoing request to the
      // server's HONORED window so an Ollama-class server never silently front-truncates the
      // system prompt away. Reached when compaction declined (window unknown, summary model
      // unavailable, or simply under ITS threshold) — history in the DB stays intact.
      timing.start("prepare")
      const preparedDispatch = ProviderDispatch.prepare({
        request: fullRequest,
        promptCacheKey,
        contextSize: model.route.defaults.limits?.context,
        profile: ContextBudget.enabled(harness.context, config.contextBudget)
          ? ContextBudget.resolve(harness.context, config.type)
          : undefined,
        memoryRecall: recallMessage,
      })
      timing.end("prepare")
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
      timing.start("snapshot")
      const startSnapshot = yield* snapshots.capture()
      timing.end("snapshot")
      timing.start("provider-setup")
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
        onFirstOutput: timing.firstToken,
      })
      const withPublication = Semaphore.makeUnsafe(1).withPermit
      const publish = (event: LLMEvent, outputPaths: ReadonlyArray<string> = []) =>
        withPublication(publisher.publish(event, outputPaths))
      let overflowFailure: ProviderErrorEvent | undefined
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
      const budgetEnforced = config.thinkingBudget ?? true
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
            yield* Effect.uninterruptibleMask((restore) =>
              restore(
                toolMaterialization.settle({
                  sessionID: session.id,
                  agent: agent.id,
                  assistantMessageID,
                  attachmentPaths,
                  call: event,
                }),
              ).pipe(
                Effect.flatMap((settlement) =>
                  Effect.gen(function* () {
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
                        const count = yield* MemoryCorrection.correctMissingRead({
                          memory,
                          recalled: recalledMemories,
                          requested,
                          resolved: path.resolve(location.directory, requested),
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
            timing.start("snapshot")
            const endSnapshot = yield* snapshots.capture()
            const files =
              startSnapshot && endSnapshot
                ? yield* snapshots
                    .files({ from: startSnapshot, to: endSnapshot })
                    .pipe(Effect.catch(() => Effect.succeed(undefined)))
                : undefined
            timing.end("snapshot")
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
      timing.end("provider-setup")
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
      if (prepared === undefined) return
      const { session, model, entries } = prepared
      // The compactor reads only `generation?.maxTokens` (else the model's own output limit)
      // from the request — a minimal envelope is enough.
      const request = LLM.request({ model, messages: [], tools: [] })
      const compacted = yield* compaction.compactAfterOverflow(
        { sessionID: session.id, entries, model, request },
        "manual",
      )
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
      const handoff = yield* resolveSessionConfig(EFFECTIVE_CONFIG_DEFAULTS, input.sessionID, (id) =>
        store.get(id as SessionSchema.ID),
      )
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
      // Silent-no-op guard: one steer per drain when a no-tool-call turn looks like an attempted call.
      let textualNudged = false
      // F2 output-token truncation ledger — PER-DRAIN, like every latch above it (see
      // `finish-recovery.ts` `initialState` for why per-turn never trips and per-session never
      // clears). One steer back to the cutoff, then the drain stops honestly.
      const finishRecovery = FinishRecovery.initialState()
      let truncationHalted = false
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
          const qualityOn = handoff.quality ?? harness.quality.enabled
          const introspectionOn = handoff.introspection ?? harness.introspection.enabled
          const result = yield* runTurn(input.sessionID, harness, promotion, step)
          needsContinuation = result.needsContinuation
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
            if (!runawayNudged && detectRunaway(sinceUser.length)) {
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
            if (!regrounded && shouldReground(finalText, toolCallsSinceLastUser(context).length)) {
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
        if (exitedMidDrain || truncationHalted) break
        shouldRun = yield* SessionInput.hasPending(db, input.sessionID, "queue")
        promotion = shouldRun ? "queue" : undefined
        if (!shouldRun) {
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
