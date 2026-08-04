export * as SessionRunnerLLM from "./llm"

import {
  LLM,
  LLMClient,
  LLMError,
  LLMEvent,
  Message,
  SystemPart,
  isContextOverflowFailure,
  type LLMRequest,
  type ProviderErrorEvent,
} from "@novaclaw/llm"
import { Cause, DateTime, Duration, Effect, Fiber, FiberSet, Layer, Option, Semaphore, Stream } from "effect"
import fs from "node:fs"
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
import { SessionChanges } from "../changes"
import { SessionEvent } from "../event"
import { SessionHistory } from "../history"
import { SessionInput } from "../input"
import { SessionMessage } from "../message"
import { SessionMessageRead } from "../message-read"
import { Prompt } from "../prompt"
import { SessionPatch } from "../patch"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionTitle } from "../title"
import { SessionTodo } from "../todo"
import { Log } from "@novaclaw/schema/log"
import { SessionStatusEvent } from "@novaclaw/schema/session-status-event"

import {
  resolveSessionConfig,
  rootSessionType,
  EFFECTIVE_CONFIG_DEFAULTS,
  type EffectiveConfig,
} from "../config-resolve"
import { AgentJail } from "../../agent-jail"
import { HostExec } from "../../host-exec"
import { MessengerStore } from "../../messenger/store"
import { Offline } from "../../offline"
import { SessionScheduler } from "../scheduler"
import { type RunError, Service } from "./index"
import { SessionRunnerModel } from "./model"
import { SystemCompose } from "./system-compose"
import { TierScaffold } from "./tier-scaffold"
import { SessionRecall } from "./recall"
import { MemoryCorrection } from "./memory-correction"
import { SessionExtract } from "./extract"
import { Memory } from "../../kb-graph/memory"
import { KbEmbedder } from "../../kb-graph/embedder"
import { MemoryClient } from "../../kb-graph/memory-client"
import { MemoryRanking } from "../../kb-graph/ranking"
import { MemoryRerank } from "../../kb-graph/rerank"
import { MemorySetting } from "../../kb-graph/memory-setting"
import { HarnessConfig } from "./harness-config"
import { SessionStrict } from "./strict"
import { JhStore } from "../../jh/store"
import type { JhEngine } from "../../jh/engine"
import { createLLMEventPublisher } from "./publish-llm-event"
import { SessionExecutionAttempt } from "../execution-attempt"
import { attachmentModality, needsCapabilityEvidence, toLLMMessages, unreadableTurnAttachments } from "./to-llm-message"
import { AdhocGuidance } from "../../adhoc-tools/guidance"
import { Affective } from "./affective"
import { SessionDrive } from "./drive"
import { FinishRecovery } from "./finish-recovery"
import { ContextPack } from "./context-pack"
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
import { ReasoningBudget } from "./reasoning-budget"
import { ProviderRetry } from "./provider-retry"
import { ProviderStreamLiveness } from "./provider-stream-liveness"
import { Quality } from "./quality"
import { QualityProvision } from "./quality-provision"
import { Snapshot } from "../../snapshot"
import type { RelativePath } from "../../schema"
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
 *   - [x] Stream exactly one `llm.stream(request)` provider turn.
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
 * Use `llm.stream(request)` for each provider turn. Keep tool execution and continuation here.
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
    const memory = yield* MemoryClient.Service
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
    const runQualityCheck = Effect.fn("SessionRunner.qualityCheck")(function* (
      sessionID: SessionSchema.ID,
      shell: string,
      check: { readonly label: string; readonly command: string; readonly timeoutMs?: number },
    ) {
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
    // A9.5: delivery state for provider-only checklist reminders. The checklist itself is durable
    // in TodoTable; this bounded map only prevents repeated projection within one message bucket.
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
      const chunks: string[] = []
      yield* llm
        .stream(
          LLM.request({
            model,
            messages: [Message.user(prompt)],
            tools: [],
            generation: { maxTokens: 512 },
          }),
        )
        .pipe(
          Stream.runForEach((event) => {
            if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
            return Effect.void
          }),
        )
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
    // no-ops the whole pass. MEASURED 2026-07-20 against the Spark with the shipped extraction prompt:
    //   max_tokens= 512 -> finish=stop,   completion= 348, content 132 chars (valid JSON)
    //   max_tokens=2048 -> finish=length, completion=2048, content 0 chars
    //   max_tokens=4096 -> finish=length, completion=4096, content 0 chars
    // Note the INVERSION: a bigger output limit is WORSE (a runaway thinking loop), so raising
    // maxTokens is not the fix. Auto-title therefore uses the provider-neutral stages of the shared
    // ReasoningBudget controller first: observe reasoning tokens, stop at checkpoints, and nudge the
    // model toward its tiny answer. Its final mechanical backstop remains the best-effort
    // `chat_template_kwargs` switch for providers that support it. The other utility passes still use
    // that direct switch and should migrate through the same controller independently.
    const NO_THINKING = { chat_template_kwargs: { enable_thinking: false } } as const

    // A title needs essentially no reasoning. Keep this deliberately far below an interactive turn's
    // model-level budget; ReasoningBudget owns the bounded multi-request recovery when a reasoning
    // model nevertheless opens a think stream. This is provider-neutral until the controller's final
    // best-effort hard stop, unlike putting a Qwen-specific flag on the first request.
    const TITLE_REASONING_BUDGET = 128

    // True unless the turn explicitly disabled reasoning via the `NO_THINKING` overlay above — the
    // thinking-budget controller only engages when the model is actually allowed to reason.
    const thinkingEnabled = (req: LLMRequest): boolean => {
      const body = req.http?.body as { chat_template_kwargs?: { enable_thinking?: boolean } } | undefined
      return body?.chat_template_kwargs?.enable_thinking !== false
    }

    // Sessions with an auto-title pass in flight. Two callers race for it — the 30s timer below and the
    // drain end — and both would otherwise see `isDefault` still true and each spend a model call.
    const titling = new Set<string>()

    const generateTitle = Effect.fn("SessionRunner.generateTitle")(function* (sessionID: SessionSchema.ID) {
      const session = yield* getSession(sessionID)
      // A title the USER set is never overwritten — `isDefault` is the whole consent check here.
      if (!SessionTitle.isDefault(session.title)) return
      const text = SessionTitle.firstRealUserText(yield* getContext(sessionID))
      if (!text) return
      const model = yield* models.resolve(session)
      const chunks: string[] = []
      const request = LLM.request({
        model,
        system: [SystemPart.make(SessionTitle.SYSTEM)],
        messages: [Message.user(text)],
        tools: [],
        generation: { maxTokens: 512 },
      })
      yield* ReasoningBudget.stream({
        request,
        stream: (next) => llm.stream(next),
        budget: TITLE_REASONING_BUDGET,
      }).pipe(
        Stream.runForEach((event) => {
          if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
          return Effect.void
        }),
      )
      const raw = chunks.join("")
      // An EMPTY completion is a broken call, not "no title worth writing" — say so. Silence here is
      // exactly how this stayed dead across three shipped phases.
      if (raw.trim() === "") yield* Log.event("session.title.generate.empty", { "session.id": sessionID })
      const title = SessionTitle.clean(raw)
      if (!title) return
      yield* SessionPatch.patchSessionRecord({ db, events }, sessionID, (info) =>
        SessionSchema.Info.make({ ...info, title, time: { ...info.time, updated: DateTime.makeUnsafe(Date.now()) } }),
      )
    })

    /** `generateTitle`, but at most one pass per session at a time — the guard always clears. */
    const generateTitleOnce = (sessionID: SessionSchema.ID) =>
      Effect.suspend(() => {
        if (titling.has(sessionID)) return Effect.void
        titling.add(sessionID)
        return generateTitle(sessionID).pipe(Effect.ensuring(Effect.sync(() => titling.delete(sessionID))))
      })

    /**
     * Title the session after 30s if the turn is still going (owner 2026-07-25). The drain-end pass is the
     * right moment for a SHORT turn — the user is reading the answer while the model is idle — but a long
     * one (compile, test, retry) leaves the chat list showing a placeholder for minutes, which is exactly
     * when a name is most useful for finding it again. Whichever fires first wins; the loser no-ops on
     * `isDefault` (or the in-flight guard), and a user-set title stops both.
     *
     * Detached, because it must outlive neither the turn's failure nor its interruption: forked into the
     * service scope so an interrupted drain cannot swallow it (the dying-fiber trap).
     */
    const scheduleEarlyTitle = (sessionID: SessionSchema.ID) =>
      Effect.forkDetach(
        Effect.sleep(Duration.seconds(30)).pipe(
          Effect.andThen(generateTitleOnce(sessionID)),
          Effect.catchCause((cause) =>
            Log.event("session.title.early.failed", {
              "session.id": sessionID,
              "session.cause": Cause.pretty(cause),
            }),
          ),
        ),
      )

    // Auto-extraction (kb-graph §1.3.3): after the drain settles, a model pass reads the latest
    // REAL user turn and records durable facts into SESSION-scope memory (staged) — so memory fills
    // WITHOUT the agent calling `remember`, and auto-recall surfaces them in future turns. Only an
    // interactive session may enter: sub-agents and scheduled/heartbeat work are proposers, not
    // durable-memory authorities. Idempotent by content hash (re-extraction dedups). Best-effort +
    // gated on the engine being live so a disabled/still-opening memory costs no model call.
    const extractMemory = Effect.fn("SessionRunner.extractMemory")(function* (sessionID: SessionSchema.ID) {
      const session = yield* getSession(sessionID)
      const config = yield* resolveSessionConfig(EFFECTIVE_CONFIG_DEFAULTS, session.id, (id) =>
        store.get(id as SessionSchema.ID),
      )
      if (!SessionExtract.allowsDurableMemory(config.type)) return
      if (!MemorySetting.memoryEnabled()) return // the user turned memory off — record nothing
      if (!(yield* memory.health())) return
      const exchange = SessionExtract.buildExchange(yield* getContext(sessionID))
      if (!exchange) return
      const model = yield* models.resolve({ ...session, model: config.model as typeof session.model })
      const chunks: string[] = []
      yield* llm
        .stream(
          LLM.request({
            model,
            system: [SystemPart.make(SessionExtract.SYSTEM)],
            messages: [Message.user(exchange)],
            tools: [],
            generation: { maxTokens: 512 },
            http: { body: NO_THINKING }, // else the budget goes to reasoning and the reply is EMPTY
          }),
        )
        .pipe(
          Stream.runForEach((event) => {
            if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
            return Effect.void
          }),
        )
      const scope = `session:${sessionID}`
      const rawExtraction = chunks.join("")
      // Distinguish "the model said there is nothing to remember" (a legitimate `[]`) from "the model
      // returned NOTHING" (a broken call). Conflating them is what hid this failure for three phases.
      if (rawExtraction.trim() === "") yield* Log.event("session.memory.extract.empty", { "session.id": sessionID })
      const facts = SessionExtract.parseExtraction(rawExtraction)
      const namedFacts = facts.filter((f): f is SessionExtract.Extracted & { name: string } => !!f.name)
      const names = [...new Set(namedFacts.map((f) => f.name))]
      // Embed the extracted facts so they're reachable by the VECTOR leg later (measured: hybrid
      // retrieval 85% vs 77% keyword-only). ONE batched call for the whole extraction, and this runs
      // in postRunMaintenance — off the turn hot-path. No device ⇒ undefined ⇒ FTS-only memories.
      const vectors =
        facts.length === 0 ? undefined : yield* Effect.promise(() => KbEmbedder.embed(facts.map((f) => f.text)))
      for (const [index, fact] of facts.entries()) {
        const vector = vectors?.[index]
        yield* memory
          .addMemory({
            id: SessionExtract.memoryID(scope, fact.text),
            kind: "episode",
            text: fact.text,
            ...(fact.name === undefined ? {} : { name: fact.name }),
            scope,
            source: "auto-extract",
            relation: "staged",
            ...(vector === undefined ? {} : { embedding: vector }),
          })
          .pipe(Effect.ignore) // duplicate id = already remembered (dedup); never fail the drain
      }
      // Stage 2 (KB-D (a)): link the facts we just wrote. Deliberately AFTER the node writes — an edge
      // needs its endpoints to exist, and more importantly a failing/slow link call must never cost us
      // the memories themselves (computing links first would abort the whole extraction on any link
      // error). Skipped entirely below 2 named facts: nothing to connect, so no model call.
      const links =
        names.length < 2
          ? []
          : yield* Effect.gen(function* () {
              const linkChunks: string[] = []
              yield* llm
                .stream(
                  LLM.request({
                    model,
                    system: [SystemPart.make(SessionExtract.LINK_SYSTEM)],
                    messages: [Message.user(SessionExtract.buildLinkPrompt(exchange, names))],
                    tools: [],
                    generation: { maxTokens: 512 },
                    http: { body: NO_THINKING }, // else the budget goes to reasoning and the reply is EMPTY
                  }),
                )
                .pipe(
                  Stream.runForEach((event) => {
                    if (LLMEvent.is.textDelta(event)) linkChunks.push(event.text)
                    return Effect.void
                  }),
                )
              return SessionExtract.parseLinks(linkChunks.join(""), names)
            }).pipe(Effect.catchCause(() => Effect.succeed([] as SessionExtract.ExtractedLink[])))
      // `parseLinks` already guaranteed both endpoints are names from `names`, so every lookup here
      // resolves; a name shared by several facts binds to the first (the node is the thing, not the
      // sentence).
      if (links.length > 0) {
        const idByName = new Map<string, string>()
        for (const fact of namedFacts)
          if (!idByName.has(fact.name)) idByName.set(fact.name, SessionExtract.memoryID(scope, fact.text))
        for (const link of links) {
          const from = idByName.get(link.from)
          const to = idByName.get(link.to)
          if (from === undefined || to === undefined) continue
          yield* memory.addEdge({ from, to, type: link.type, scope, source: "auto-extract" }).pipe(Effect.ignore) // duplicate edge = already linked; never fail the drain
        }
      }
    })

    // The session-changes summary (the app's "Changes" review + the chats badge reads
    // `SessionInfo.summary` — F1e re-pointed it to the record; V1 wrote per-user-message
    // diffs the native transcript doesn't carry, and NOTHING wrote the record field until
    // this landed). Recomputed after each drain from the FULL transcript's cumulative
    // snapshot boundaries (the packed runner context may have compacted the first
    // `snapshot.start` away, so read the store, not the context) and patched onto the
    // record only when it actually changed — the app updates live off `session.updated`.
    const refreshChangesSummary = Effect.fn("SessionRunner.refreshChangesSummary")(function* (
      sessionID: SessionSchema.ID,
    ) {
      const messages = yield* SessionMessageRead.list(db, { sessionID, order: "asc" })
      const { from, to } = SessionChanges.boundaries(messages)
      if (!from || !to) return
      const diff = from === to ? [] : yield* snapshots.diff({ from: Snapshot.ID.make(from), to: Snapshot.ID.make(to) })
      const summary = SessionChanges.summary(diff, { from, to, complete: true })
      yield* SessionPatch.patchSessionRecord({ db, events }, sessionID, (info) =>
        SessionChanges.equal(info.summary, summary)
          ? undefined
          : SessionSchema.Info.make({
              ...info,
              summary,
              time: { ...info.time, updated: DateTime.makeUnsafe(Date.now()) },
            }),
      )
    })

    const markChangesIncomplete = Effect.fn("SessionRunner.markChangesIncomplete")(function* (
      sessionID: SessionSchema.ID,
    ) {
      yield* SessionPatch.patchSessionRecord({ db, events }, sessionID, (info) =>
        info.summary?.complete === false
          ? undefined
          : SessionSchema.Info.make({
              ...info,
              summary: SessionChanges.incomplete(info.summary),
            }),
      )
    })

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
    ) {
      const session = yield* getSession(sessionID)
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return yield* Effect.interrupt
      // Agent-OS Phase 1 (architecture.md): resolve model + agent through the config-inheritance
      // walk, so a child session inherits its parent's unless overridden. Behavior-preserving at the
      // root (the chain is just [session] -> config.* === session.*). config.* carry the real branded
      // values (they flow from session.* through the walk; only the static type is widened -> cast).
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
            sessionID: session.id,
            messageID: SessionMessage.ID.create(),
            timestamp: yield* DateTime.now,
            text,
          })
        }).pipe(Effect.ignore)
      const config = yield* resolveSessionConfig(EFFECTIVE_CONFIG_DEFAULTS, session.id, (id) =>
        store.get(id as SessionSchema.ID),
      ).pipe(Effect.tapError(surfacePreTurnFailure))
      const agent = yield* agents
        .select(config.agent as typeof session.agent)
        .pipe(Effect.tapError(surfacePreTurnFailure))
      const initialized = yield* SessionContextEpoch.initialize(db, loadSystemContext(agent, session.id), session.id)
      const toolFibers = yield* FiberSet.make<void, ToolOutputStore.Error>()
      let needsContinuation = false
      let currentStep = step
      if (promotion) {
        const cutoff = yield* EventV2.latestSequence(db, session.id)
        let promoted = 0
        if (promotion === "steer") promoted = yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
        if (promotion === "queue") {
          promoted += Number(yield* SessionInput.promoteNextQueued(db, events, session.id))
          promoted += yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
        }
        if (promoted > 0) currentStep = 1
      }
      const system =
        initialized ??
        (yield* SessionContextEpoch.prepare(db, events, loadSystemContext(agent, session.id), session.id, (update) =>
          SessionExecutionAttempt.contextUpdatedCurrent({ ...update.data, snapshot: update.snapshot }, () =>
            SessionContextEpoch.publishUpdate(db, events, update.data, update.snapshot),
          ),
        ).pipe(Effect.tapError(surfacePreTurnFailure)))
      const modelSession = { ...session, model: config.model as typeof session.model }
      const model = yield* models.resolve(modelSession).pipe(Effect.tapError(surfacePreTurnFailure))
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
      const entries = yield* SessionHistory.entriesForRunner(db, session.id, system.baselineSeq)
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
      let memoryRecall: string | undefined
      // Kept for the duration of this provider step so a failed `read` can correct the exact
      // remembered file claim that was actually put on the model's horizon.
      let recalledMemories: ReadonlyArray<MemoryClient.SearchHit> = []
      if (recallQuery !== undefined && MemorySetting.memoryEnabled()) {
        // The VECTOR leg: one short embedding of the recall query lets the engine fuse vector KNN with
        // FTS (measured 85% vs 77% keyword-only). Bounded + degrading — no device, unreachable, or slow
        // ⇒ undefined ⇒ keyword-only recall. Never blocks the turn on a failure.
        const recallVector = yield* Effect.promise(() => KbEmbedder.embedOne(recallQuery))
        const budget = SessionRecall.recallBudget(tier)
        // P8 ordering: over-fetch candidates, then re-rank by recency × authority and keep `budget` of
        // them. What the model sees each turn is the SHORT list, so ordering matters most here — a
        // recent authoritative fact must beat an old passive musing that merely echoes the wording.
        // Bounded (ranking.ts) and a no-op when hits share provenance and age.
        const recallCandidates = yield* memory
          .search({
            query: recallQuery,
            k: SessionRecall.recallPoolSize(budget),
            scopes: [`session:${session.id}`, "global"],
            ...(recallVector === undefined ? {} : { embedding: recallVector }),
          })
          .pipe(Effect.orElseSucceed(() => []))
        // P8d: let the MODEL order what it will actually see. Metadata ordering can't read
        // authoritativeness out of the TEXT — a definitive older statement should outrank a newer
        // offhand musing (measured 4/4 vs 1/4 for metadata alone). One short call (~0.4s at 5
        // candidates). ANY failure — gate off, model down, unparseable reply — falls back to the
        // deterministic ranker, so ordering degrades but the turn never breaks.
        let ordered: ReadonlyArray<MemoryClient.SearchHit> = MemoryRanking.rankHits(recallCandidates, Date.now())
        if (MemorySetting.rerankEnabled() && recallCandidates.length > 1) {
          const prompt = MemoryRerank.buildRerankPrompt(recallQuery, recallCandidates, Date.now())
          const reply = yield* judgeCompletion(
            session.id,
            harness.introspection,
            `${prompt.system}\n\n${prompt.user}`,
          ).pipe(Effect.orElseSucceed(() => ""))
          const order = MemoryRerank.parseRerankOrder(reply, recallCandidates.length)
          if (order) ordered = order.map((index) => recallCandidates[index]!)
        }
        recalledMemories = ordered.slice(0, budget)
        memoryRecall = SessionRecall.formatRecall(recalledMemories)
      }
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
        providerOptions: { openai: { promptCacheKey } },
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
          memoryRecall,
          systemPromptOverride: config.systemPromptOverride,
          agentSystem: agent.info?.system,
          projectScope: SystemCompose.projectScopeSection(config.permissionMode),
          base: system.baseline,
        }).map(SystemPart.make),
        messages: [
          ...toLLMMessages(context, model, modelCapabilities),
          // Derived provider context only — never a transcript row. The provenance prefix makes
          // every downstream real-user detector treat it as harness guidance rather than speech.
          ...(todoReminder === undefined ? [] : [Message.user(todoReminder)]),
          ...(isLastStep ? [Message.assistant(MAX_STEPS_PROMPT)] : []),
        ],
        tools: toolMaterialization?.definitions ?? [],
        callableTools: isLastStep ? [] : [...discoveredTools],
        toolChoice: isLastStep ? "none" : undefined,
        ...(affectiveGeneration === undefined ? {} : { generation: affectiveGeneration }),
      })
      if (yield* harness.compaction.compactIfNeeded({ sessionID: session.id, entries, model, request: fullRequest }))
        return yield* Effect.die(continueAfterCompaction(currentStep))
      // 1M — the deterministic fail-safe under compaction: pack the outgoing request to the
      // server's HONORED window so an Ollama-class server never silently front-truncates the
      // system prompt away. Reached when compaction declined (window unknown, summary model
      // unavailable, or simply under ITS threshold) — history in the DB stays intact.
      const packed = ContextPack.packRequest({
        request: fullRequest,
        contextSize: model.route.defaults.limits?.context,
        profile: ContextBudget.enabled(harness.context, config.contextBudget)
          ? ContextBudget.resolve(harness.context, config.type)
          : undefined,
        memoryRecall,
      })
      if (packed.dropped > 0)
        yield* Log.event("session.context.pack.evicted", {
          "session.id": session.id,
          "session.dropped": packed.dropped,
          "session.kept.tokens": packed.estimatedTokens,
          "session.context.size": packed.contextSize,
        })
      const request = packed.changed
        ? LLM.request({ ...LLM.requestInput(fullRequest), system: packed.system, messages: packed.messages })
        : fullRequest
      const startSnapshot = yield* snapshots.capture()
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
      const budgetedSource =
        budgetEnforced && thinkingBudget > 0 && !isLastStep && thinkingEnabled(request)
          ? ReasoningBudget.stream({
              request,
              stream: (next) => llm.stream(next),
              budget: thinkingBudget,
            })
          : llm.stream(request)
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

      // Scheduler admission (notes/scheduler.md): interactive dispatches immediately;
      // batch-class sessions wait for idle device cycles. The slot covers GENERATION
      // only — released right after the provider stream settles, BEFORE tool
      // settlement, so a parent blocking on `wait` never holds the device against
      // its own child.
      // ⚠️ The in-band release below is NOT reached on an interrupt. The retry sleep is the
      // one await in this block that is not wrapped in `Effect.exit`, so a Stop landing in
      // the backoff window propagates straight out of the generator — and idempotency does
      // not help when `release` is never CALLED at all. A leaked INTERACTIVE entry
      // permanently zeroes `batchCapacity` for that device (scheduler.ts: capacity requires
      // `inFlightInteractive.size === 0`), so every batch session on it blocks forever; a
      // leaked batch entry burns one of MAX_BATCH slots.
      //
      // The `Effect.ensuring` net below is the CHOSEN and COMPLETE remedy — this is not a
      // known gap awaiting a follow-up. The obvious alternative, wrapping the retry sleep in
      // `Effect.exit` like its two neighbours, is strictly WORSE, and measurably so: an
      // `Effect.exit` turns the interrupt into a VALUE, so the Stop no longer leaves at the
      // sleep — it falls through this entire post-generation tail (measured 2026-07-28 on a
      // model of this exact composition: unwrapped stops at the sleep; wrapped runs
      // second-attempt → release → tool-await → every publish → end). It does not HANG: the
      // tail's own `restore(...)`+`Effect.exit` boundaries re-raise the pending interrupt at
      // once rather than waiting on tool settlement. What it costs is a redundant provider
      // attempt, `failUnsettledTools`/`failAssistant` publishes and a `patchSessionRecord`
      // write on the one path that must stay prompt and quiet — plus it drives an
      // already-interrupted fiber through the `recoverOverflow` restore below, which is NOT
      // exit-wrapped and is safe here only by short-circuit. All of that to reach the same
      // final interrupt exit, for a leak `ensuring` already closes with ZERO change to
      // interrupt timing. So: do not wrap the sleep.
      //
      // The net is composed so the finalizer is installed BEFORE `admit` runs — that also
      // covers the window between admission and the mask. `admit` itself stays INTERRUPTIBLE
      // on purpose: a queued batch turn must remain stoppable, and its own `onInterrupt`
      // drops the waiter (releasing a slot that was never held is a no-op).
      const deviceKey = `${model.provider}/${model.id}`
      const dispatchSlot = {
        sessionID: session.id as string,
        deviceKey,
        sessionClass: SessionScheduler.classForSessionType(config.type),
        ...(config.priority > 0 ? { priority: config.priority } : {}),
      }
      const generation = Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          // 1D — transient failures and malformed replies which produced no durable assistant
          // output reconnect in-place. A malformed tail AFTER output is accepted below as a
          // `broken` turn and continued as a new request, so tool side effects are never replayed.
          let attempt = 1
          let stream = yield* restore(providerStream).pipe(Effect.exit)
          while (stream._tag === "Failure" && !Cause.hasInterrupts(stream.cause)) {
            if (publisher.hasAssistantStarted() || attempt >= maxProviderAttempts) break
            const transient = Option.getOrUndefined(Cause.findErrorOption(stream.cause))
            if (!ProviderRetry.isRetryableBeforeOutput(transient)) break
            const delay = ProviderRetry.retryDelayMs(attempt, transient.retryAfterMs)
            yield* Log.event("session.provider.attempt.retry", {
              "session.id": session.id,
              attempt,
              "session.attempts.max": maxProviderAttempts,
              "session.provider.reason": transient.reason._tag,
              "session.provider.message": transient.message,
            })
            // Retry state is durable UI feedback, not a debug log. It is published before the sleep
            // so even a pre-stream failure (no assistant row yet) tells the user what Nova is doing.
            yield* events
              .publish(SessionStatusEvent.Status, {
                sessionID: session.id,
                status: {
                  type: "retry",
                  attempt: attempt + 1,
                  message: ProviderRetry.statusMessage(transient),
                  next: Date.now() + delay,
                },
              })
              .pipe(Effect.ignore)
            yield* restore(Effect.sleep(Duration.millis(delay)))
            attempt++
            yield* events
              .publish(SessionStatusEvent.Status, { sessionID: session.id, status: { type: "busy" } })
              .pipe(Effect.ignore)
            stream = yield* restore(providerStream).pipe(Effect.exit)
          }
          // Generation is over (success or not): free the device slot before tool
          // settlement and everything after.
          yield* scheduler.release(dispatchSlot)
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
            const endSnapshot = yield* snapshots.capture()
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
                snapshot: endSnapshot,
                files,
              }),
            )
            // Scheduler fairness accounting: charge the turn's measured compute to the
            // EEVDF ledger (uncached input + output — cache reads are nearly free).
            yield* scheduler.report({
              ...dispatchSlot,
              costTokens: stepSettlement.tokens.input + stepSettlement.tokens.output,
            })
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
        }),
      )
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
      return yield* scheduler.admit(dispatchSlot).pipe(
        Effect.andThen(generation),
        Effect.ensuring(scheduler.release(dispatchSlot)),
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
    const runAfterOverflowCompaction: RunTurn = Effect.fnUntraced(function* (sessionID, harness, promotion, step) {
      return yield* runTurnAttempt(sessionID, harness, promotion, step).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* Effect.die("Post-compaction provider attempt cannot recover another overflow")
            yield* Effect.yieldNow
            return yield* runAfterOverflowCompaction(sessionID, harness, undefined, defect.transition.step)
          }),
        ),
      )
    })

    const runTurn: RunTurn = Effect.fnUntraced(function* (sessionID, harness, promotion, step) {
      return yield* runTurnAttempt(sessionID, harness, promotion, step, harness.compaction.compactAfterOverflow).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            yield* Effect.yieldNow
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* runAfterOverflowCompaction(sessionID, harness, undefined, defect.transition.step)
            return yield* runTurn(sessionID, harness, undefined, defect.transition.step)
          }),
        ),
      )
    })

    // F1a SLICE 7 — the manual-compaction cycle (consume-side of SessionCompactionRequest).
    // Runs the SAME pre-turn assembly as runTurnAttempt (config walk → agent → context epoch →
    // model → history) but hands the entries straight to the compactor and drains NO turn — it
    // lives in the runner because only the runner holds the shared LLMClient (the OFF-C offline
    // chokepoint) and the model resolution. Failures surface as a calm Synthetic notice (the
    // "never breaks" rule: an invisible no-op compact is a broken button) and never fail the drain.
    const runManualCompaction = Effect.fn("SessionRunner.manualCompaction")(function* (
      sessionID: SessionSchema.ID,
      // Passed in for the same two reasons `runTurnAttempt` takes its harness: the session-config
      // walk below shadows `config`, and a manual `/compact` must honour the compaction settings as
      // they are NOW, not as they were when the location booted.
      compaction: Harness["compaction"],
    ) {
      const session = yield* getSession(sessionID)
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return
      const config = yield* resolveSessionConfig(EFFECTIVE_CONFIG_DEFAULTS, session.id, (id) =>
        store.get(id as SessionSchema.ID),
      )
      const agent = yield* agents.select(config.agent as typeof session.agent)
      const system =
        (yield* SessionContextEpoch.initialize(db, loadSystemContext(agent, session.id), session.id)) ??
        (yield* SessionContextEpoch.prepare(db, events, loadSystemContext(agent, session.id), session.id, (update) =>
          SessionExecutionAttempt.contextUpdatedCurrent({ ...update.data, snapshot: update.snapshot }, () =>
            SessionContextEpoch.publishUpdate(db, events, update.data, update.snapshot),
          ),
        ))
      const model = yield* models.resolve({ ...session, model: config.model as typeof session.model })
      const entries = yield* SessionHistory.entriesForRunner(db, session.id, system.baselineSeq)
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

    // Post-run maintenance — best-effort, must never fail the drain it follows (shared by the normal
    // and the Strict routes): the changes summary first (one git tree-diff; feeds the Changes
    // review/badge), then the auto-title (an LLM call) while the user reads the response.
    const postRunMaintenance = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      yield* refreshChangesSummary(sessionID).pipe(
        Effect.catchCause((cause) =>
          Log.event("session.changes.refresh.failed", {
            "session.id": sessionID,
            "session.cause": Cause.pretty(cause),
          }),
        ),
      )
      yield* generateTitleOnce(sessionID).pipe(
        Effect.catchCause((cause) =>
          Log.event("session.title.generate.failed", {
            "session.id": sessionID,
            "session.cause": Cause.pretty(cause),
          }),
        ),
      )
      yield* extractMemory(sessionID).pipe(
        Effect.catchCause((cause) =>
          Log.event("session.memory.extract.failed", {
            "session.id": sessionID,
            "session.cause": Cause.pretty(cause),
          }),
        ),
      )
    })

    // P14-minimal (jh-improve8 P3) + P14.1 (jh MVP): the Strict-harness drain — one JhEngine task per
    // pending user message; queued messages drain in order. The engine self-terminates at its wall
    // THROUGH the terminal best-restore (improve7), so a stopped run still delivers the best verified
    // state. Progress = Synthetic milestone notices (projector-safe); persistence = JhStore keyed by
    // session. P14.1 adds the four product legs: TASK/CHAT routing (a greeting must not launch an
    // engine run — the "chat" return falls through to the normal loop), cooperative Stop (engine work
    // runs on a DETACHED fiber; interrupting the drain flips the abort latch and the run finalizes
    // THROUGH the best-restore at its next step boundary), crash resume (a "running" JhStore row
    // means a hard death; a bare "resume"/"continue" continues it), and the end-of-run summary (a
    // real streamed assistant message — the user's readable answer).
    const strictInflight = new Map<SessionSchema.ID, Fiber.Fiber<void>>()
    const runStrictDrain = Effect.fn("SessionRunner.strictDrain")(function* (
      sessionID: SessionSchema.ID,
      harness: Harness,
      resolved: EffectiveConfig,
      first: SessionInput.Delivery | undefined,
    ) {
      const notice = (text: string) =>
        Effect.gen(function* () {
          yield* events.publish(SessionEvent.Synthetic, {
            sessionID,
            messageID: SessionMessage.ID.create(),
            timestamp: yield* DateTime.now,
            text,
          })
        }).pipe(Effect.ignore)
      const session = yield* getSession(sessionID)
      const model = yield* models
        .resolve({ ...session, model: resolved.model as typeof session.model })
        .pipe(
          Effect.catch((error: unknown) =>
            notice(
              `⚠️ Strict mode couldn't run — the session's model is unavailable (${error instanceof Error ? error.message : String(error)}).`,
            ).pipe(Effect.as(undefined)),
          ),
        )
      if (model === undefined) return "handled" as const
      // The engine's one-shot completion (the judgeCompletion idiom). The budget is per-CALL and comes
      // from ConfigStrict: execution steps need a whole non-trivial source file of headroom (jh.md §3
      // "Measured": a C program is ~13-15k tokens; truncation is fatal), and reasoning steps need room
      // to CLOSE their think block or they return empty (notes/jh-think-stage.md). The user owns both
      // numbers because only they know what their served context can afford.
      const completeOnce = (system: string, user: string, maxTokens: number) =>
        Effect.gen(function* () {
          const text: string[] = []
          const reasoning: string[] = []
          yield* llm
            .stream(
              LLM.request({
                model,
                system: [SystemPart.make(system)],
                messages: [Message.user(user)],
                tools: [],
                generation: { maxTokens },
              }),
            )
            .pipe(
              Stream.runForEach((event) => {
                if (LLMEvent.is.textDelta(event)) text.push(event.text)
                else if (event.type === "reasoning-delta") reasoning.push(event.text)
                return Effect.void
              }),
            )
          // A1: a reasoning model can put the whole reply in the think channel — fall back rather
          // than hand the engine an empty introspection.
          return text.join("").trim() || reasoning.join("")
        }).pipe(Effect.mapError((error) => ({ message: error instanceof Error ? error.message : String(error) })))
      let promotion = first
      for (;;) {
        if (promotion === undefined) return "handled" as const
        const cutoff = yield* EventV2.latestSequence(db, sessionID)
        let promoted = 0
        if (promotion === "steer") promoted = yield* SessionInput.promoteSteers(db, events, sessionID, cutoff)
        if (promotion === "queue") {
          promoted += Number(yield* SessionInput.promoteNextQueued(db, events, sessionID))
          promoted += yield* SessionInput.promoteSteers(db, events, sessionID, cutoff)
        }
        if (promoted === 0) return "handled" as const
        const context = yield* getContext(sessionID)
        const task = SessionStrict.lastUserText(context)
        if (task === undefined) return "handled" as const
        // A Strict TASK *is* the prompt that asked for it, so that prompt's message id names the
        // plan (see `savedKey` below). `lastUserText` already picked the newest non-steer user
        // message; find that same message again for its id. The event sequence is the fallback —
        // monotonic per session, so still distinct per task — but it is unreachable in practice:
        // `task` came out of this very array.
        const taskKey =
          context.findLast((message) => message.type === "user" && message.text.trim() === task)?.id ?? `seq${cutoff}`
        // A stopped run finalizes on a detached fiber at its next step boundary — two engines must
        // never work the same folder, so wait for any straggler before starting (or routing) anything.
        {
          const inflight = strictInflight.get(sessionID)
          if (inflight !== undefined) {
            yield* Effect.exit(Fiber.join(inflight))
            strictInflight.delete(sessionID)
          }
        }
        // The effective strict config for THIS session: the global `config.strict` overlaid with the
        // session's own override (the composer switch — enabled/attempts/wallMinutes per chat).
        const strict = { ...(harness.strict ?? {}), ...(resolved.strict ?? {}) }
        // P14.1 resume: a saved plan that never reached "done" is continuable. Status "running" means
        // a HARD death (crash/kill — a clean stop saves its terminal status), so the user is told once
        // and taught the resume word. A bare "resume"/"continue" picks the saved tree back up —
        // completed steps are never redone.
        // ⚠️ The plan id is PER TASK (`jh_<sessionID>_<taskKey>`), never per session. It used to be
        // `jh_<sessionID>`, so a SECOND Strict task in one chat wrote onto the FIRST task's rows:
        // `jh_plan` was OVERWRITTEN (onConflictDoUpdate) while A's log rows survived and B's were
        // silently dropped (the log insert is onConflictDoNothing on `(planID, seq)`), and task A's
        // artifacts were HARD-DELETED by B's first checkpoint (the artifact write replaces by plan
        // id). Resume then rebuilt A's journal against B's tree and described work nobody did — a
        // read that destroys, and a fault described falsely. The session's plans are found by
        // prefix, newest first, and a RESUME adopts the found plan's id instead of minting a new
        // one, so one task keeps one id from first checkpoint to terminal save.
        // Retention, on the way IN (jh/store.ts): a Strict run is the only thing that ever writes
        // jh_plan/jh_log/jh_artifact, and every Strict run passes here, so one lazy purge per drain
        // bounds all three tables by the TTL instead of by install age — no daemon, and no purge
        // hidden inside `latest`, because a read never destroys (todo.md ruling 3).
        yield* JhStore.purgeExpired(db, { now: Date.now() }).pipe(
          Effect.catchDefect((defect) =>
            Log.event("session.strict.retention.failed", {
              "session.id": sessionID,
              "session.defect": String(defect),
            }).pipe(Effect.as(0)),
          ),
        )
        const saved = yield* JhStore.latest(db, `jh_${sessionID}_`).pipe(
          Effect.catchDefect((defect) =>
            Log.event("session.strict.resume.failed", {
              "session.id": sessionID,
              "session.defect": String(defect),
            }).pipe(Effect.as(undefined)),
          ),
        )
        const resumable = saved !== undefined && saved.status !== "done"
        const wantsResume = SessionStrict.resumeIntent(task)
        const resuming = wantsResume && resumable
        const goal = resuming ? saved!.goal : task
        const resumeState = resuming ? saved!.state : undefined
        const savedKey = resuming ? saved!.id : `jh_${sessionID}_${taskKey}`
        if (!resuming) {
          // P14.1 routing: "resume" with nothing to resume is a conversation ("continue what?");
          // everything else asks the router. Only an explicit CHAT verdict leaves the engine path —
          // ambiguity resolves to TASK, the user's stated stance (they turned Strict on). An
          // unreachable model also routes to TASK: the engine path surfaces model failures properly.
          const verdict = wantsResume
            ? ("chat" as const)
            : SessionStrict.routeOf(
                yield* completeOnce(SessionStrict.ROUTE_SYSTEM, task, SessionStrict.ROUTE_TOKENS).pipe(
                  Effect.catch(() => Effect.succeed("TASK")),
                ),
              )
          if (saved !== undefined && saved.status === "running") {
            const shortGoal = saved.goal.length > 100 ? saved.goal.slice(0, 100) + "…" : saved.goal
            yield* notice(
              `⏸️ A previous Strict run was interrupted before finishing — “${shortGoal}”. Your files kept every verified step; say "resume" to continue it.`,
            )
            // ⚠️ `saved.id`, NOT `savedKey`: this arm is the NOT-resuming path, where `savedKey` is
            // the id the NEW task is about to claim. Downgrading "running" → "interrupted" must
            // write back to the plan it describes.
            yield* JhStore.save(db, {
              id: saved.id,
              goal: saved.goal,
              status: "interrupted",
              state: saved.state,
              now: Date.now(),
            })
          }
          if (verdict === "chat") return "chat" as const
        }
        // ── the ONE host-execution gate (ruling 6, `src/host-exec.ts`), now ENGAGED for Strict ──
        // Every command a Strict run executes is model-authored and approved by nobody, so the
        // CREDENTIAL half of the gate already applied (`consent: "none"` in strict.ts). The
        // CONFINEMENT half could not: it needs facts only the runner holds — the chain-ROOT session
        // type, whether an untrusted messenger chat drives the turn, the operator's configured
        // shell, and the live offline policy — and without them the gate refuses to invent an
        // attendance nobody declared and runs raw. Handing them over is what makes an UNATTENDED
        // Strict chain (a Calendar fire, a messenger dispatch with strict.enabled) bwrap-confined on
        // a host with a sandbox backend, exactly like the `bash` tool.
        const rootType = yield* rootSessionType(sessionID, (id) => store.get(id as SessionSchema.ID))
        // messenger-plan §3.4: the binding can sit on an ANCESTOR (a bound session spawning a worker
        // is the recommended pattern), so the whole chain is asked — through the same walk the
        // `bash` tool uses, never a second copy.
        // ⚠️ `HostExec.Hostility`, not a boolean: a fault in either lookup yields `"unknown"`, which
        // the gate treats as hostile. A Strict run executes model-authored commands that NO human
        // approved, so it is the last place that should be resolving an unanswerable trust question
        // in favour of running raw. Both lookups are passed through un-recovered deliberately.
        const hostileInput = yield* HostExec.chainHasHostileBinding(sessionID, {
          bindingsForSession: (id) => messengerStore.bindingsForSession(id),
          parentOf: (id) => store.get(id as SessionSchema.ID).pipe(Effect.map((info) => info?.parentID)),
        })
        // Probe once; the same answer decides the run below and plans every command inside it.
        const backend = HostExec.probe()
        const configuredShell = harness.configuredShell
        // SAFE MODE (owner 2026-07-30): the per-session switch that restores the unattended deny
        // arm. Passed here for the same reason the shell and the offline policy are — the gate
        // decides nothing it was not told, and an unwired caller would silently get the permissive
        // default. `resolved` is this session's chain-resolved config, the same value `tool/bash.ts`
        // computes for itself.
        const strictHost: HostExec.SessionHost = {
          rootType,
          hostileInput,
          ...(configuredShell === undefined ? {} : { shell: configuredShell }),
          ...(resolved.safeMode === undefined ? {} : { safeMode: resolved.safeMode }),
          egress: offline.egressEnv(),
          backend,
        }
        // Deny-fast — the same reordering `tool/bash.ts` already needed. On a host with no sandbox
        // backend an unattended chain has EVERY command refused, so starting the engine would spend
        // the whole wall producing nothing but deny messages and then report on them. Name the
        // refusal once and fall through to the normal turn, whose path-gated native tools still
        // work. (An attended chain never reaches this arm.)
        if (HostExec.decide({ rootType, hostileInput, backend, safeMode: resolved.safeMode }) === "deny") {
          yield* notice(
            `🛡️ Strict mode can't run this here. ${HostExec.denyMessage(rootType, hostileInput, resolved.safeMode)} Answering normally instead.`,
          )
          return "chat" as const
        }
        // improve11 P5 (jh.md §14.2): best-of-N racing — explicit opt-in via strict.attempts. Each
        // racer works on a bounded FORK of the folder; the first oracle-... (in sessions: the first
        // attempt whose run completes DONE) wins and its changes are applied back; losers are deleted.
        // Measured (12 rig races): ~2× per-wall success; contention notes in jh-improve11.md.
        // A RESUMED run is always single-attempt: the saved tree describes the LIVE folder, not a fork.
        let attempts =
          resumeState !== undefined
            ? 1
            : Math.max(1, Math.min(SessionStrict.MAX_ATTEMPTS, Math.floor(strict.attempts ?? 1)))
        let baseline: ReadonlyMap<string, string> | undefined
        let forks: string[] = []
        if (attempts > 1) {
          baseline = SessionStrict.manifestFor(location.directory)
          for (let i = 0; i < attempts; i++) {
            const fork = SessionStrict.forkWorkspace(location.directory, i + 1)
            if ("refused" in fork) {
              yield* notice(`🛡️ Racing is OFF for this task — ${fork.refused}. Running a single attempt instead.`)
              for (const d of forks)
                try {
                  fs.rmSync(d, { recursive: true, force: true })
                } catch {}
              forks = []
              attempts = 1
              break
            }
            forks.push(fork.dir)
          }
        }
        const single = attempts === 1
        yield* notice(
          resuming
            ? `▶️ Resuming the Strict run — picking up from the last verified step.`
            : single
              ? `🛡️ Strict mode: working on this step-by-step — plan, verified actions, and recovery notices will appear below.`
              : `🛡️ Strict mode: racing ${attempts} independent attempts on isolated copies of the folder — the first verified success is kept, the rest are discarded.`,
        )
        // P14.1 Stop: the abort latch. Interrupting the drain (the Stop button →
        // SessionExecution.interrupt) flips it via onInterrupt below; the engine exits THROUGH the
        // terminal best-restore at its next boundary (never a half-written step), and in-flight model
        // calls are raced against the latch so a stop lands in seconds, not a whole model call.
        let stopRequested = false
        const abortWatch: Effect.Effect<never, JhEngine.LLMFail> = Effect.gen(function* () {
          for (;;) {
            if (stopRequested) return yield* Effect.fail({ message: "stopped by the user" })
            yield* Effect.sleep(Duration.millis(500))
          }
        })
        // raceFirst, not race: the latch's FAILURE must decide the race and interrupt the in-flight
        // model call (plain race waits for the first SUCCESS and would ignore the failing watcher).
        const completeAbortable = (system: string, user: string, maxTokens: number) =>
          Effect.raceFirst(completeOnce(system, user, maxTokens), abortWatch)
        let winnerIdx: number | undefined
        // P14.1 materialization (legibility): a run shares ONE assistant message — every state-
        // changing engine action lands on it as a real tool part (fed through the publisher as
        // synthetic LLM tool events, so ordering/persistence/UI ride the normal pipeline), and the
        // end-of-run summary streams onto the same message. SINGLE attempts materialize LIVE; RACING
        // buffers each racer's actions and replays only the WINNER's after the race resolves — N
        // interleaved live racers would be noise, but the winner's clean action sequence is exactly
        // what the user wants to read. The publisher is lazy (no message until the first publish), so
        // creating it up-front for racing shows nothing until the post-race replay.
        //
        // ⚠️ The START snapshot is not optional decoration — it is what Revert and Changes restore
        // FROM. The normal drain has always captured one here; the Strict route omitted the field,
        // so `SessionRevert` skipped every Strict message (`!message.snapshot?.start`) and the
        // Changes badge saw no boundary: a run could rewrite the whole folder and "Revert" would
        // silently restore ZERO files. Captured BEFORE the engine touches anything, which is also
        // correct while racing — the racers work on forks and the winner is applied back into this
        // same folder afterwards.
        const startSnapshot = yield* snapshots.capture()
        const runPublisher = createLLMEventPublisher(events, {
          sessionID,
          agent: String(resolved.agent ?? session.agent ?? "nova"),
          model: {
            id: ModelV2.ID.make(model.id),
            providerID: ProviderV2.ID.make(model.provider),
            ...(session.model?.variant === undefined ? {} : { variant: session.model.variant }),
          },
          ...(startSnapshot === undefined ? {} : { snapshot: startSnapshot }),
          executionBoundary: SessionExecutionAttempt.advanceCurrent,
          providerToolProtocol: SessionExecutionAttempt.providerToolProtocolCurrent,
          toolDispatched: SessionExecutionAttempt.toolDispatchedCurrent,
          toolSettled: SessionExecutionAttempt.toolSettledCurrent,
        })
        // Per-racer action buffers (racing only): bounded, so the winner's can be replayed post-race.
        const racerActions: SessionStrict.MaterializedAction[][] = single ? [] : forks.map(() => [])
        const recordAction = (i: number) => (action: SessionStrict.MaterializedAction) =>
          Effect.sync(() => {
            const buf = racerActions[i]!
            buf.push(action)
            if (buf.length > SessionStrict.MATERIALIZED_ACTION_CAP) buf.shift()
          })
        let actionSeq = 0
        const publishAction = (action: SessionStrict.MaterializedAction) =>
          Effect.gen(function* () {
            const id = `jh_a${++actionSeq}`
            yield* runPublisher.publish({ type: "tool-input-start", id, name: action.tool })
            yield* runPublisher.publish({ type: "tool-call", id, name: action.tool, input: action.args })
            yield* runPublisher.publish({
              type: "tool-result",
              id,
              name: action.tool,
              result: action.ok ? { type: "text", value: action.output } : { type: "error", value: action.output },
            })
          }).pipe(
            Effect.catchCause((cause) =>
              Log.event("session.strict.action.failed", {
                "session.id": sessionID,
                "session.cause": Cause.pretty(cause),
              }),
            ),
          )
        const runOne = (i: number, cwd: string) =>
          SessionStrict.runTask({
            task: goal,
            cwd,
            strict,
            // The completion GATE's verifier (jh.md §14.1 — a judge or a self-assessment is fallible
            // input, never ground truth). Without this line the gate is unreachable and Strict's
            // whole-task authority stays `verifyGoal`'s LLM goal-check, i.e. the model grading its own
            // homework. Overlaid the same way `strict` is above, so the per-chat Quality switch wins
            // over the instance default; `Quality.DEFAULTS.enabled` is false, so an instance that has
            // configured no commands sees no behaviour change at all.
            quality: { ...harness.quality, enabled: resolved.quality ?? harness.quality.enabled },
            host: strictHost,
            completeOnce: completeAbortable,
            ...(resumeState === undefined ? {} : { resume: resumeState }),
            onMilestone: (text) => notice(single ? text : `[attempt ${i + 1}/${attempts}] ${text}`),
            aborted: () => stopRequested || (winnerIdx !== undefined && winnerIdx !== i),
            onAction: single ? publishAction : recordAction(i),
            checkpoint: single
              ? (state) =>
                  JhStore.save(db, { id: savedKey, goal, status: "running", state, now: Date.now() }).pipe(
                    Effect.ignore,
                  )
              : undefined, // racers don't persist; the winner's final state is saved below
          }).pipe(
            Effect.tap((r) =>
              Effect.sync(() => {
                if (r.status === "done" && winnerIdx === undefined) winnerIdx = i
              }),
            ),
            Effect.catchCause((cause: Cause.Cause<unknown>) =>
              Log.event("session.strict.attempt.failed", {
                "session.id": sessionID,
                attempt: i + 1,
                "session.cause": Cause.pretty(cause),
              }).pipe(Effect.as(undefined)),
            ),
          )
        // The END boundary of the run, captured ONCE and shared by both settlement paths below.
        // ⚠️ The Strict route published Step.Ended with NEITHER `snapshot` nor `files`, so
        // `session/changes.ts` found no `snapshot.end` and `session/revert.ts` no `snapshot.files`:
        // a whole Strict run was invisible to the Changes badge and restored nothing on Revert.
        // Captured after the engine has settled (and after a race applies its winner back), so it
        // describes the folder the user is actually looking at.
        let endBoundary:
          | { readonly snapshot: Snapshot.ID | undefined; readonly files: readonly RelativePath[] | undefined }
          | undefined
        const captureEndBoundary = Effect.fnUntraced(function* () {
          if (endBoundary !== undefined) return endBoundary
          const endSnapshot = yield* snapshots.capture()
          const files =
            startSnapshot && endSnapshot
              ? yield* snapshots
                  .files({ from: startSnapshot, to: endSnapshot })
                  .pipe(Effect.catch(() => Effect.succeed(undefined)))
              : undefined
          endBoundary = { snapshot: endSnapshot, files }
          return endBoundary
        })
        // P14.1 final answer: the end-of-run summary — a REAL streamed assistant message built from
        // harness ground truth (goal, outcome, the phase journal, applied files), so the user reads a
        // normal reply instead of decoding notices. Best-effort: the terminal notice already stated
        // the outcome, so a failed summary only costs polish.
        const publishSummary = (report: JhEngine.Report, appliedFiles: ReadonlyArray<string>) =>
          Effect.gen(function* () {
            const milestones = report.state.log
              .map((entry) => SessionStrict.milestone(entry))
              .filter((line): line is string => line !== undefined)
            const prompts = SessionStrict.summaryPrompt({
              goal,
              status: report.status,
              ...(report.reason === undefined ? {} : { reason: report.reason }),
              milestones,
              appliedFiles,
              // The engine's own answer to "was a best verified state actually held?" — the model is
              // told to base every claim on this block, so the outcome line must not assert a
              // fallback that does not exist (it never does on an ungraded run, which is all of them).
              keptBest: report.keptBest,
            })
            // The summary streams onto the SAME run message that carries the tool parts (single =
            // live actions; racing = the replayed winner's actions) — one message = the whole run.
            const publisher = runPublisher
            yield* llm
              .stream(
                LLM.request({
                  model,
                  system: [SystemPart.make(prompts.system)],
                  messages: [Message.user(prompts.user)],
                  tools: [],
                  generation: { maxTokens: SessionStrict.SUMMARY_TOKENS },
                }),
              )
              .pipe(Stream.runForEach((event) => publisher.publish(event)))
            const settlement = publisher.stepSettlement()
            if (settlement !== undefined && !publisher.hasProviderError()) {
              const boundary = yield* captureEndBoundary()
              yield* events.publish(SessionEvent.Step.Ended, {
                sessionID,
                timestamp: yield* DateTime.now,
                assistantMessageID: yield* publisher.startAssistant(),
                finish: settlement.finish,
                cost: 0,
                tokens: settlement.tokens,
                snapshot: boundary.snapshot,
                files: boundary.files,
              })
            }
          }).pipe(
            Effect.catchCause((cause) =>
              Log.event("session.strict.summary.failed", {
                "session.id": sessionID,
                "session.cause": Cause.pretty(cause),
              }),
            ),
            // The run message may already exist (tool parts) — a failed/empty summary must not
            // leave it visibly unsettled forever. Best-effort: settle with a plain stop.
            Effect.andThen(
              Effect.gen(function* () {
                if (actionSeq === 0) return
                if (runPublisher.stepSettlement() !== undefined) return
                // Same boundary as the settled path: a run whose summary failed still changed the
                // folder, so Revert/Changes must still see what it touched.
                const boundary = yield* captureEndBoundary()
                yield* events.publish(SessionEvent.Step.Ended, {
                  sessionID,
                  timestamp: yield* DateTime.now,
                  assistantMessageID: yield* runPublisher.startAssistant(),
                  finish: "stop",
                  cost: 0,
                  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                  snapshot: boundary.snapshot,
                  files: boundary.files,
                })
              }).pipe(Effect.ignore),
            ),
          )
        // The engine work + everything owed to the user afterwards runs on a DETACHED fiber: when the
        // drain is interrupted (Stop), this fiber survives, the latch stops the engine at its next
        // step boundary through the best-restore, and the stopped-notice/summary/save still arrive.
        const finalize = Effect.gen(function* () {
          const reports = single
            ? [yield* runOne(0, location.directory)]
            : yield* Effect.all(
                forks.map((dir, i) => runOne(i, dir)),
                { concurrency: "unbounded" },
              )
          const report =
            winnerIdx !== undefined ? reports[winnerIdx] : (reports.find((r) => r !== undefined) ?? undefined)
          if (report === undefined) {
            yield* notice(
              "⚠️ The Strict run hit an internal error — see the server log. The working directory is left as-is.",
            )
            for (const d of forks)
              try {
                fs.rmSync(d, { recursive: true, force: true })
              } catch {}
            return
          }
          let appliedFiles: string[] = []
          if (!single) {
            if (winnerIdx !== undefined && baseline) {
              appliedFiles = SessionStrict.applyBack(forks[winnerIdx]!, location.directory, baseline)
              yield* notice(
                `🏁 Attempt ${winnerIdx + 1}/${attempts} WON the race — ${appliedFiles.length} changed file${appliedFiles.length === 1 ? "" : "s"} applied to the folder: ${appliedFiles.slice(0, 8).join(", ")}${appliedFiles.length > 8 ? ", …" : ""}`,
              )
              for (const d of forks)
                try {
                  fs.rmSync(d, { recursive: true, force: true })
                } catch {}
            } else if (stopRequested) {
              yield* notice(`🏁 The race was stopped before any attempt verified success — YOUR FOLDER IS UNCHANGED.`)
              for (const d of forks)
                try {
                  fs.rmSync(d, { recursive: true, force: true })
                } catch {}
            } else {
              yield* notice(
                `🏁 No attempt verified success — YOUR FOLDER IS UNCHANGED. The attempt workspaces are kept for inspection: ${forks.join(" · ")}`,
              )
            }
          }
          yield* JhStore.save(db, {
            id: savedKey,
            goal,
            status: report.status,
            state: report.state,
            now: Date.now(),
          }).pipe(Effect.ignore)
          // The terminal claim, conditioned on what the engine ACTUALLY held. This text used to
          // assert "the best verified state was kept" on every stopped run — false in every real
          // Strict session, because the engine only snapshots a best on a GRADED improvement and
          // this route supplies no oracle to grade with. The wording lives in `SessionStrict` so it
          // has one home and both directions are unit-tested.
          yield* notice(
            SessionStrict.terminalNotice({
              status: report.status,
              ...(report.reason === undefined ? {} : { reason: report.reason }),
              steps: report.state.tree.nodes.size,
              single,
              keptBest: report.keptBest,
            }),
          )
          // Racing legibility: replay the WINNER's buffered actions as real tool parts on the run
          // message (single attempts already materialized them live) — so a raced run reads like a
          // normal run, not just notices. The summary then streams onto the same message.
          if (!single && winnerIdx !== undefined)
            for (const action of racerActions[winnerIdx]!) yield* publishAction(action)
          yield* publishSummary(report, appliedFiles)
          yield* postRunMaintenance(sessionID)
        }).pipe(
          Effect.catchCause((cause) =>
            Log.event("session.strict.finalize.failed", {
              "session.id": sessionID,
              "session.cause": Cause.pretty(cause),
            }),
          ),
        )
        const worker = yield* Effect.forkDetach(finalize)
        strictInflight.set(sessionID, worker)
        yield* Fiber.join(worker).pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              stopRequested = true
            }),
          ),
        )
        strictInflight.delete(sessionID)
        promotion = "queue"
        if (!(yield* SessionInput.hasPending(db, sessionID, "queue"))) return "handled" as const
      }
    })

    const run = Effect.fn("SessionRunner.run")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly force: boolean
    }) {
      // Arm the 30s title fallback for LONG turns. A short turn finishes first and titles at drain end as
      // before; a compile-test-retry turn gets a name while it is still working, instead of sitting in the
      // chat list as a placeholder for minutes.
      yield* scheduleEarlyTitle(input.sessionID)
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
              "session.cause": Cause.pretty(cause),
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
      yield* markChangesIncomplete(input.sessionID).pipe(
        Effect.catchCause((cause) =>
          Log.event("session.changes.refresh.failed", {
            "session.id": input.sessionID,
            "session.cause": Cause.pretty(cause),
          }),
        ),
      )
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
          // context and ends with its own postRunMaintenance).
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
            if (introspectionOn && Introspection.shouldJudge(step, harness.introspection.cadence))
              yield* introspect(input.sessionID, harness.introspection).pipe(
                Effect.catch((cause) =>
                  Log.event("session.introspection.judge.failed", {
                    "session.id": input.sessionID,
                    "session.cause": String(cause),
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
                      "session.cause": Cause.pretty(cause),
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
                      "session.cause": Cause.pretty(cause),
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
          const decision = SessionDrive.decide(latest, driveState, DateTime.toEpochMillis(yield* DateTime.now))
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
          }
        }
      }
      yield* postRunMaintenance(input.sessionID)
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
  ],
})
