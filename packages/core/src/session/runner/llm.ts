import {
  LLM,
  LLMClient,
  LLMError,
  LLMEvent,
  Message,
  SystemPart,
  isContextOverflowFailure,
  type ProviderErrorEvent,
} from "@novaclaw/llm"
import { Cause, DateTime, Duration, Effect, FiberSet, Layer, Option, Semaphore, Stream } from "effect"
import path from "path"
import { AgentV2 } from "../../agent"
import { Config } from "../../config"
import { Global } from "../../global"
import { Persona } from "../../persona"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { Location } from "../../location"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import { QuestionV2 } from "../../question"
import { SystemContext } from "../../system-context/index"
import { SystemContextRegistry } from "../../system-context/registry"
import { SkillGuidance } from "../../skill/guidance"
import { ReferenceGuidance } from "../../reference/guidance"
import { ToolRegistry } from "../../tool/registry"
import { ToolOutputStore } from "../../tool-output-store"
import { SessionContextEpoch } from "../context-epoch"
import { SessionCompaction } from "../compaction"
import { SessionEvent } from "../event"
import { SessionHistory } from "../history"
import { SessionInput } from "../input"
import { SessionMessage } from "../message"
import { Prompt } from "../prompt"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { resolveSessionConfig, EFFECTIVE_CONFIG_DEFAULTS } from "../config-resolve"
import { SessionScheduler } from "../scheduler"
import { type RunError, Service } from "./index"
import { SessionRunnerModel } from "./model"
import { createLLMEventPublisher } from "./publish-llm-event"
import { toLLMMessages } from "./to-llm-message"
import { AdhocGuidance } from "../../adhoc-tools/guidance"
import { Affective } from "./affective"
import { ContextPack } from "./context-pack"
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
import { Introspection } from "./introspection"
import { MAX_STEPS_PROMPT } from "./max-steps"
import { ProviderRetry } from "./provider-retry"
import { Quality } from "./quality"
import { QualityProvision } from "./quality-provision"
import { Snapshot } from "../../snapshot"
import { AppProcess } from "../../process"
import { ChildProcess } from "effect/unstable/process"
import { makeLocationNode } from "../../effect/app-node"
import { llmClient } from "../../effect/app-node-platform"

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
 *   - [ ] Update title, summaries, compaction state, and cleanup in bounded background work.
 *
 * Use `llm.stream(request)` for each provider turn. Keep tool execution and continuation here.
 * Durable continuation recovery remains a separate future slice with an explicit retry policy.
 *
 * The current slice loads V2 history, translates it, resolves a model through a core service, and persists one
 * provider turn. Registry definitions are advertised, local tool calls are settled durably, and an
 * explicit loop starts the next provider turn after local settlement. Configured agent step limits bound the loop.
 */

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
    const skillGuidance = yield* SkillGuidance.Service
    const referenceGuidance = yield* ReferenceGuidance.Service
    const adhocGuidance = yield* AdhocGuidance.Service
    const config = yield* Config.Service
    const snapshots = yield* Snapshot.Service
    const scheduler = yield* SessionScheduler.Service
    const db = (yield* Database.Service).db
    const configEntries = yield* config.entries()
    const compaction = SessionCompaction.make({ events, llm, config: configEntries })
    // The B3 persona baseline: composed FIRST in the system prompt (before any per-session
    // override or the agent's own prompt), so the assistant's approach survives model swaps.
    const personaBaseline = Persona.resolve(Config.latest(configEntries, "persona"), {
      notesDir: path.join(Global.Path.data, "notes"),
    })
    // B4: the user profile is no longer injected into the system prompt here. When the user enables it,
    // the model reads it ON DEMAND via the `profile` tool (tool/profile.ts) — keeping local-model
    // context lean. Disabled = the profile is simply not shared.
    // QE (QE-B): the deterministic 5-step verify loop over the PROVISIONED commands.
    // Default OFF; failures steer the agent to fix and re-run (observation, never a halt).
    const appProcess = yield* AppProcess.Service
    const qualityConfig = Quality.resolve(Config.latest(configEntries, "quality"))
    const qualityShell =
      Config.latest(configEntries, "shell") ??
      (process.platform === "win32" ? (process.env.COMSPEC ?? "cmd.exe") : "/bin/sh")
    const runQualityCheck = Effect.fn("SessionRunner.qualityCheck")(function* (
      sessionID: SessionSchema.ID,
      check: { readonly label: string; readonly command: string; readonly timeoutMs?: number },
    ) {
      const command = ChildProcess.make(check.command, [], {
        cwd: location.directory,
        shell: qualityShell,
        stdin: "ignore",
        detached: process.platform !== "win32",
        forceKillAfter: Duration.seconds(3),
      })
      const result = yield* appProcess
        .run(command, {
          combineOutput: true,
          timeout: Duration.millis(check.timeoutMs ?? 60_000),
          maxOutputBytes: 32_768,
        })
        .pipe(
          Effect.map((run) => ({ ok: true as const, run })),
          Effect.catchTag("AppProcessError", (error) => Effect.succeed({ ok: false as const, error })),
        )
      const failed = !result.ok
        ? {
            output: String(result.error.stderr ?? result.error.message ?? ""),
            timedOut: /Timed out/i.test(String((result.error.cause as { message?: string } | undefined)?.message ?? "")),
          }
        : result.run.exitCode !== 0
          ? { output: result.run.output?.toString("utf8") ?? "", exit: result.run.exitCode }
          : undefined
      if (!failed) {
        yield* Effect.logDebug("quality check passed", { sessionID, label: check.label })
        return false
      }
      yield* Effect.logInfo("quality check FAILED — steering", { sessionID, label: check.label })
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

    // P3: per-session mood state for the affective engine (in-memory per location; bounded).
    const affectiveConfig = Config.latest(configEntries, "affective")
    const moods = new Map<string, Affective.Mood>()
    const MAX_MOODS = 500
    const rememberMood = (sessionID: string, mood: Affective.Mood) => {
      if (moods.size >= MAX_MOODS && !moods.has(sessionID)) moods.clear()
      moods.set(sessionID, mood)
    }
    // QE-A: sessions already nudged to provision quality commands (once per session).
    const provisionNudged = new Set<string>()

    // P2 (2A/2B): the out-of-band judge call. Best-effort by design — ANY failure (judge
    // model unreachable, resolution error, empty reply) is logged and swallowed; the judge
    // must never break the session it watches. Returns a small text completion.
    const introspectionConfig = Introspection.resolve(Config.latest(configEntries, "introspection"))
    const judgeCompletion = Effect.fn("SessionRunner.introspectionJudge")(function* (
      sessionID: SessionSchema.ID,
      prompt: string,
    ) {
      const session = yield* getSession(sessionID)
      const model = yield* models.resolve(
        introspectionConfig.model === undefined
          ? session
          : {
              ...session,
              model: {
                providerID: ProviderV2.ID.make(introspectionConfig.model.providerID),
                id: ModelV2.ID.make(introspectionConfig.model.id),
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

    const introspect = Effect.fn("SessionRunner.introspect")(function* (sessionID: SessionSchema.ID) {
      const excerpt = Introspection.judgeExcerpt(yield* getContext(sessionID))
      if (!excerpt) return
      const verdict = yield* judgeCompletion(sessionID, Introspection.judgePrompt(introspectionConfig.prompt, excerpt))
      if (!Introspection.isYesVerdict(verdict)) return
      let interjection = introspectionConfig.interjection
      if (introspectionConfig.generateInterjection) {
        const generated = yield* judgeCompletion(sessionID, Introspection.generatePrompt(excerpt)).pipe(
          Effect.orElseSucceed(() => ""),
        )
        if (generated.trim()) interjection = generated.trim()
      }
      yield* Effect.logInfo("introspection interjecting", { sessionID })
      yield* SessionInput.steer(db, events, sessionID, interjection)
    })
    const failInterruptedTools = Effect.fn("SessionRunner.failInterruptedTools")(function* (
      sessionID: SessionSchema.ID,
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
            error: { type: "unknown", message: "Tool execution interrupted" },
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

    const loadSystemContext = (agent: AgentV2.Selection) =>
      Effect.all([systemContext.load(), skillGuidance.load(agent), referenceGuidance.load(), adhocGuidance.load()], {
        concurrency: "unbounded",
      }).pipe(Effect.map(SystemContext.combine))

    const runTurnAttempt = Effect.fn("SessionRunner.runTurn")(function* (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      recoverOverflow?: typeof compaction.compactAfterOverflow,
    ) {
      const session = yield* getSession(sessionID)
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return yield* Effect.interrupt
      // Agent-OS Phase 1 (architecture.md): resolve model + agent through the config-inheritance
      // walk, so a child session inherits its parent's unless overridden. Behavior-preserving at the
      // root (the chain is just [session] -> config.* === session.*). config.* carry the real branded
      // values (they flow from session.* through the walk; only the static type is widened -> cast).
      const config = yield* resolveSessionConfig(EFFECTIVE_CONFIG_DEFAULTS, session.id, (id) =>
        store.get(id as SessionSchema.ID),
      )
      const agent = yield* agents.select(config.agent as typeof session.agent)
      const initialized = yield* SessionContextEpoch.initialize(db, loadSystemContext(agent), session.id)
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
        initialized ?? (yield* SessionContextEpoch.prepare(db, events, loadSystemContext(agent), session.id))
      const model = yield* models.resolve({ ...session, model: config.model as typeof session.model }).pipe(
        // Surface a pre-turn model failure IN THE CHAT, not just the server log. Model resolution
        // runs before any assistant row exists, so `step.failed` (which carries its error on an
        // assistant message) can't convey it — the turn would otherwise fail silently. Emit a calm
        // Synthetic notice so the transcript shows WHY the turn didn't run, then let it fail as
        // before. Best-effort (`Effect.ignore`): a publish hiccup must not mask the real error.
        Effect.tapError((error) =>
          Effect.gen(function* () {
            const reason =
              "providerID" in error
                ? `the selected model \`${error.providerID}/${error.modelID}\` is unavailable`
                : "no model is selected"
            yield* events.publish(SessionEvent.Synthetic, {
              sessionID: session.id,
              messageID: SessionMessage.ID.create(),
              timestamp: yield* DateTime.now,
              text: `⚠️ This turn couldn't run — ${reason}. Pick an available model in Settings, or check that its backend is running.`,
            })
          }).pipe(Effect.ignore),
        ),
      )
      const entries = yield* SessionHistory.entriesForRunner(db, session.id, system.baselineSeq)
      const context = entries.map((entry) => entry.message)
      const isLastStep = agent.info?.steps !== undefined && currentStep >= agent.info.steps
      const toolMaterialization = isLastStep ? undefined : yield* tools.materialize(agent.info?.permissions)
      const promptCacheKey = /^ses_[0-9a-f]{64}$/.test(session.id) ? session.id.slice(4) : session.id
      // P3 (3A/3B): appraise the per-session mood from what has happened so far (runs BEFORE
      // this turn's request, afpro-style), modulate sampling AROUND the model's configured
      // baseline, and at high frustration/urgency steer a one-shot redirect (rising-edge only —
      // decay naturally re-arms it). Enabled via global config or the per-session flag.
      let affectiveGeneration: ReturnType<typeof Affective.toSampling> | undefined
      if (affectiveConfig?.enabled === true || config.affective) {
        const previous = moods.get(session.id) ?? Affective.calmMood
        const mood = Affective.appraise(previous, context)
        rememberMood(session.id, mood)
        const defaults = model.route.defaults.generation
        affectiveGeneration = Affective.toSampling(
          mood,
          {
            // `|| undefined`: a config temperature of 0 means "cleared from the settings tab"
            // (updateGlobal can't remove keys over the wire), not a real 0 baseline.
            temperature: defaults?.temperature ?? (affectiveConfig?.temperature || undefined),
            topP: defaults?.topP,
            topK: defaults?.topK,
            frequencyPenalty: defaults?.frequencyPenalty,
            presencePenalty: defaults?.presencePenalty,
          },
          {
            toolsPresent: (toolMaterialization?.definitions.length ?? 0) > 0,
            extended: affectiveConfig?.extended === true,
          },
        )
        const nudge = Affective.intervention(mood)
        const wasCalm = Affective.intervention(previous) === undefined
        if (nudge && wasCalm) yield* SessionInput.steer(db, events, session.id, nudge)
      }
      const fullRequest = LLM.request({
        model,
        providerOptions: { openai: { promptCacheKey } },
        system: [personaBaseline, config.systemPromptOverride, agent.info?.system, system.baseline]
          .filter((part): part is string => part !== undefined && part.length > 0)
          .map(SystemPart.make),
        messages: [...toLLMMessages(context, model), ...(isLastStep ? [Message.assistant(MAX_STEPS_PROMPT)] : [])],
        tools: toolMaterialization?.definitions ?? [],
        toolChoice: isLastStep ? "none" : undefined,
        ...(affectiveGeneration === undefined ? {} : { generation: affectiveGeneration }),
      })
      if (yield* compaction.compactIfNeeded({ sessionID: session.id, entries, model, request: fullRequest }))
        return yield* Effect.die(continueAfterCompaction(currentStep))
      // 1M — the deterministic fail-safe under compaction: pack the outgoing request to the
      // server's HONORED window so an Ollama-class server never silently front-truncates the
      // system prompt away. Reached when compaction declined (window unknown, summary model
      // unavailable, or simply under ITS threshold) — history in the DB stays intact.
      const packed = ContextPack.packRequest({
        request: fullRequest,
        contextSize: model.route.defaults.limits?.context,
      })
      if (packed.dropped > 0)
        yield* Effect.logWarning("context pack evicted history from the outgoing request", {
          sessionID: session.id,
          dropped: packed.dropped,
          keptTokens: packed.estimatedTokens,
          contextSize: packed.contextSize,
        })
      const request = packed.changed
        ? LLM.request({ ...LLM.requestInput(fullRequest), messages: packed.messages })
        : fullRequest
      const startSnapshot = yield* snapshots.capture()
      const publisher = createLLMEventPublisher(events, {
        sessionID: session.id,
        agent: agent.id,
        model: {
          id: ModelV2.ID.make(model.id),
          providerID: ProviderV2.ID.make(model.provider),
          ...(session.model?.variant === undefined ? {} : { variant: session.model.variant }),
        },
        snapshot: startSnapshot,
      })
      const withPublication = Semaphore.makeUnsafe(1).withPermit
      const publish = (event: LLMEvent, outputPaths: ReadonlyArray<string> = []) =>
        withPublication(publisher.publish(event, outputPaths))
      let overflowFailure: ProviderErrorEvent | undefined
      // 1D: an attempt that produced ANY event is never retried (a retry would duplicate
      // partially-streamed output) — only pure pre-stream failures (connection refused,
      // an HTTP error before the first SSE event) are transparently retried below.
      let sawProviderEvent = false
      const providerStream = llm.stream(request).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            sawProviderEvent = true
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
              yield* withPublication(publisher.failUnsettledTools("Tools are disabled after the maximum agent steps"))
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
                  call: event,
                }),
              ).pipe(
                Effect.flatMap((settlement) =>
                  publish(
                    LLMEvent.toolResult({
                      id: event.id,
                      name: event.name,
                      result: settlement.result,
                      output: settlement.output,
                    }),
                    settlement.outputPaths ?? [],
                  ),
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
      // its own child. Idempotent release also guards the interrupt/defect exits.
      const deviceKey = `${model.provider}/${model.id}`
      const dispatchSlot = {
        sessionID: session.id as string,
        deviceKey,
        sessionClass: SessionScheduler.classForSessionType(config.type),
        ...(config.priority > 0 ? { priority: config.priority } : {}),
      }
      yield* scheduler.admit(dispatchSlot)
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          // 1D — the forgiving loop: a TRANSIENT provider failure (local server down or
          // restarting, 5xx, 429) that produced no events is retried with backoff, bounded
          // by a hard per-turn attempt cap so a dead endpoint fails in seconds, not forever.
          // Fatal classes (auth, invalid request, …) and mid-stream failures keep today's
          // behavior; context overflow has its own recovery below.
          let attempt = 1
          let stream = yield* restore(providerStream).pipe(Effect.exit)
          while (stream._tag === "Failure" && !Cause.hasInterrupts(stream.cause)) {
            if (sawProviderEvent || attempt >= ProviderRetry.MAX_PROVIDER_ATTEMPTS) break
            const transient = Option.getOrUndefined(Cause.findErrorOption(stream.cause))
            if (!ProviderRetry.isTransientProviderFailure(transient)) break
            yield* events.publish(SessionEvent.Retried, {
              sessionID: session.id,
              timestamp: yield* DateTime.now,
              attempt,
              error: ProviderRetry.retryErrorPayload(transient),
            })
            yield* restore(
              Effect.sleep(Duration.millis(ProviderRetry.retryDelayMs(attempt, transient.retryAfterMs))),
            )
            attempt++
            sawProviderEvent = false
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
          if (llmFailure && !publisher.hasProviderError()) {
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
            yield* withPublication(publisher.failAssistant(llmFailure.reason.message))
          }
          if (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) yield* FiberSet.clear(toolFibers)
          const settled = yield* restore(awaitToolFibers(toolFibers)).pipe(Effect.exit)
          if (settled._tag === "Failure" && isQuestionRejected(settled.cause)) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
            return yield* Effect.interrupt
          }
          if (
            (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) ||
            (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
          ) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
            if (publisher.hasActiveAssistant())
              yield* withPublication(publisher.failAssistant("Provider turn interrupted"))
          }
          if (settled._tag === "Failure" && !Cause.hasInterrupts(settled.cause)) {
            const failure = Cause.squash(settled.cause)
            const message = failure instanceof Error ? failure.message : String(failure)
            yield* withPublication(publisher.failUnsettledTools(`Tool execution failed: ${message}`))
          }
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
            // 1M/A6(7) — ctx_pressure tripwire: the server-REPORTED prompt size vs the window.
            // At ≥95% the real prompt has outgrown the chars/4 estimate; the next request risks
            // silent server-side truncation. Logs actual-vs-estimate for calibration.
            const reportedPrompt =
              stepSettlement.tokens.input + stepSettlement.tokens.cache.read + stepSettlement.tokens.cache.write
            if (ContextPack.ctxPressure(reportedPrompt, packed.contextSize))
              yield* Effect.logWarning("ctx_pressure: real prompt near the context window", {
                sessionID: session.id,
                reportedPrompt,
                estimatedTokens: packed.estimatedTokens,
                contextSize: packed.contextSize,
              })
          }
          if (publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
          if (stream._tag === "Success" && !publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
          if (stream._tag === "Failure") return yield* Effect.failCause(stream.cause)
          if (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
            return yield* Effect.failCause(settled.cause)
          return { needsContinuation: !publisher.hasProviderError() && needsContinuation, step: currentStep }
        }),
      )
    }, Effect.scoped)
    type RunTurn = (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
    ) => Effect.Effect<{ readonly needsContinuation: boolean; readonly step: number }, RunError>

    const runAfterOverflowCompaction: RunTurn = Effect.fnUntraced(function* (sessionID, promotion, step) {
      return yield* runTurnAttempt(sessionID, promotion, step).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* Effect.die("Post-compaction provider attempt cannot recover another overflow")
            yield* Effect.yieldNow
            return yield* runAfterOverflowCompaction(sessionID, undefined, defect.transition.step)
          }),
        ),
      )
    })

    const runTurn: RunTurn = Effect.fnUntraced(function* (sessionID, promotion, step) {
      return yield* runTurnAttempt(sessionID, promotion, step, compaction.compactAfterOverflow).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            yield* Effect.yieldNow
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* runAfterOverflowCompaction(sessionID, undefined, defect.transition.step)
            return yield* runTurn(sessionID, undefined, defect.transition.step)
          }),
        ),
      )
    })

    const run = Effect.fn("SessionRunner.run")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly force: boolean
    }) {
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
        yield* Effect.logInfo("session under operator control — Nova is not responding", {
          sessionID: input.sessionID,
        })
        return
      }
      yield* failInterruptedTools(input.sessionID)
      // 1E: track which repeated-call loops we have already redirected this drain, so a
      // persistent loop is nudged once (not every turn). 1N/A2 adds a per-target failure-streak
      // latch + a once-per-drain runaway latch; 1N/A3 a consecutive-empty-turn counter.
      const nudged = new Set<string>()
      const nudgedTargets = new Set<string>()
      let runawayNudged = false
      let consecutiveEmpty = 0
      let regrounded = false
      const quality = Quality.initialState()
      // QE-A: quality mode with NO provisioned commands is inert — steer ONCE per session
      // to run the provisioner (deterministic manifest scan → verify → write project config).
      if (
        qualityConfig.enabled &&
        !Object.values(qualityConfig.commands).some(Boolean) &&
        !provisionNudged.has(input.sessionID)
      ) {
        provisionNudged.add(input.sessionID)
        if (provisionNudged.size > 500) provisionNudged.clear()
        yield* SessionInput.steer(db, events, input.sessionID, QualityProvision.NUDGE)
      }
      let promotion: SessionInput.Delivery | undefined = hasSteer ? "steer" : hasQueue ? "queue" : undefined
      let shouldRun = input.force || hasSteer || hasQueue
      while (shouldRun) {
        let needsContinuation = true
        let step = 1
        while (needsContinuation) {
          const result = yield* runTurn(input.sessionID, promotion, step)
          needsContinuation = result.needsContinuation
          step = result.step + 1
          promotion = "steer"
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
              yield* Effect.logInfo("doom-loop failure streak", { sessionID: input.sessionID, ...streak })
              yield* SessionInput.steer(db, events, input.sessionID, failureStreakMessage(streak))
            }
            if (!runawayNudged && detectRunaway(sinceUser.length)) {
              runawayNudged = true
              yield* Effect.logInfo("doom-loop runaway self-check", {
                sessionID: input.sessionID,
                toolCalls: sinceUser.length,
              })
              yield* SessionInput.steer(db, events, input.sessionID, runawayMessage(sinceUser.length))
            }
            // P2 (2A): cadence-gated introspection judge — an out-of-band model call that
            // asks "is this agent stuck?"; a YES steers the interjection (2B). Best-effort:
            // never allowed to fail the drain it watches.
            if (introspectionConfig.enabled && Introspection.shouldJudge(step, introspectionConfig.cadence))
              yield* introspect(input.sessionID).pipe(
                Effect.catch((cause) => Effect.logWarning("introspection judge failed", { cause })),
              )
            // QE-B steps 1–3: per touched file after a write-class tool settles (syntax +
            // incremental check), whole-module typecheck every Nth write. Best-effort — a
            // broken check command must never break the drain it guards.
            if (qualityConfig.enabled)
              for (const check of Quality.dueMidLoop(qualityConfig, quality, Quality.writeTargets(context)))
                yield* runQualityCheck(input.sessionID, check).pipe(
                  Effect.catchCause((cause) => Effect.logWarning("quality check errored", { cause })),
                )
          } else if (isEmptyAssistantTurn(context)) {
            // 1N/A3: the turn produced no text AND no tool call — typically a tool call streamed
            // into the reasoning channel and dropped by the server's parser. Inject ONE synthetic
            // re-prompt (re-armed on progress above); a SECOND consecutive empty means the re-prompt
            // isn't working, so stop and surface the server-side fix instead of looping silently.
            consecutiveEmpty++
            if (consecutiveEmpty === 1) {
              yield* Effect.logInfo("empty-turn recovery", { sessionID: input.sessionID })
              yield* SessionInput.steer(db, events, input.sessionID, EMPTY_TURN_RECOVERY)
            } else {
              yield* Effect.logWarning(EMPTY_TURN_DIAGNOSTIC, { sessionID: input.sessionID })
            }
          } else {
            consecutiveEmpty = 0
            // 2E/A7: finish re-grounding — a substantial turn ending with a clean, confident
            // summary gets ONE "walk your acceptance criteria" re-prompt. Suppressed when the
            // finish already admits an `unverified:` gap (the honesty exemption — re-prompting
            // an honest caveat has been seen to regress it into a confident "it works").
            const finalText = lastAssistantText(context)
            if (!regrounded && shouldReground(finalText, toolCallsSinceLastUser(context).length)) {
              regrounded = true
              yield* Effect.logInfo("finish re-grounding nudge", { sessionID: input.sessionID })
              yield* SessionInput.steer(db, events, input.sessionID, REGROUND_NUDGE)
            }
            // QE-B steps 4–5: the turn-end gate — test + structural pass, once per drain,
            // only when the drain actually wrote something. A failure steers; the pending
            // steer below re-arms continuation so the model fixes it before "done".
            if (qualityConfig.enabled)
              for (const check of Quality.dueTurnEnd(qualityConfig, quality))
                yield* runQualityCheck(input.sessionID, check).pipe(
                  Effect.catchCause((cause) => Effect.logWarning("quality check errored", { cause })),
                )
          }
          if (!needsContinuation) needsContinuation = yield* SessionInput.hasPending(db, input.sessionID, "steer")
        }
        shouldRun = yield* SessionInput.hasPending(db, input.sessionID, "queue")
        promotion = shouldRun ? "queue" : undefined
      }
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
    Database.node,
    AppProcess.node,
  ],
})
