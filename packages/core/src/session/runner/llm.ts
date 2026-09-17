export * as SessionRunnerLLM from "./llm"

import {
  LLM,
  LLMClient,
  LLMError,
  LLMEvent,
  Message,
  SystemPart,
  InvalidRequestReason,
  isContextOverflowFailure,
  mediaLimitFailure,
  promptTokensFrom,
  type FinishReason,
  type ProviderErrorEvent,
  isModelMissing,
} from "@novaclaw/llm"
import { Cause, Clock, DateTime, Duration, Effect, Exit, FiberSet, Layer, Option, Schema, Semaphore, Stream } from "effect"
import path from "path"
import * as OSModule from "node:os"
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
import { ModelPrefixCache } from "../../model-prefix-cache"
import { ProviderV2 } from "../../provider"
import { SystemContext } from "../../system-context/index"
import { SystemContextRegistry } from "../../system-context/registry"
import { ToolCatalogueGuidance } from "../../tool-catalogue-guidance"
import { OwnedRuntimeContext } from "../owned-runtime-context"
import { ToolDiscovery } from "../../tool-discovery"
import { OfficerPrompt } from "../../officer-prompt"
import { ReferenceGuidance } from "../../reference/guidance"
import { ToolRegistry } from "../../tool/registry"
import { ToolOutputStore } from "../../tool-output-store"
import { SessionContextEpoch } from "../context-epoch"
import { SessionCompaction } from "../compaction"
import { ContextTemplate } from "../context-template"
import { Durable } from "../durable"
import { SessionCompactionArchive } from "../compaction-archive"
import { SessionCompactionRequest } from "../compaction-request"
import { SessionEvent } from "../event"
import { SessionHistory } from "../history"
import { SessionInput } from "../input"
import { SessionMessage } from "../message"
import { SessionPatch } from "../patch"
import { SessionSchema } from "../schema"
import { OldContext } from "../old-context"
import { PromptCapture } from "../prompt-capture"
import { SessionStore } from "../store"
import { SessionTodo } from "../todo"
import { SessionComponentRegistry } from "../component-registry"
import { Log } from "@novaclaw/schema/log"
import { SessionStatusEvent } from "@novaclaw/schema/session-status-event"

import { EFFECTIVE_CONFIG_DEFAULTS, rootSessionType, stanceOf } from "../config-resolve"
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
import { Scratch } from "../../scratch"
import { PromptManager } from "./prompt-manager"
import { SessionRecall } from "./recall"
import { MemoryCorrection } from "./memory-correction"
import { WorldMemory } from "../../kb-graph/world-memory"
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
import { attachmentModality, freshImageCount, toLLMMessages, unreadableTurnAttachments } from "./to-llm-message"
import { AdhocGuidance } from "../../adhoc-tools/guidance"
import { Affective } from "./affective"
import { SessionDrive } from "./drive"
import { FinishRecovery } from "./finish-recovery"
import { UtilityCap } from "./utility-cap"
import { UtilityPass } from "./utility-pass"
import { ShortAnswer } from "./short-answer"
import { FinishAudit } from "./finish-audit"
import { PromptEstimate } from "./prompt-estimate"
import { ModelRouteProfileStore } from "./model-route-profile-store"
import { OverflowRecoveryPolicy } from "./overflow-recovery-policy"
import { Token } from "../../util/token"
import { RequestFootprint } from "./footprint"
import { ContextBudget } from "./context-budget"
import { ShortChat } from "./short-chat"
import {
  detectDoomLoop,
  redirectMessage,
  detectFailureStreak,
  failureStreakMessage,
  toolCallsSinceLastUser,
  announcedToolButCalledNone,
  isEmptyAssistantTurn,
  lastAssistantText,
  ANNOUNCED_TOOL_RECOVERY,
  EMPTY_TURN_RECOVERY,
  EMPTY_TURN_RECOVERY_CHAT,
  EMPTY_TURN_DIAGNOSTIC,
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
import { UnfinishedShells } from "./unfinished-shells"
import { BashJobs } from "../../tool/bash-jobs"
import { SessionTitle } from "../title"
import { SessionMapRetention } from "./session-map-retention"
import { SessionDriveState } from "./drive-state"
import { RecoveryJoin } from "./recovery-join"
import { CompactionBackoff } from "./compaction-backoff"
import { applySteerProvenance, lastRealUserIndex, lastRealUserText } from "../steer-provenance"
import { VisionCopy } from "./vision-copy"
import { ToolOutputSummary } from "./tool-output-summary"
import { Nudge } from "../../nudge"
import { NudgeService } from "../../nudge-service"
import { ResourcePressureContext } from "../../resource-pressure-context"
import { Shell } from "../../shell"

// Ordering can only choose among retrieved candidates — fetch wider than the recall budget.

/** The one prompt source in the context epoch. One key, because there is one system message. */
const PROMPT_CONTEXT_KEY = SystemContext.Key.make("core/prompt")

/** The instance owner's username, from the OS. */
const instanceOwner = (): string => {
  try {
    const name = OSModule.userInfo().username
    if (name.trim().length > 0) return name
  } catch {
    // A sandbox with no passwd entry — fall through to the environment.
  }
  return process.env.USERNAME ?? process.env.USER ?? "owner"
}

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
 *
 * ⚠️ It is now the OUTER bound only. The pass enters through the scheduler's interactive-idle tier, so
 * a contended device preempts it long before four seconds; what this catches is a device that is
 * neither preempted nor responsive.
 */
const RERANK_DEADLINE = "4 seconds"
/** The answer is a permutation of at most a dozen small integers. Generous, and thinking is off. */
const RERANK_ANSWER_TOKENS = 128

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
  readonly memoryOwner: AgentV2.Selection
  readonly memory: MemoryClient.Interface
  readonly session: { readonly id: SessionSchema.ID; readonly title?: string | undefined }
}) {
  const agentID = input.memoryOwner.id
  if (!agentID) return
  if (
    !SessionCompactionArchive.shouldArchive({
      memory: input.memoryOwner.info?.memory,
      archiveChats: input.memoryOwner.info?.archiveChats,
    })
  )
    return
  const passages = SessionCompactionArchive.plan({
    messages: input.entries.map((entry) => entry.message),
    title: input.session.title,
    at: new Date(),
  })
  if (passages.length === 0) return
  // ONE batched request for the whole archive, not one round trip per passage.
  //
  // 🔴 This loop called the SINGLE-item API inside a `for`, so an eight-passage compaction issued
  // eight sequential requests — each carrying the bulk fifteen-second bound — while the user's turn
  // waited on it. The module already batches 32 texts per request; the loop was the only thing
  // keeping that from being used. A wedged device therefore cost 8 × 15 s inline instead of 1 × 15 s,
  // and it sat on the path a compaction already makes expensive.
  //
  // ⚠️ The coarser degradation is taken knowingly: `embed` returns undefined when any batch fails, so
  // one bad batch now costs the whole archive its vectors rather than one passage's. That is the
  // correct trade precisely because the failure is device-wide — if a batch failed, the device is
  // down, and a per-passage retry would pay the full timeout once per passage to recover nothing.
  // The archive lands FTS-only and recall still reaches it by keyword; nothing is lost but the vector
  // leg of a run that could not have had one.
  const vectors = yield* Effect.promise(() => KbEmbedder.embed(passages.map((passage) => passage.text)))
  for (const [index, passage] of passages.entries()) {
    // Embedded on write so the vector leg can reach it later; degrades to FTS-only when no device is
    // configured, exactly as `kb ingest` does.
    const embedding = vectors?.[index]
    yield* input.memory
      .addMemory({
        id: passage.id,
        kind: "passage",
        text: passage.text,
        name: passage.label,
        // The colleague's OWN cabinet — not `global`. An archived conversation is the most personal
        // thing a colleague holds, and putting it in the household scope would hand every other
        // agent a transcript of work they were not part of.
        scope: SessionRecall.rememberScope({ sessionID: input.session.id, agentID }),
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
 * ⭐ **THE HEAD THE PACKER CUT LANDS SOMEWHERE THE AGENT CAN STILL REACH — or we do not claim it did.**
 *
 * `invariants.md` (Context Management 2) is one sentence with two halves: deterministic compaction
 * "stores the cut text in the agent's scratch, so that agent can still grep it", and prefixes the
 * result with a tombstone naming that file. A count of dropped messages satisfies neither, and the
 * packer used to return only a count.
 *
 * ⚠️ **This is a function because the two halves must not be able to disagree.** Ordering them wrongly
 * produces a request that promises a file which was never written — the same class of defect as a
 * message asserting a cause the code never established (ruling 2), and the one clause 1's save path was
 * built to avoid. So the sequence is fixed here, once, for every dispatch site that can drop:
 *
 *   1. reserve a name for the file BEFORE packing (the packer must measure the tombstone it may
 *      emit — a line added after the measurement is an unmeasured line, see
 *      `packRequest.droppedContextFile`);
 *   2. pack;
 *   3. if nothing left, the reserved tombstone was never emitted and there is nothing to write;
 *   4. if something left, write it, then dispatch the request that already names the file;
 *   5. if the write FAILED, re-prepare WITHOUT the file. A tombstone over a missing file is a lie the
 *      agent can act on — it greps a path and finds nothing — so the request that goes out names no
 *      file at all. Re-packing is safe in exactly one direction and that is the direction that matters:
 *      the tombstone was reserved, so removing it only frees room and the second pack still fits.
 *
 * ⚠️ A failed write never fails the turn. The dropped text is a second copy of bytes we still hold, and
 * dying here would trade a working session for a missing convenience file. It is logged, loudly.
 */
const prepareDispatch = Effect.fnUntraced(function* (input: {
  readonly prepare: ProviderDispatch.PrepareInput
  readonly scratchFolder: string | undefined
  readonly sessionID: SessionSchema.ID
  readonly hard?: boolean
}) {
  // One argument list, so the ordinary pack and the HARD re-pack cannot measure against different
  // windows (ruling 6, in miniature). `droppedContextFile` is deliberately NOT taken from the caller:
  // the file must be the one this function writes, and only this function knows it.
  const base = input.hard === true ? { ...input.prepare, hard: true } : input.prepare
  if (input.scratchFolder === undefined) return ProviderDispatch.prepare(base)
  const scratchFolder = input.scratchFolder
  const at = DateTime.toDate(yield* DateTime.now)
  const file = OldContext.file({ scratchFolder, at })
  const dispatch = ProviderDispatch.prepare({ ...base, droppedContextFile: file })
  if (dispatch.packed.droppedMessages.length === 0) return dispatch
  const text = OldContext.render(dispatch.packed.droppedMessages)
  const saved = yield* Effect.tryPromise({
    // `save` recomputes the path from the SAME `at` the request was packed against, so the file
    // written is the file named by construction rather than by two call sites agreeing.
    try: async () => {
      const saved = await OldContext.save({ scratchFolder, at, text })
      // The JSON work-log sibling, named by the prompt template. Best-effort: the `.txt` was already
      // promised by the tombstone, and a second convenience file must not lose it.
      await OldContext.saveWorkLog({ scratchFolder, at, text }).catch(() => undefined)
      return saved
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.tap((file) =>
      Log.event("session.context.dropped.saved", {
        "session.id": String(input.sessionID),
        "context.dropped.file": file,
        "context.dropped.messages": dispatch.packed.droppedMessages.length,
        "context.dropped.chars": text.length,
      }),
    ),
    Effect.catch((cause) =>
      Log.event("session.context.dropped.unsaved", {
        "session.id": String(input.sessionID),
        "context.dropped.messages": dispatch.packed.droppedMessages.length,
        "context.dropped.chars": text.length,
        "context.dropped.error": Log.fault(cause),
      }).pipe(Effect.as(undefined)),
    ),
  )
  if (saved !== undefined) return dispatch
  return ProviderDispatch.prepare(base)
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
    const routeProfiles = yield* ModelRouteProfileStore.Service
    const store = yield* SessionStore.Service
    // Where the six drive maps below really live — see `drive-state.ts`. In the host it is an
    // in-memory store with the scheduler's forgiveness window; in a worker it is an RPC client to
    // that same store, which is what makes "session-scoped" true across drains.
    const driveState = yield* SessionDriveState.Service
    // THE config entry point (`session/effective-config.ts`). Every reader in this runner resolves
    // through it, which is what lets a folder's tune reach the turn at all.
    const effective = yield* SessionEffectiveConfig.Service
    const location = yield* Location.Service
    // The SystemContext registry is no longer composed into the prompt (the one prompt renders its
    // own environment), but its LOAD is still awaited as the pre-provider interruptibility and
    // health-observation checkpoint — the MCP/capability health lines are produced by that load, and
    // a turn must be able to take an interrupt during startup work rather than only after prefill.
    const systemContext = yield* SystemContextRegistry.Service
    const config = yield* Config.Service
    const snapshots = yield* Snapshot.Service
    // Strict's half of the ONE host-execution gate (ruling 6): the chain-root type comes from
    // `store`, the messenger trust of the turn from here, and the OFF-C egress overlay from the
    // SHARED offline service (never a second policy load — it would drift from the HttpClient's).
    const messengerStore = yield* MessengerStore.Service
    const offline = yield* Offline.Service
    const scheduler = yield* SessionScheduler.Service
    const compactionRequests = yield* SessionCompactionRequest.Service
    // Recall, stale-read correction, and compaction archives use the instance's sole RAG graph.
    const memory = WorldMemory.client(yield* WorldMemory.node.service)
    const maintenance = yield* SessionMaintenance.Service
    const components = yield* SessionComponentRegistry.Service
    const nudges = yield* NudgeService.Service
    const resourcePressure = yield* ResourcePressureContext.Service
    const db = (yield* Database.Service).db
    const deliverNudges = Effect.fn("SessionRunner.deliverNudges")(function* (
      sessionID: SessionSchema.ID,
      agentID: string | undefined,
      event: Nudge.Event,
      enabled = true,
    ) {
      if (!enabled) return 0
      const claimed = yield* nudges.claim({
        sessionID,
        ...(agentID === undefined ? {} : { agentID }),
        directory: location.directory,
        event,
      })
      for (const nudge of claimed) yield* SessionInput.steer(db, events, sessionID, Nudge.prompt(nudge, event))
      return claimed.length
    })
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
        shell: Shell.agentDefault(),
      })
      // Built off `derived.entries`, i.e. the SAME read — a second `config.entries()` inside one
      // turn could hand the compactor a different snapshot than the system prompt was composed from.
      return {
        ...derived,
        compaction: SessionCompaction.make({
          events,
          llm,
          scheduler,
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
       * The DURABLE record of this run — verified autonomy's only new write.
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

    const TOOL_SUMMARY_SYSTEM =
      "You summarize tool output faithfully and briefly. Reply with the summary only — no preamble, no commentary."
    /** Reasoning ceiling: the titler's number, and the pairing below is the titler's pairing. */
    const TOOL_SUMMARY_REASONING_BUDGET = 128
    /** Answer ceiling floor, kept well above the hard stop's measured landing point (~126 tokens). */
    const TOOL_SUMMARY_ANSWER_TOKENS = 512
    /**
     * One bounded utility call for the map/reduce tool-output summarizer.
     *
     * The tool call's device slot has already been released before settlement begins, so this work
     * never holds the interactive generation admission. It is still DECODE-shaped and still spends
     * the same device bus, so it enters through the scheduler's maintenance tier rather than beside
     * it. The caller applies one wall-clock deadline to the WHOLE finite map/reduce chain rather
     * than multiplying that deadline by the number of chunks.
     *
     * 🔴 **Through `ShortAnswer.generate`, and the token cap is NOT how brevity is obtained here.**
     * This used to be a bare `LLM.request` with `generation.maxTokens = input.maxTokens` (as low as
     * 128 for a segment) plus the `NO_THINKING` overlay and nothing else — no `UtilityCap` ladder,
     * no `ReasoningBudget`, one attempt. `enable_thinking:false` is a REQUEST and a growing class of
     * models ignores it; such a model spends the whole cap inside `<think>` and returns NOTHING in
     * either channel, because the reasoning parser only emits on the closing tag. `summarize` fails
     * OPEN on an empty completion, so the whole semantic map/reduce was then permanently inert on
     * that model — after spending up to `MAX_COMPLETION_CALLS` decode-shaped calls to produce
     * nothing, with no log to say so. `ReasoningBudget` (inside `ShortAnswer`) is the mechanical
     * half: it counts reasoning deltas live and its hard stop re-issues the turn with thinking
     * structurally disabled.
     *
     * ⚠️ **The caller's `maxTokens` is a BYTE budget, and it is enforced downstream, not here.**
     * `ToolOutputSummary.fitCompletion` trims an over-long summary to `maxBytes` (and re-asks once
     * while the request still fits the window), so the request only needs an answer ceiling that
     * clears `ReasoningBudget`'s hard stop — the titler's proven 512 against a 128 reasoning budget.
     * Passing the byte budget straight through as `max_tokens` would put the ceiling AT the hard
     * stop's landing point, which is the empty-completion trap wearing a smaller number.
     */
    const completeToolOutputSummary = Effect.fn("SessionRunner.toolOutputSummary")(function* (
      model: Parameters<typeof LLM.request>[0]["model"],
      guard: SessionRunnerModel.DispatchGuard,
      sessionID: SessionSchema.ID,
      device: SessionRunnerModel.ScheduledDevice,
      input: ToolOutputSummary.CompletionInput,
    ) {
      const text = yield* ShortAnswer.generate({
        model,
        guard,
        llm,
        system: TOOL_SUMMARY_SYSTEM,
        text: input.prompt,
        reasoningBudget: TOOL_SUMMARY_REASONING_BUDGET,
        maxTokens: Math.max(input.maxTokens, TOOL_SUMMARY_ANSWER_TOKENS),
        scheduler,
        maintenance: {
          ownerID: sessionID,
          task: "tool-output-summary",
          deviceKey: device.key,
          ...(device.concurrency === undefined ? {} : { concurrency: device.concurrency }),
          ...(device.locality === undefined ? {} : { locality: device.locality }),
        },
      })
      // An EMPTY completion is a broken call, not "nothing to summarize" — `summarize` fails open on
      // it, so without this line the pass can be dead for the life of a process and read as healthy.
      // Named after `session.memory.extract.giveup`, which exists for exactly this confusion.
      if (text.trim() === "")
        yield* Log.event("session.tool.summary.empty", {
          "session.id": sessionID,
          "session.summary.cap": input.maxTokens,
        })
      return { text }
    })

    const summarizeToolSettlement = Effect.fn("SessionRunner.summarizeToolSettlement")(function* (
      settlement: ToolRegistry.Settlement,
      model: Parameters<typeof LLM.request>[0]["model"],
      guard: SessionRunnerModel.DispatchGuard,
      sessionID: SessionSchema.ID,
      device: SessionRunnerModel.ScheduledDevice,
    ) {
      if (settlement.semanticSummarySource === undefined || settlement.output === undefined) return settlement
      const replacement = yield* ToolOutputSummary.summarize({
        source: settlement.semanticSummarySource,
        boundedOutput: settlement.output,
        contextTokens: model.route.defaults.limits?.context ?? 0,
        complete: (input) => completeToolOutputSummary(model, guard, sessionID, device, input),
      }).pipe(
        Effect.catchTags({
          "LLM.Error": () => Effect.succeed(undefined),
          "SessionRunnerModel.ModelUnavailableError": () => Effect.succeed(undefined),
        }),
        Effect.timeoutOrElse({
          duration: CalloutPolicy.summarizer.timeoutMs,
          orElse: () => Effect.succeed(undefined),
        }),
      )
      return replacement === undefined ? settlement : { ...settlement, ...replacement }
    })

    const auditExit = Effect.fn("SessionRunner.auditExit")(function* (
      sessionID: SessionSchema.ID,
      model: Parameters<typeof LLM.request>[0]["model"],
      guard: SessionRunnerModel.DispatchGuard,
      slot: SessionScheduler.AdmitInput,
      context: readonly SessionMessage.Message[],
      request: FinishAudit.ExitRequest,
    ) {
      const evidence = FinishAudit.excerpt(context, request)
      if (evidence === undefined) return "unknown" as const
      const judge = (reasoningBudget: number) =>
        ShortAnswer.generateOnSessionLane({
          model,
          guard,
          llm,
          system: FinishAudit.SYSTEM,
          text: FinishAudit.prompt(evidence),
          reasoningBudget,
          maxTokens: 512,
          scheduler,
          slot,
        })
      const reply = yield* judge(128)
      const verdict = FinishAudit.verdict(reply)
      if (verdict !== "unknown") return verdict
      // An unusable reply is NOT a "no", and it must not be silent either. Measured in the packaged
      // app's own logs (2026-09-11..14): 35 of 46 exit-request audits logged yes:false AND no:false —
      // 76%, and concentrated in long-lived goal sessions (Nova 20 of 26, Geryon 8 of 8, while
      // Daedalus and Sopitis parsed every time). Each such audit published no ExitAccepted and sent
      // no steer, leaving the officer waiting on a reviewer that never answered.
      //
      // The cause is a reply that is empty or unparsed: a thinking model can spend the whole 128-token
      // budget inside its <think> block and then emit nothing in either channel, which short-answer.ts
      // documents in its own comments. ONE retry with thinking structurally disabled is bounded, and it
      // cannot race ReasoningBudget's recovery -- that recovery has already finished by this point,
      // which is why this is a second phase rather than a second loop.
      yield* Log.event("session.finish.audit.unusable", {
        "session.id": sessionID,
        "session.finish.audit.reason": FinishAudit.reason(reply),
      })
      const retry = yield* judge(0)
      const retried = FinishAudit.verdict(retry)
      if (retried !== "unknown") return retried
      yield* Log.event("session.finish.audit.unusable", {
        "session.id": sessionID,
        "session.finish.audit.reason": `retry:${FinishAudit.reason(retry)}`,
      })
      return "unknown" as const
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
     * capability store is unlanded work; guessing a default for a stranger's endpoint is not.
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
    // 🔴 **THE MAPS BELOW ARE A PER-DRAIN CACHE, NOT THE STATE.** Each comment says "session-
    // scoped, this process", and each was true for the in-process executor and false under the
    // worker one, where this layer is built inside ONE drain and disposed in `finally`: every steer
    // started a new worker with six empty maps, so the barren-round stop could never reach its
    // bound, the coverage restarted at the first file, and the restart ceiling never counted. The
    // state now lives in `SessionDriveState` (the host's store, reached by RPC from a worker):
    // `hydrateDriveState` fills these maps when a run starts and `flushDriveState` writes them back
    // on every mutation. The maps stay so the drives read them the way they always did.
    const setRequests = new Map<
      string,
      {
        readonly asked: boolean
        readonly limit?: number
        /**
         * 🔴 Latched for the same reason `limit` is, and it matters MORE here. A delegated child's
         * assignment lives only in the spawn prompt that created it; once compaction takes that
         * message, re-deriving the names returns nothing and the child's set silently widens back to
         * its parent's whole corpus. See `UnfinishedSet.scopeAvailable`.
         */
        readonly named?: ReadonlyArray<string>
      }
    >()
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
     * Every corpus path the session has ATTEMPTED to read, successful or not — per session.
     *
     * 🔴 **Separate from `setOpened` because the two answer different questions**, and conflating
     * them was a defect in both directions. `setOpened` is *what is DONE*: it decides what the steer
     * may not name, so a read that ERRORED must not be in it — the model demonstrably could not see
     * that file, and counting it made the drive agree that undone work was finished. This map is
     * *WHERE the set lives*: it feeds `setDirectory`, and a failed read is perfectly good evidence of
     * which folder the model is working in.
     *
     * ⚠️ Narrowing the single shared list would have re-opened the bug report §11 closed. A turn
     * whose reads all failed would derive an empty set, `setDirectory` would return `undefined`, and
     * the drive would fall back to `location.directory` — enumerating the session root, which is how
     * `set.available: 2` was reported for 40-, 100- and 400-file corpora alike.
     */
    const setAttempted = new Map<string, Set<string>>()
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
     * Every CHILD this session has joined in the CURRENT real-user task — the ids it called `wait`
     * on and got an answer for.
     *
     * 🔴 Session-scoped for the reason the three maps above it are, and it is not a style choice: a
     * `wait` call sits in the transcript window, compaction rewrites that window, and a drain-local
     * set would therefore forget joins the session really made and steer the parent to re-join
     * children it already read. The measured version of this trap cost the set drive three separate
     * corrections (`setRequests`, `setOpened`, `setBarrenBySession` all carry the same note).
     *
     * ⚠️ Accumulate-only WITHIN ONE TASK, exactly like `setOpened`: a join is something the session
     * has done and no later read of a shrunken window may take it back. A new real user message resets
     * it alongside `childrenSpawned`; otherwise a durable colleague chat would inherit old work.
     */
    const childrenJoined = new Map<string, Set<string>>()
    /**
     * Children spawned for the CURRENT real-user task, never every child this durable chat has ever
     * owned. The task id resets the set when a new user message arrives; the set itself survives
     * harness steers and compaction drains through `SessionDriveState`.
     */
    const childrenSpawned = new Map<string, Set<string>>()
    const childrenTask = new Map<string, string>()
    // Provider-native schemas sit before the system prompt on every supported protocol. Freeze the
    // exact array at this session's first request; live capability changes belong in deferred
    // tool-search results at the transcript tail, never in this prefix.
    const residentToolPrefix = new Map<string, import("@novaclaw/llm").ToolDefinition[]>()
    const deferredToolCatalogue = new Map<string, ReadonlySet<string>>()
    const residentToolCatalogue = new Map<string, ReadonlySet<string>>()
    const promptPrefixEpoch = new Map<string, number>()
    /**
     * How many times this session has been steered back to its unaccounted children. Bounded by
     * `UnjoinedChildren.MAX_RESTART_ROUNDS` — a restart can itself spawn a child that fails, so this
     * drive needs a ceiling for the same reason the set drive does, and session-scoped for the same
     * reason: every steer admits a prompt and starts a new drain, so a drain-local counter resets
     * before it can ever reach its bound.
     */
    const childRestartRounds = new Map<string, number>()
    const compactionRetryAt = new Map<string, number>()
    const sessionMapRetention = SessionMapRetention.make([
      setRequests,
      setOpened,
      setAttempted,
      setBarrenBySession,
      childrenJoined,
      childrenSpawned,
      childrenTask,
      childRestartRounds,
      compactionRetryAt,
    ])
    /** Fill the controller caches for one session from the store, at the start of a run. */
    const hydrateDriveState = (sessionID: string) =>
      driveState.load(sessionID).pipe(
        Effect.map((snapshot) => {
          if (snapshot.request) setRequests.set(sessionID, snapshot.request)
          else setRequests.delete(sessionID)
          setOpened.set(sessionID, new Set(snapshot.opened))
          setAttempted.set(sessionID, new Set(snapshot.attempted))
          if (snapshot.barren) setBarrenBySession.set(sessionID, { ...snapshot.barren })
          else setBarrenBySession.delete(sessionID)
          childrenJoined.set(sessionID, new Set(snapshot.joined))
          childrenSpawned.set(sessionID, new Set(snapshot.spawned))
          if (snapshot.childTask !== undefined) childrenTask.set(sessionID, snapshot.childTask)
          else childrenTask.delete(sessionID)
          childRestartRounds.set(sessionID, snapshot.restartRounds)
          if (snapshot.compactionRetryAt !== undefined) compactionRetryAt.set(sessionID, snapshot.compactionRetryAt)
          else compactionRetryAt.delete(sessionID)
        }),
      )
    /** Write the controller caches for one session back to the store. Called after every mutation. */
    const flushDriveState = (sessionID: string) => {
      const request = setRequests.get(sessionID)
      const barren = setBarrenBySession.get(sessionID)
      return driveState.save(sessionID, {
        ...(request === undefined ? {} : { request }),
        opened: [...(setOpened.get(sessionID) ?? [])],
        attempted: [...(setAttempted.get(sessionID) ?? [])],
        ...(barren === undefined ? {} : { barren: { ...barren } }),
        joined: [...(childrenJoined.get(sessionID) ?? [])],
        ...(childrenTask.get(sessionID) === undefined ? {} : { childTask: childrenTask.get(sessionID)! }),
        spawned: [...(childrenSpawned.get(sessionID) ?? [])],
        restartRounds: childRestartRounds.get(sessionID) ?? 0,
        ...(compactionRetryAt.get(sessionID) === undefined
          ? {}
          : { compactionRetryAt: compactionRetryAt.get(sessionID)! }),
      })
    }
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
      | {
          readonly _tag: "ContinueAfterOverflowCompaction"
          readonly step: number
          readonly recovery: OverflowRecovery
        }
      // The endpoint named its image cap; re-lower this same turn under it. Distinct from the
      // overflow arm because the recovery differs: compaction summarises TEXT and removes no image.
      | { readonly _tag: "RetryUnderImageBudget"; readonly step: number }
      | { readonly _tag: "RetryOnReplacedModel"; readonly step: number }

    class TurnTransitionError extends Error {
      constructor(readonly transition: TurnTransition) {
        super()
      }
    }

    const continueAfterCompaction = (step: number) => new TurnTransitionError({ _tag: "ContinueAfterCompaction", step })
    const retryUnderImageBudget = (step: number) => new TurnTransitionError({ _tag: "RetryUnderImageBudget", step })
    /** The model this turn asked for is not served; the row now names another one. Re-run so the
     *  user gets an answer instead of a fault they have to act on. */
    const retryOnReplacedModel = (step: number) => new TurnTransitionError({ _tag: "RetryOnReplacedModel", step })
    type OverflowRecovery = {
      readonly plan: OverflowRecoveryPolicy.Compress
      readonly failure: ProviderErrorEvent
      readonly failedRoute: OverflowRecoveryPolicy.CalibrationRoute
    }

    const overflowProviderError = (failure: unknown): ProviderErrorEvent | undefined => {
      if (failure !== undefined && LLMEvent.is.providerError(failure)) return failure
      if (!(failure instanceof LLMError) || failure.reason._tag !== "InvalidRequest") return undefined
      return LLMEvent.providerError({
        message: failure.reason.message,
        ...(failure.reason.classification === undefined ? {} : { classification: failure.reason.classification }),
        retryable: false,
        ...(failure.reason.providerMetadata === undefined ? {} : { providerMetadata: failure.reason.providerMetadata }),
      })
    }

    const continueAfterOverflowCompaction = (step: number, recovery: OverflowRecovery) =>
      new TurnTransitionError({ _tag: "ContinueAfterOverflowCompaction", step, recovery })

    /**
     * THE PROMPT, as the ONE epoch source.
     *
     * 🔴 Owner, 2026-09-17: one monolithic `role: "system"` message, regenerated only at a new session
     * and after a compaction. That cadence is the EPOCH's, not a new mechanism: `initialize` renders
     * the baseline once, a casual turn reconciles to `Unchanged` (the comparator below is always
     * equivalent), and a compaction whose sequence advanced forces `replace` — regenerating the
     * prompt. So this function is the single source of authority for what every model reads, and
     * `PromptManager.generate` is the single thing that decides its text.
     *
     * ⚠️ The prompt is ONE source rather than a `combine([])`: an empty render throws
     * (`SystemContext.requireText`), so the "no system prompt at all" case — a pure Chat with empty
     * job instructions — returns `SystemContext.empty`, which renders to the empty baseline the
     * runner then drops.
     */
    const loadPromptContext = (
      session: {
        readonly id: SessionSchema.ID
        readonly parentID?: SessionSchema.ID | undefined
        readonly agent?: AgentV2.ID | undefined
        readonly location?: { readonly directory: string } | undefined
      },
      agent: AgentV2.Selection,
      shortChat: boolean,
      sessionType: string | undefined,
      workerProfile: { readonly system?: string | undefined } | undefined,
    ) =>
      Effect.gen(function* () {
        const prototype = workerProfile
        // Interruptible, pre-provider, and the one place the instance's ambient health is observed.
        // Its TEXT is deliberately not composed — `PromptManager` renders the environment itself — so
        // it is OBSERVED and discarded: `initialize` is what actually runs each source's load (the
        // registry's `load` only builds the context), which is the work a user is waiting through
        // when they press stop. A blocked observation is not fatal here: the prompt does not depend
        // on it, and a corrupt ambient source must not cost the turn.
        yield* SystemContext.initialize(yield* systemContext.load()).pipe(Effect.orElseSucceed(() => undefined))
        // The three roster kinds (owner, 2026-09-17). `human` is the instance's owning user: it is a
        // first-class roster entity that never runs a model turn, so its prompt is empty and it stays
        // tool-free through the same derived `shortChat` posture as a pure Chat. The resolved
        // `shortChat` still counts: a chat may be opened in the Chat posture from the session row even
        // when the colleague's own kind is `agent`.
        const declared = AgentV2.kindOf(agent.info)
        const kind: PromptManager.Kind = declared === "human" ? "human" : shortChat ? "chat" : "agent"
        const roster = yield* agents.all()
        const scratch = agent.id ? Scratch.forAgent(String(agent.id)) : undefined
        const parentAgent = session.parentID
          ? yield* effective.resolve(session.parentID).pipe(
              Effect.flatMap((parent) => agents.select(parent.agent as typeof session.agent)),
              Effect.orElseSucceed(() => undefined),
            )
          : undefined
        const configuredSuperior = AgentV2.resolveSuperior(String(agent.id), agent.info?.superior, roster)
        const superiorName =
          parentAgent !== undefined
            ? (parentAgent.info?.name ?? String(parentAgent.id))
            : // Nova reports to the owner, and `PromptManager` renders an absent superior as the owner.
              // Every other officer falls back to Nova, the immutable root of the org chart.
              (configuredSuperior?.name ?? (String(agent.id) === AgentV2.NOVA_ID ? undefined : "Nova"))
        const role = parentAgent === undefined ? "agent" : "worker"
        const subordinates =
          role === "agent"
            ? roster
                .filter(
                  (candidate) =>
                    AgentV2.resolveSuperior(String(candidate.id), candidate.superior, roster)?.id === agent.id,
                )
                .map((candidate) => candidate.name ?? String(candidate.id))
            : []
        const jobInstructions =
          prototype?.system ??
          agent.info?.system ??
          (kind !== "agent" || shortChat || agent.info === undefined
            ? undefined
            : OfficerPrompt.DEFAULT_OFFICER_PROMPT)
        const goalEntry = yield* components.get({ sessionID: session.id, kind: "goal" }).pipe(
          Effect.map((entry) => entry?.value),
          Effect.orElseSucceed(() => undefined),
        )
        const unattended = SessionDrive.unattendedMode({
          operationMode: agent.info?.operationMode,
          sessionType,
        })
        const memoRows = yield* components.list({ sessionID: session.id, kind: "durable" }).pipe(
          Effect.orElseSucceed((): readonly { readonly value: unknown }[] => []),
        )
        const memos = [...Durable.itemsOf(memoRows)].sort((left, right) =>
          left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
        )
        const directory = session.location?.directory
        const listing =
          directory === undefined || directory.trim().length === 0
            ? undefined
            : yield* Effect.promise(() => ProjectGrounding.readListing(directory, 256))
        const workLog =
          scratch === undefined ? undefined : yield* Effect.promise(() => OldContext.latestWorkLog(scratch))
        const platform = Shell.agentPlatform()
        const text = PromptManager.generate({
          kind,
          name: agent.info?.name,
          title: agent.info?.title,
          superior: superiorName,
          subordinates,
          jobInstructions,
          // What the agent's OWN shell reports from `uname`, so the prompt and the shell cannot
          // disagree about the box (see `Shell.agentPlatform`).
          os: platform.os,
          kernelRelease: platform.kernelRelease,
          arch: platform.arch,
          shell: Shell.agentDefault(),
          owner: instanceOwner(),
          scratch,
          goal: SessionDrive.assignedGoal({
            officerGoal: agent.info?.goal,
            component: goalEntry,
          }),
          unattended,
          memos: memos.map((memo) => ({ name: memo.name, value: memo.value })),
          project: directory,
          projectFiles: listing?.entries.map((entry) => (entry.directory ? `${entry.name}/` : entry.name)),
          workLog,
        })
        if (text.length === 0) return SystemContext.empty
        return SystemContext.make({
          key: PROMPT_CONTEXT_KEY,
          codec: Schema.toCodecJson(Schema.Struct({ text: Schema.String })),
          load: Effect.succeed({ text }),
          // The comparator is ALWAYS equivalent on purpose: the prompt must not be regenerated by a
          // casual turn, and the only two events that may replace it are handled by the epoch itself
          // (`SessionContextEpoch.initialize` on a new session, `replace` when a compaction advanced
          // the baseline sequence).
          baseline: (value) => value.text,
          update: (value) => value.text,
          equivalent: () => true,
        })
      })

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
        readonly recoveryWait?: SessionRunnerModel.ResolveOptions["recoveryWait"]
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
      const resolution = yield* tap(effective.resolution(session.id))
      const config = resolution.config
      const agent = yield* tap(agents.select(config.agent as typeof session.agent))
      const memoryOwner =
        resolution.memoryOwnerAgent === undefined || resolution.memoryOwnerAgent === agent.id
          ? agent
          : yield* tap(agents.select(resolution.memoryOwnerAgent as typeof session.agent))
      // ONE prompt source, resolved lazily by the epoch: `initialize` renders it for a new session,
      // `replace` re-renders it when a compaction advanced the baseline, and a casual turn reconciles
      // it to `Unchanged` without touching the stored bytes. The comparator lives in
      // `loadPromptContext`; the cadence is owner-fixed at "new session + compaction only".
      const promptContext = loadPromptContext(
        session,
        agent,
        ShortChat.enabled(config.shortChat),
        config.type,
        resolution.workerProfile,
      )
      const initialized = yield* SessionContextEpoch.initialize(db, promptContext, session.id)
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
            promptContext,
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
      // Resolve both sides of a split mind up front. The ordinary model owns answer/tool generation;
      // the optional reasoning model gets a separate harness-opened private phase. Each provider
      // request still has exactly one model/KV cache — the harness owns the boundary between them.
      const reasoningTurn =
        config.reasoningModel !== undefined &&
        config.reasoningBudget !== 0 &&
        stanceOf("thinkingBudget", config.thinkingBudget) &&
        !ShortChat.enabled(config.shortChat)
      const modelSession = {
        ...session,
        model: config.model as typeof session.model,
        device: config.device,
      }
      // ⚠️ `requested` is read from the RAW ROW, not from the overlay. `modelSession.model` is the
      // chain-resolved answer, which includes the colleague's own configuration — so asking it "did
      // the user name this?" always says yes. The row is where an explicit `--model`, a switch or a
      // per-turn override actually lands.
      // Resolve the provider route and scheduler identity in ONE decision. A Device pin is allowed
      // to select another real catalog placement of the same model, so resolving these separately
      // could dispatch one endpoint while charging another endpoint's capacity ledger.
      const resolvedModel = yield* tap(
        models.resolveWithDevice(modelSession, {
          requested: session.model !== undefined,
          taxonomy: resolution.workerProfile?.needsTaxonomy ?? agent.info?.needsTaxonomy,
          // An empty requirement still marks this as an automatic interactive pick. Tool support is
          // a one-way need: a tool-capable model is also perfectly valid for a tool-free short chat.
          requiredCapabilities: ShortChat.enabled(config.shortChat) ? {} : { tools: true },
          recoveryWait: options.recoveryWait,
        }),
      )
      const model = resolvedModel.model
      const resolvedReasoning = reasoningTurn
        ? yield* models.resolveWithDevice(
            { ...modelSession, model: config.reasoningModel as typeof session.model },
            { requested: false, recoveryWait: options.recoveryWait },
          )
        : undefined
      const distinctReasoning =
        resolvedReasoning !== undefined &&
        `${resolvedReasoning.model.provider}/${resolvedReasoning.model.id}` !== `${model.provider}/${model.id}`
          ? resolvedReasoning
          : undefined
      const entries = yield* SessionHistory.entriesForRunner(db, session.id, system.baselineSeq, system.compaction)
      return {
        session,
        config,
        memoryOwnerAgent: resolution.memoryOwnerAgent,
        memoryOwner,
        workerProfile: resolution.workerProfile,
        agent,
        system,
        modelSession,
        model,
        reasoningModel: distinctReasoning?.model,
        reasoningRan: distinctReasoning?.ran,
        reasoningScheduledDevice: distinctReasoning?.device,
        // 🔴 The catalog entry the route above was built from — the model that ACTUALLY RUNS this
        // turn, after `resolve`'s unavailable- and unhealthy-model fallbacks. Carried so the turn's
        // model FACTS are read off it (`SessionRunnerModel.perTurnFacts`) instead of from a second
        // resolution that applies neither fallback. `undefined` only behind a test/embedding seam,
        // which resolves a route with no catalog behind it at all.
        ran: resolvedModel.ran,
        // WHY the turn left the assigned model, when it did. `undefined` on an ordinary turn, and
        // `undefined` behind a seam. `runner/llm.ts` turns this into a visible notice.
        substituted: resolvedModel.substituted,
        scheduledDevice: resolvedModel.device,
        entries,
        promoted,
      }
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
      overflowRecovery?: OverflowRecovery,
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
            error instanceof SessionRunnerModel.ModelInputUnsupportedError ||
            error instanceof SessionRunnerModel.ImageBatchTooLargeError ||
            error instanceof SessionRunnerModel.DevicePinError
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
            ...(error instanceof SessionRunnerModel.DevicePinError
              ? { repair: { type: "unpin-device" as const, device: error.deviceID } }
              : {}),
          })
        }).pipe(Effect.ignore)
      const prepared = yield* prepareTurn(sessionID, {
        promotion,
        onFailure: surfacePreTurnFailure,
        recoveryWait: {
          started: () => timingStart("model-recovery"),
          ended: () => timingEnd("model-recovery"),
        },
      })
      // The session moved to another location while this drain was queued — not ours to run.
      if (prepared === undefined) return yield* Effect.interrupt
      const {
        session,
        config,
        memoryOwnerAgent,
        memoryOwner,
        workerProfile,
        agent,
        system,
        modelSession,
        model,
        ran,
        substituted,
        scheduledDevice,
        reasoningModel,
        reasoningRan,
        reasoningScheduledDevice,
        entries,
      } = prepared
      const toolFibers = yield* FiberSet.make<void, ToolOutputStore.Error>()
      let needsContinuation = false
      /** A pre-action policy returned `halt` for one of this turn's tool calls. See `tool-policy.ts`. */
      let policyHalted = false
      /**
       * The per-ASSISTANT-TURN image budget, as a RESERVATION rather than a snapshot.
       *
       * Declared here so its lifetime IS the turn — the scope resets on the next provider turn
       * without anyone remembering to clear it, which is the property the whole mechanism rests on:
       * a fresh turn means the model has just spoken, so its budget genuinely starts again. See
       * `tool/tool.ts` → `imageBudget`.
       *
       * 🔴 **A COUNTER READ BY CONCURRENT CALLERS BEFORE ANY OF THEM INCREMENTS IT IS NOT A BUDGET,
       * IT IS N BUDGETS.** This used to be a bare `let imagesHeldThisTurn = 0` read inside the
       * forked settlement fiber and incremented only after that fiber resolved. Tool calls in one
       * turn run CONCURRENTLY (`FiberSet.run(toolFibers)`), so every call in the turn observed
       * `held: 0` and the per-turn cap was multiplied by the parallelism — with the default cap of
       * ONE (`ModelV2.DEFAULT_IMAGE_LIMIT`), two parallel `read`s of images both got their pixels,
       * `budgetImages` then elided one at lowering, and the model confabulated a picture it was
       * shown and then had taken away. That confabulation is the exact failure the whole mechanism
       * exists to prevent.
       *
       * So the counter is not readable at all: `reserve()` is the only way to obtain a `held`, and
       * it claims this call's place in the same synchronous step that reports it. Dispatch is
       * sequential (the stream's event handler), settlement is not — which is why the reservation
       * has to be taken at DISPATCH and cannot be taken where the images are counted.
       *
       * ⚠️ **Deliberately conservative, and the direction is the point.** A dispatched call whose
       * result is not yet known must be assumed to hand over pixels, because the runner cannot know
       * which tools will (`read`, `computer`, `webfetch` and any MCP tool all can). So a `read` of
       * an image dispatched behind an in-flight `bash` can be withheld with the budget still free.
       * That path is a designed, graceful one — `read` returns a SENTENCE, the turn ends, the model
       * describes what it holds, and it reads the file again next turn — whereas the other error
       * direction is undescribed pixels and an invented answer. Removing the conservatism would mean
       * making `tool.ts`'s `imageBudget` a claim CALLBACK the tool invokes at the moment it would
       * hand over pixels; that is the impossible-rung fix and it spans three files.
       */
      const imageBudget = (() => {
        /** Images that SETTLED calls actually handed over. */
        let handed = 0
        /** Dispatched calls that have not settled yet; each may still hand one over. */
        let inFlight = 0
        return {
          /** Claim this call's place. Returns what is already spoken for, NOT counting this call. */
          reserve: () => {
            const held = handed + inFlight
            inFlight++
            return held
          },
          /**
           * Record what a settled call actually handed over. Counting the settled RESULT rather than
           * the call is deliberate: a read that failed, was denied, or returned the withheld notice
           * hands over no pixels and must not consume the budget.
           */
          handed: (images: number) => {
            handed += images
          },
          /** Drop the reservation. Runs on EVERY exit of the fiber, including failure and interrupt. */
          release: () => {
            inFlight--
          },
        }
      })()
      /**
       * Tokens already charged to this turn's fairness ledger, so the dispatch's own `report` charges
       * only the REMAINDER. See the in-band release below for why anything is charged early at all.
       */
      let chargedTokens = 0
      // A promoted user message restarts the step allowance: what the agent is answering changed.
      let currentStep = prepared.promoted > 0 ? 1 : step
      /**
       * EVERY per-turn model fact, off the ONE model this turn resolved to.
       *
       * 🔴 **This used to be six independent `models.*` reads, and they described a different model
       * than the one serving the request.** Each re-entered `SessionRunnerModel`'s `select()`, which
       * applies neither of `resolve()`'s fallbacks — so a colleague whose vision model had been
       * demoted by `ModelHealth` ran on the text-only default while `capabilities` still said
       * `input: ["text","image"]`. `unreadableTurnAttachments` therefore passed, and the user's
       * screenshot was lowered as a real media part into a text-only request: the provider
       * media-type 400 the capability gate exists to prevent. Its mirror was silent and worse — a
       * text-only selection falling back to a vision model replaced every image in history with
       * *"was NOT sent to you"* and instructed a model that could see the picture to say it had not.
       * `prePrompt`, `retryAttempts`, `imageLimit` and `ref` split the same way, and `ref` is what
       * `rememberImageLimit` files a learned cap under — a cap measured on one endpoint, stored
       * against another model's id.
       *
       * ⚠️ `ran` is `undefined` ONLY behind a seam that resolves a route with no catalog entry
       * behind it (`SessionRunnerModel.layerWith`). There the accessors are the sole answer, so they
       * are read — never mixed with a partial catalog answer, which would be the same split again.
       */
      const facts =
        ran === undefined
          ? {
              ref: yield* models.ref(modelSession),
              taxonomy: yield* models.taxonomy(modelSession),
              prePrompt: yield* models.prePrompt(modelSession),
              retryAttempts: yield* models.retryAttempts(modelSession),
              capabilities: yield* models.capabilities(modelSession),
              imageLimit: yield* models.imageLimit(modelSession),
            }
          : SessionRunnerModel.perTurnFacts(ran)
      const modelGuard = SessionRunnerModel.dispatchGuard(models, facts.ref)
      const auditGuard = SessionRunnerModel.dispatchGuard(models, reasoningRan ?? ran)
      // A route gets one quick reconnect before its circuit opens. Once a durable recovery row
      // exists, each deadline admits exactly one probe so the exponential cadence remains 4 s,
      // 8 s, 16 s … rather than sneaking an extra 2 s request into every interval.
      const maxProviderAttempts =
        facts.ref !== undefined && (yield* models.providerRecoveryFailures(facts.ref)) > 0
          ? 1
          : ProviderRetry.maxAttempts()
      // Catalog identity, not the provider wire id: a model may deliberately route API requests
      // under `api.id` while users and live config know it by a different stable catalog id.
      const modelRef = facts.ref
      // 🔴 ROLE/MODEL FIT — tell the colleague when the model behind it is beneath what its role
      // declared (`agent/model-fit.ts`; `notes/named-agents.md`). It warns and never refuses.
      //
      // Placed HERE because this is the first point that holds all three facts at once: the role's
      // floor, the model the turn will actually run on (after any fallback), and its class. Reading
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
      const roleNeedsTaxonomy = prepared.workerProfile?.needsTaxonomy ?? prepared.agent.info?.needsTaxonomy
      const boundTaxonomy = facts.taxonomy
      // ⚠️ `boundTaxonomy !== undefined` is the seam's "no catalog answer" arm, and silence is the
      // honest response: an unresolved synthetic route has no class to judge, which is not the same
      // as a low one. A genuine catalog model is always materialised (`perTurnFacts`).
      if (
        roleNeedsTaxonomy !== undefined &&
        boundTaxonomy !== undefined &&
        AgentModelFit.below({ needs: roleNeedsTaxonomy, bound: boundTaxonomy })
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
                needs: roleNeedsTaxonomy,
                bound: boundTaxonomy,
                model: boundName,
              }),
            })
            .pipe(Effect.ignore)
      }
      // 🔴 SUBSTITUTION IS SURFACED, NOT SILENT (owner, 2026-09-15). The officer's own model is part
      // of its job description; when a turn runs on something else, both the officer and the person
      // reading the chat must be able to see it and, for the switched-off case, act on it — that
      // repair is the owner's alone (AGENTS.md: models are the operator's to enable, never Nova's).
      //
      // ⚠️ Once per context, like the role/model-fit notice above and for the same reason: the scan
      // is over `entries`, so a compacted context re-tells. A durable "warned once" flag would leave
      // a compacted officer confidently unaware of what it is running on.
      //
      // ⚠️ `config.model !== undefined` gates it: an inherited default that happens to be substituted
      // is not an assignment anybody made, and a session with no assignment already says what it runs
      // on through `self`. Best-effort — a notice must never cost the turn it describes.
      if (substituted !== undefined && ran !== undefined && config.model !== undefined) {
        const assigned = `${substituted.requested.providerID}/${substituted.requested.id}`
        const ranName = `${ran.providerID}/${ran.id}`
        if (assigned !== ranName) {
          const marker = `Your assigned model \`${assigned}\``
          const told = entries.some((entry) => SessionCompaction.serializeMessage(entry.message).includes(marker))
          if (!told)
            yield* events
              .publish(SessionEvent.Synthetic, {
                sessionID: session.id,
                messageID: SessionMessage.ID.create(),
                timestamp: yield* DateTime.now,
                text: SessionRunnerModel.substitutionNotice({ assigned, ran: ranName, reason: substituted.reason }),
              })
              .pipe(Effect.ignore)
        }
      }
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
      // but the capability answer comes from the turn's own model resolution, which every turn makes
      // anyway. The gate saved nothing, and it cost the perception section its input on exactly the
      // turns that need it: a media-free turn is where a model DECIDES whether to go and look, and
      // under the gate it was told nothing. Measured 2026-08-19 — see `perceptionSection`.
      //
      // 🔴 **Off the model that RAN.** This is the reading that decides whether a screenshot is
      // lowered as a real media part, so describing the model the session merely SELECTED is how a
      // demoted vision model's `input: ["text","image"]` walked a picture into a text-only request.
      const modelCapabilities = facts.capabilities
      // How many images this endpoint takes in one request; `undefined` = unlimited. Without it a
      // session that looked at more images than the server allows DEAD-ENDS — every later turn
      // re-lowers the same history and re-fails the same 400. See `budgetImages`.
      const declaredImageLimit = facts.imageLimit
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
        agentID: memoryOwnerAgent,
        memory: memoryOwner.info?.memory,
      })
      if (
        recallQuery !== undefined &&
        memoryScopes !== undefined &&
        !ShortChat.enabled(config.shortChat) &&
        // ⚠️ No `MemorySetting.memoryEnabled()` here any more: the instance ceiling is applied
        // when the config resolves, so a reader that forgets it can no longer be off by omission.
        stanceOf("memory", config.memory)
      ) {
        /**
         * ONE LEG PER TURN, not one per provider step.
         *
         * The query is `lastRealUserText`, which cannot change while a turn runs, and the cabinet,
         * pool and budget cannot either — so a forty-step turn was paying forty embeds, forty searches
         * and (with rerank on) forty model calls to assemble a byte-identical block. `recall.ts`
         * holds why the window is a TTL rather than an invalidation hook, and what the one stale case
         * costs. `reusePack` below is that decision at each expensive statement; a statement added
         * here later must join the guards, which is why the pack itself is taken from `remembered`
         * rather than recomputed and discarded.
         */
        const recallBudgetTokens = SessionRecall.recallBudget(facts.taxonomy)
        const recallTokenBudget = SessionRecall.recallTokenBudget(facts.taxonomy)
        const legKey = SessionRecall.recallLegKey({
          agentID: memoryOwnerAgent,
          scopes: memoryScopes,
          query: recallQuery,
          poolSize: SessionRecall.recallPoolSize(recallBudgetTokens),
          budget: recallTokenBudget,
        })
        const remembered = SessionRecall.cachedPack(legKey)
        const reusePack = remembered !== undefined
        // The VECTOR leg: one short embedding of the recall query lets the engine fuse vector KNN with
        // FTS (measured 85% vs 77% keyword-only). Bounded + degrading — no device, unreachable, or slow
        // ⇒ undefined ⇒ keyword-only recall. Never blocks the turn on a failure.
        // The query embedding is the one call here a live turn WAITS on, so it takes the short bound
        // (`embedQuery`, not `embedOne`): a keyword-only pack is a cheap degradation, a fifteen-second
        // pause on every step is not. The whole phase is skipped when this turn already assembled the
        // pack — a 0 ms row for work that did not happen would be the receipt lying.
        let recallVector: number[] | undefined
        if (!reusePack) {
          yield* timingStart("memory-embed")
          recallVector = yield* Effect.promise(() => KbEmbedder.embedQuery(recallQuery))
          yield* timingEnd("memory-embed")
        }
        const budget = recallBudgetTokens
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
        let recallCandidates: ReadonlyArray<MemoryClient.SearchHit> = []
        if (!reusePack) {
          yield* timingStart("memory-search")
          recallCandidates = yield* memory
            .search({
              query: recallQuery,
              k: SessionRecall.recallPoolSize(budget),
              scopes: memoryScopes,
              surface: "auto-recall",
              recallID,
              ...(recallVector === undefined ? {} : { embedding: recallVector }),
            })
            .pipe(
              // 🔴 A FAILED recall and an EMPTY one are different facts, and this collapsed them into
              // one `[]` with nothing written down. `MemoryClient.fromEngine` folds every engine fault
              // into a single tagged error, so a store whose engine had been failing every search for
              // weeks presented as a store with nothing relevant to say — to the user, and to whoever
              // read the log afterwards. Every sibling degradation in this subsystem names its fault;
              // this is the highest-traffic path in the store and it named nothing.
              Effect.tapError((fault) =>
                Log.event("session.memory.recall.failed", {
                  "session.id": session.id,
                  "session.cause": Log.fault(fault),
                }),
              ),
              Effect.orElseSucceed(() => []),
            )
          yield* timingEnd("memory-search")
        }
        // P8d: let the MODEL order what it will actually see. Metadata ordering can't read
        // authoritativeness out of the TEXT — a definitive older statement should outrank a newer
        // offhand musing (measured 4/4 vs 1/4 for metadata alone). One short call (~0.4s at 5
        // candidates). ANY failure — gate off, model down, unparseable reply — falls back to the
        // deterministic ranker, so ordering degrades but the turn never breaks.
        let ordered: ReadonlyArray<MemoryClient.SearchHit> = MemoryRanking.rankHits(recallCandidates, Date.now())
        // Recorded for the receipt: whether the MODEL ordered this pack or the deterministic ranker
        // did. They are different facts and the user can only tell them apart if the row says so —
        // a fallback looks exactly like a success in a duration.
        let rerankRan = false
        if (MemorySetting.rerankEnabled() && recallCandidates.length > 1) {
          yield* timingStart("memory-rerank")
          const prompt = MemoryRerank.buildRerankPrompt(recallQuery, recallCandidates, Date.now())
          // ⚠️ This is the ONE utility pass sitting inside the user's own turn — it runs before the
          // request is even built, and the user watches it as "Choosing useful memories". `ordered`
          // above already holds the deterministic ranking, so a slow model costs ORDERING QUALITY
          // here and nothing else. Bound it: past the deadline we keep what we have rather than make
          // someone wait for a list of numbers. (The `NO_THINKING` overlay on `judgeCompletion` makes
          // the deadline the rare path; a model that ignores the overlay makes it the common one.)
          // ⚠️ This used to be the ONE utility pass sitting inline in the user's own turn, called
          // through the runner's private judge-completion helper. The doctrine is explicit: a model
          // GENERATING an ordering is decode-shaped work, and decode-shaped work belongs on the
          // device's interactive-idle tier, not on the bus the user's reply needs. So it now enters
          // through `ShortAnswer.generate` like the titler and the status sweep do — admitted as
          // maintenance, and PREEMPTED the instant a real interactive turn wants the device, which
          // returns "" and leaves the deterministic ranking in place. That is a better outcome than
          // the deadline it keeps below: preemption yields immediately, while the deadline only
          // catches a device that is neither idle nor contended, merely slow.
          const rerankSession =
            harness.introspection.model === undefined
              ? session
              : {
                  ...session,
                  model: {
                    providerID: ProviderV2.ID.make(harness.introspection.model.providerID),
                    id: ModelV2.ID.make(harness.introspection.model.id),
                  },
                }
          const rerank = yield* models.resolveWithDevice(rerankSession)
          const reply = yield* ShortAnswer.generate({
            model: rerank.model,
            guard: SessionRunnerModel.dispatchGuard(models, rerank.ran),
            llm,
            system: prompt.system,
            text: prompt.user,
            // No deliberation wanted: the ask is a list of numbers, and thinking about the order
            // of five passages is how a 0.4 s call becomes a 4 s one.
            reasoningBudget: 0,
            maxTokens: RERANK_ANSWER_TOKENS,
            scheduler,
            maintenance: {
              ownerID: session.id,
              task: "memory-rerank",
              deviceKey: rerank.device.key,
              ...(rerank.device.concurrency === undefined ? {} : { concurrency: rerank.device.concurrency }),
              ...(rerank.device.locality === undefined ? {} : { locality: rerank.device.locality }),
            },
          }).pipe(
            Effect.timeoutOrElse({ duration: RERANK_DEADLINE, orElse: () => Effect.succeed("") }),
            Effect.orElseSucceed(() => ""),
          )
          const order = MemoryRerank.parseRerankOrder(reply, recallCandidates.length)
          // `rerankRan` now means the model ACTUALLY ordered the pack, not that we asked — a call
          // preempted by the user's own turn is a fallback, and the receipt must not claim otherwise.
          if (order) {
            ordered = order.map((index) => recallCandidates[index]!)
            rerankRan = true
          }
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
        const pack = remembered ?? SessionRecall.packRecall(ordered, recallTokenBudget)
        recalledMemories = pack.shown
        memoryRecall = SessionRecall.formatRecall(pack)
        // Only a leg that ACTUALLY RAN is stamped, recorded, or remembered. A reused pack gets no
        // receipt row (nothing ran; the absence is the fact, and a 0 ms row would be the receipt
        // inventing work), no `used` ledger write (step one of this turn already said these memories
        // reached the model, and re-marking the same ids changes no signal the pruning policy weighs),
        // and no second cache entry.
        if (remembered === undefined) {
          SessionRecall.storePack(legKey, pack)
          // The receipt row for this leg, stamped where the numbers are true. A duration alone cannot
          // tell a healthy hybrid search from a keyword-only search of an empty cabinet — both are
          // fast, and the degraded one is the FAST one, which is precisely why timing hid it.
          timing.annotate("memory-search", {
            retrieved: recallCandidates.length,
            shown: pack.shown.length,
            omitted: pack.omitted,
            tokens: pack.tokens,
            protectedCount: pack.protectedCount,
            vector: recallVector !== undefined,
            reranked: rerankRan,
          })
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
      const liveToolMaterialization = yield* tools.materialize(
        // The horizon sees what the verdict will refuse everywhere — the mode overlay, the Tuning
        // switches and the unattended stance, not the agent's own rules alone — so a tool the
        // model could never use is withdrawn rather than advertised and refused (see
        // `PermissionV2.horizonLayers` for what stays out, and why).
        PermissionV2.horizonLayers({
          agent: agent.info?.permissions,
          mode: config.permissionMode ?? EFFECTIVE_CONFIG_DEFAULTS.permissionMode,
          resolved: config,
          // The NARROWED root type: an unreadable chain reads as unattended here exactly as it does
          // for the jail, and this file does not become another holder of the tri-state.
          rootType: yield* rootSessionType(session.id, (id) => store.get(id as SessionSchema.ID)),
        }),
        (name) =>
          ShortChat.offered(config.shortChat, name) &&
          ConfigToolRouting.offered(harness.toolRouting, {
            mode: config.permissionMode,
            providerID: modelRef?.providerID ?? model.provider,
            modelID: modelRef?.id ?? model.id,
          })(name),
        discoveredTools,
      )
      // Compaction starts a new context epoch. Within one epoch every provider-prefix byte is
      // immutable; the new baseline sequence deliberately gives changed standing configuration a
      // fresh prefix instead of mutating the old one in place.
      const promptPrefixKey = session.id
      if (promptPrefixEpoch.get(promptPrefixKey) !== system.baselineSeq) {
        promptPrefixEpoch.set(promptPrefixKey, system.baselineSeq)
        residentToolPrefix.delete(promptPrefixKey)
        deferredToolCatalogue.delete(promptPrefixKey)
        residentToolCatalogue.delete(promptPrefixKey)
      }
      const frozenDefinitions = residentToolPrefix.get(promptPrefixKey)
      const stableDefinitions = frozenDefinitions ?? [...liveToolMaterialization.definitions]
      if (frozenDefinitions === undefined) residentToolPrefix.set(promptPrefixKey, stableDefinitions)
      const toolMaterialization = { ...liveToolMaterialization, definitions: stableDefinitions }
      const catalogueNow = new Set(toolMaterialization.deferred.map((source) => source.definition.name))
      const catalogueBefore = deferredToolCatalogue.get(promptPrefixKey)
      deferredToolCatalogue.set(promptPrefixKey, catalogueNow)
      const addedTools = catalogueBefore ? [...catalogueNow].filter((name) => !catalogueBefore.has(name)) : []
      const removedTools = catalogueBefore ? [...catalogueBefore].filter((name) => !catalogueNow.has(name)) : []
      const liveResidentNames = new Set(liveToolMaterialization.definitions.map((definition) => definition.name))
      const residentBefore = residentToolCatalogue.get(promptPrefixKey)
      residentToolCatalogue.set(promptPrefixKey, liveResidentNames)
      const residentBecameAvailable = residentBefore
        ? [...liveResidentNames].filter((name) => !residentBefore.has(name))
        : []
      const residentBecameUnavailable = residentBefore
        ? [...residentBefore].filter((name) => !liveResidentNames.has(name))
        : []
      const toolCatalogueUpdate =
        addedTools.length === 0 &&
        removedTools.length === 0 &&
        residentBecameAvailable.length === 0 &&
        residentBecameUnavailable.length === 0
          ? undefined
          : SessionInput.applySteerProvenance(
              [
                "Tool catalogue update:",
                ...(addedTools.length ? [`Newly available through tool_search: ${addedTools.join(", ")}.`] : []),
                ...(removedTools.length ? [`No longer available: ${removedTools.join(", ")}.`] : []),
                ...(residentBecameUnavailable.length
                  ? [
                      `Temporarily unavailable resident tools: ${residentBecameUnavailable.join(", ")}. Calls will return the precise current refusal.`,
                    ]
                  : []),
                ...(residentBecameAvailable.length
                  ? [
                      `Resident tools enabled after this context epoch began: ${residentBecameAvailable.join(", ")}. They will enter the native schema prefix in a new chat; runtime-varying tools should use deferred discovery.`,
                    ]
                  : []),
                "This update is appended here so the immutable provider/tool prefix remains cacheable.",
              ].join("\n"),
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
            // ⚠️ `??`, not `||` — and the difference is a real temperature of 0. This
            // read used to be `|| undefined`, because the Affective settings tab wrote `0` to mean
            // "cleared" on the argument that keys could not be removed over the wire. They can:
            // `POST /api/config/remove` is the deletion verb, the tab now uses it, and an absent
            // temperature arrives here as `undefined` on its own. So `0` is what it says it is —
            // `precise`, the first named preset — and swallowing it would silently ignore a setting
            // the user can now deliberately choose.
            temperature: defaults?.temperature ?? harness.affective?.temperature,
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
      // THE ONE SYSTEM MESSAGE. `PromptManager` built it when this context epoch was established (a
      // new session) or replaced (after a compaction), and it is reused byte-for-byte on every casual
      // turn — the epoch's comparator makes a casual turn `Unchanged`, so nothing here recomputes it.
      // The part-assembly mechanism this replaces (per-turn slots, the persona baseline, the model
      // pre-prompt, the tool-discovery and delegation sections) is retired; see `prompt-manager.ts`.
      const systemParts = system.baseline.length > 0 ? [SystemPart.make(system.baseline)] : []
      const promptTokens = Token.estimate(system.baseline)
      yield* Log.event("session.prompt.blocks", {
        "session.id": session.id,
        "prompt.tokens": promptTokens,
        "prompt.chars": system.baseline.length,
        "prompt.blocks": systemParts.length,
        "prompt.largest": systemParts.length === 0 ? "none" : "system",
        "prompt.largest.tokens": systemParts.length === 0 ? 0 : promptTokens,
      })
      const providerMessages = toLLMMessages(context, model, modelCapabilities, modelImageLimit)
      const freshImages = freshImageCount(providerMessages)
      if (modelImageLimit !== undefined && freshImages > modelImageLimit) {
        const refusal = new SessionRunnerModel.ImageBatchTooLargeError({
          providerID: ProviderV2.ID.make(String(model.provider)),
          modelID: ModelV2.ID.make(String(model.id)),
          count: freshImages,
          limit: modelImageLimit,
        })
        yield* surfacePreTurnFailure(refusal)
        return yield* refusal
      }
      const latestCompactionID = context.findLast((message) => message.type === "compaction")?.id
      const groundingEnabled = !ShortChat.enabled(config.shortChat)
      const groundingDecision = ProjectGrounding.decide(
        {
          enabled: groundingEnabled,
          directory: location.directory,
          ...(latestCompactionID === undefined ? {} : { compactionID: latestCompactionID }),
          // A pure Chat request cannot be due for cadence grounding. Do not serialize its whole
          // transcript just to feed a decision that returns immediately when disabled.
          contextTokens: groundingEnabled
            ? RequestFootprint.measure({ system: [], messages: providerMessages, tools: [] }).estimatedTokens
            : 0,
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
      const ordinaryRequest = LLM.request({
        model,
        // ONE monolithic system message, rendered by `PromptManager` and frozen with the context
        // epoch (owner, 2026-09-17). There is no part array to order and no per-turn section: a new
        // session or a compaction regenerates it, a casual turn reuses it byte for byte.
        system: systemParts,
        messages: [
          ...providerMessages,
          // Derived provider context only — never a transcript row. The provenance prefix makes
          // every downstream real-user detector treat it as harness guidance rather than speech.
          //
          // Auto-recall rides the TAIL, never the epoch-frozen prompt: it is recomputed and re-ranked
          // every turn, and in the system array it threw away the server-side prefix cache for the
          // entire request — measured 0.3s -> 12.9s to first token on a 13.5K-token agent turn. Here,
          // a change costs only the tokens after it.
          // 🔴 The TAIL, in the order `ContextTemplate.SLOTS` declares. It is the one place after the
          // transcript, and the order is the table's rather than a hand-written spread here.
          ...ContextTemplate.tailMessages({
            projectGrounding: projectGrounding === undefined ? undefined : Message.user(projectGrounding),
            memoryRecall: recallMessage === undefined ? undefined : Message.user(recallMessage),
            todoReminder: todoReminder === undefined ? undefined : Message.user(todoReminder),
            toolCatalogueUpdate: toolCatalogueUpdate === undefined ? undefined : Message.user(toolCatalogueUpdate),
            maxSteps: isLastStep ? Message.assistant(MAX_STEPS_PROMPT) : undefined,
          }),
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
      // An explicit officer budget of zero means NO reasoning, not an unmonitored reasoning stream.
      // Apply the provider-neutral structural switches before prompt measurement and dispatch so
      // every downstream consumer sees the exact request that reaches the provider.
      const baseRequest =
        config.reasoningBudget === 0 ? ProviderDispatch.withoutReasoning(ordinaryRequest) : ordinaryRequest
      const attemptModelRef = {
        id: ModelV2.ID.make(model.id),
        providerID: ProviderV2.ID.make(model.provider),
        ...(modelSession.model?.variant === undefined ? {} : { variant: modelSession.model.variant }),
      }
      const thinkingBudget =
        config.reasoningBudget ??
        reasoningModel?.route.defaults.limits?.thinkingBudget ??
        model.route.defaults.limits?.thinkingBudget ??
        0
      const budgetEnforced =
        stanceOf("thinkingBudget", config.thinkingBudget) &&
        (config.reasoningBudget !== undefined || !ShortChat.enabled(config.shortChat))
      // Build the opening request once so prompt estimation, compaction, packing and provider
      // dispatch all see exactly the same bytes.
      const openingRequest = ProviderDispatch.openingRequest({
        request: baseRequest,
        enabled: budgetEnforced && !isLastStep,
        budget: thinkingBudget,
      })
      const promptScopeBase = {
        sessionID: session.id,
        contextEpoch: system.baselineSeq,
        providerID: attemptModelRef.providerID,
        modelID: attemptModelRef.id,
        ...(attemptModelRef.variant === undefined ? {} : { variant: attemptModelRef.variant }),
        serverKey: PromptEstimate.serverKey(model.route.endpoint?.baseURL, scheduledDevice.key),
        routeID: model.route.id,
        protocolID: model.route.protocol,
        controllerKey:
          budgetEnforced && !isLastStep && thinkingBudget > 0 ? `reasoning-budget:${thinkingBudget}` : "plain",
      }
      const routeProfileScope: ModelRouteProfileStore.Scope = {
        providerID: attemptModelRef.providerID,
        wireModelID: attemptModelRef.id,
        serverKey: promptScopeBase.serverKey,
        routeID: promptScopeBase.routeID,
        protocolID: promptScopeBase.protocolID,
      }
      const routeProfile = yield* routeProfiles
        .resolve(routeProfileScope, { safeDefault: { imagePatchPixels: Token.DEFAULT_IMAGE_PATCH_PIXELS } })
        .pipe(
          Effect.orElseSucceed(() => ({
            promptFactor: 1,
            promptResidualRatios: [],
            imagePatchPixels: Token.DEFAULT_IMAGE_PATCH_PIXELS,
            prefixCacheRetentionTokens: undefined,
            servedBy: undefined,
          })),
        )
      const promptScope: PromptEstimate.Scope = {
        ...promptScopeBase,
        ...(routeProfile.servedBy === undefined ? {} : { servedBy: routeProfile.servedBy }),
      }
      const promptEstimate = PromptEstimate.resolve({
        request: openingRequest,
        messages: entries.map((entry) => entry.message),
        scope: promptScope,
        calibrationFactor: routeProfile.promptFactor,
        anchoredResidualRatios: routeProfile.promptResidualRatios,
        imagePatchPixels: routeProfile.imagePatchPixels,
      })
      yield* timingEnd("request-build")
      // Prepare the provider request BEFORE a possible compaction so a derived summary can reuse
      // the exact same packed prefix an ordinary turn would send. Passing the un-packed assembly
      // here defeats cache reuse precisely on long chats, because its extra old messages diverge at
      // the history frontier the provider has cached.
      yield* timingStart("context-fit")
      // One argument list, used twice: the ordinary pack, and the HARD re-pack the last-moment gate
      // below may ask for. A second copy would be the divergence that lets the gate measure against
      // a different window than the packer packed to (ruling 6, in miniature).
      const prepareInput = {
        request: openingRequest,
        promptCacheKey,
        contextSize: model.route.defaults.limits?.context,
        prefixCacheRetentionTokens: routeProfile.prefixCacheRetentionTokens,
        profile: ContextBudget.enabled(harness.context, config.contextBudget)
          ? ContextBudget.resolve(harness.context, config.type)
          : undefined,
        memoryRecall: recallMessage,
        promptCorrectionTokens: promptEstimate.correctionTokens,
        promptMarginTokens: promptEstimate.marginTokens,
        imagePatchPixels: routeProfile.imagePatchPixels,
        // The compactor's own reserve, so the packer cannot approve a request the compactor has
        // already measured as over budget. See `ContextPack.budget`.
        minimumResponseReserveTokens: harness.compaction.settings.buffer,
      } satisfies ProviderDispatch.PrepareInput
      // The agent's scratch folder, resolved ONCE: the tombstone the packer may emit names a file in
      // it, the compaction below writes its folded chat into it, and two separate `Scratch.forAgent`
      // calls would be two chances for the two to name different folders.
      const scratchFolder = prepared.agent.id ? Scratch.forAgent(String(prepared.agent.id)) : undefined
      const preparedDispatch = yield* prepareDispatch({ prepare: prepareInput, scratchFolder, sessionID: session.id })
      yield* timingEnd("context-fit")
      // ⚠️ `compactIfNeeded` is a CHECK that usually declines — window unknown, no summary model, or
      // simply under its threshold. Timing it is right; RECORDING it as a phase is not, because the
      // receipt then says "Compacting the conversation" over a conversation nobody compacted. The
      // owner saw exactly that two messages into a fresh session on a packaged build (2026-08-11).
      // A receipt is a claim about what happened, so a stage that declined is withdrawn rather than
      // reported.
      const retryAt = compactionRetryAt.get(session.id) ?? 0
      const shouldAttemptCompaction = CompactionBackoff.due(retryAt, Date.now())
      let compacted = false
      // 🔴 ALWAYS CALLED — the backoff gates the SPEND, not the check. It used to skip this call
      // entirely for 30 minutes after a summarizer failure, which meant the threshold was not even
      // measured or logged and the packed request went out unmeasured: `ses_daedalus` dispatched a
      // request its own estimate put at 281,140 tokens against a 235,929 ceiling, 148 ms after
      // compaction had given up. A failed summary is evidence about the summarizer; it is not
      // evidence that the chat has room. See `SessionCompaction.Input.summaryAllowed`.
      {
        let declined: SessionCompaction.DeclineReason | undefined
        yield* timingStart("compaction")
        compacted = yield* harness.compaction.compactIfNeeded({
          sessionID: session.id,
          scratchFolder,
          entries,
          model,
          guard: modelGuard,
          request: preparedDispatch.request,
          promptEstimate,
          imagePatchPixels: routeProfile.imagePatchPixels,
          prefixCacheRetentionTokens: routeProfile.prefixCacheRetentionTokens,
          summaryAllowed: shouldAttemptCompaction,
          maintenance: {
            ownerID: session.id,
            task: "compaction",
            deviceKey: scheduledDevice.key,
            ...(scheduledDevice.concurrency === undefined ? {} : { concurrency: scheduledDevice.concurrency }),
            ...(scheduledDevice.locality === undefined ? {} : { locality: scheduledDevice.locality }),
          },
          onDecline: (reason) => {
            declined = reason
          },
        })
        const nextRetryAt = CompactionBackoff.afterAttempt({
          current: compactionRetryAt.get(session.id),
          now: Date.now(),
          compacted,
          decline: declined,
        })
        if (nextRetryAt === undefined) compactionRetryAt.delete(session.id)
        else compactionRetryAt.set(session.id, nextRetryAt)
        yield* flushDriveState(session.id)
      }
      // The conversation that just got compressed away is written into this colleague's OWN memory
      // as passages, so `kb search` can find it later (`session/compaction-archive.ts` holds the
      // why). Best-effort and AFTER the compaction is durable: an archive that failed must never
      // turn a successful compaction into a failed turn — the summary is already committed, and the
      // transcript rows are still in the database either way.
      if (compacted)
        yield* archiveCompactedChat({ entries, memoryOwner, memory, session }).pipe(
          // Best-effort means the TURN survives, not that nobody is told. `Effect.ignore` here made
          // an empty archive indistinguishable from an archive that was never attempted — which is
          // exactly the question a person debugging one would be asking.
          reportArchiveFailure(session.id, agent.id),
        )
      // 🔴 THE DURABLE AREA IS MATERIALISED HERE, and "here" is the whole of the owner's rule
      // (*"updated only after compaction, from the housekeeped shadow copy"*). The `durable` items are
      // the shadow the colleague writes mid-session with `durable_set` / `durable_clear`; this turn —
      // the first after a rewrite — is when their rendered form becomes the block the model reads.
      // Rendering live instead would make every `durable_set` an edit to the system prompt mid-turn,
      // which is the churn the slot's `compaction` volatility exists to avoid.
      //
      // ⚠️ It runs on EVERY committed compaction, including one that folds nothing, and it writes the
      // area even when the item set is EMPTY (`text: ""`): clearing the last durable item has to
      // delete the block at the next rewrite, or a cleared item would survive in the prompt forever —
      // the exact failure the area exists to prevent, one level up.
      //
      // ⚠️ Best-effort, like the archive above and for the same reason: the compaction is already
      // durable, and a stale area is a far smaller loss than a failed turn. The `put` is still
      // validated by the registry, so a malformed shadow surfaces as a fault where faults belong.
      if (compacted) {
        const durableItems = yield* components
          .list({ sessionID: session.id, kind: "durable" })
          .pipe(Effect.orElseSucceed((): readonly { readonly value: unknown }[] => []))
        yield* components
          .put({
            sessionID: session.id,
            kind: "durable_prompt",
            value: { text: Durable.render(Durable.itemsOf(durableItems)) },
            system: true,
          })
          .pipe(Effect.ignore)
      }
      if (compacted) {
        const latest = yield* SessionHistory.latestCompaction(db, session.id)
        if (latest)
          yield* deliverNudges(
            session.id,
            String(agent.id),
            { type: "compaction", id: latest.id },
            !ShortChat.enabled(config.shortChat),
          )
      }
      if (compacted) yield* timingEnd("compaction")
      // The phase is started unconditionally now (see the call site), so it must be withdrawn
      // unconditionally too — a started phase that never ends is a receipt that hangs.
      else yield* Effect.sync(() => timing.discard("compaction")).pipe(Effect.andThen(publishLiveTiming()))
      if (compacted) return yield* Effect.die(continueAfterCompaction(currentStep))
      // 1M — the deterministic fail-safe under compaction: pack the outgoing request to the
      // server's HONORED window so an OpenAI-compatible server never silently front-truncates the
      // system prompt away. Reached when compaction declined (window unknown, summary model
      // unavailable, or simply under ITS threshold) — history in the DB stays intact.
      // The deterministic packer: what had to be dropped for the request to fit the window.
      const packed = preparedDispatch.packed
      if (packed.dropped > 0)
        yield* Log.event("session.context.pack.evicted", {
          "session.id": session.id,
          "session.dropped": packed.dropped,
          "session.kept.tokens": packed.estimatedTokens,
          "session.context.size": packed.contextSize,
        })
      let request = preparedDispatch.request
      /**
       * 🔴 **THE GATE MUST MEASURE WITH THE PROVIDER'S OWN COUNT, OR IT REFUSES A CHAT THAT FITS.**
       *
       * This was `PromptEstimate.whole(request) * promptFactor` — the raw heuristic, with no anchor.
       * Measured 2026-09-15 (`ses_geryon`, the session that landed this gate): the heuristic priced
       * the outbound request at **229,614** against a **229,376** ceiling, and the gate refused. The
       * same request carried a durable anchor recording what the provider had actually counted for
       * it one step earlier — **162,572** input tokens, 67 k UNDER the ceiling — and the packer had
       * already used that anchor: `promptCorrectionTokens` is threaded into its budget, so it
       * dropped nothing and reported `droppedMessages: 0`. So the harness refused a request its own
       * packer had approved and its own provider had measured, and the turn died on it. A refusal
       * built on the most pessimistic number in the building is the same defect as dispatching on
       * the most optimistic one, facing the other way.
       *
       * ⚠️ **`promptFactor` cannot fix this.** `calibrationFactor` is clamped to `[1, 1.25]` — it may
       * only inflate — while this route's error is an OVER-estimate (heuristic ÷ reported = 1.41 on
       * the same transcript). Only the anchor corrects a high heuristic, and the anchor is exactly
       * what the gate was not reading.
       *
       * ⭐ **Resolve again on the PACKED request, not on the opening one.** `resolve` prices one
       * request; the packer then rewrites it (eviction, elision, a hard re-pack) before anything
       * leaves, and the correction it establishes is a property of the route and the settled prefix
       * rather than of the request shape — so it transfers, but only onto the request that is
       * actually sent. Reading `openingRequest` here would report a request that was never sent.
       */
      const resolveOutbound = (candidate: ProviderDispatch.PrepareInput["request"]) =>
        PromptEstimate.resolve({
          request: candidate,
          messages: entries.map((entry) => entry.message),
          scope: promptScope,
          calibrationFactor: routeProfile.promptFactor,
          anchoredResidualRatios: routeProfile.promptResidualRatios,
          imagePatchPixels: routeProfile.imagePatchPixels,
        })
      let outboundPromptTokens = resolveOutbound(request).estimatedTokens
      /**
       * 🔴 **1M — THE LAST GATE, AND THE ONLY ONE THAT KNOWS BOTH THE CEILING AND THE BYTES.**
       *
       * Everything above this line is ADVICE: a heuristic estimate, a compaction that may have
       * declined, a packer whose three never-drop rules can leave the request over budget by
       * construction, and a failure backoff that used to switch the whole check off. Measured
       * 2026-09-14 (`ses_daedalus`): the harness dispatched a request its own estimate put at
       * 281,140 tokens against a 235,929 ceiling and read back HTTP 400 — it measured itself 19 %
       * over and sent it anyway, because nothing compared the two.
       *
       * ⭐ **The window is `preparedDispatch.packed.contextSize`, NOT a re-resolution.** That is the
       * number the packer actually packed to (including its `DEFAULT_CONTEXT_SIZE` fallback), and a
       * second lookup here could disagree with it by construction — a gate measuring a different
       * window than the packer used is worse than no gate.
       *
       * ⚠️ **Do not refuse on the first measurement.** The estimate is a heuristic that has been
       * observed 14 % HIGH, so a request measured slightly over may well fit. One deterministic
       * HARD re-pack — the same packer with its never-drop rules relaxed — either brings it under or
       * proves that nothing can. Only the second measurement may end a turn.
       */
      /**
       * 🔴 **THE PROVIDER'S CONTRACT — `context - output` — NOT OUR OWN RESERVE.**
       *
       * The first cut of this gate reused `PromptEstimate.capacity(...)` with the compaction buffer,
       * which is the COMPACTOR's ceiling. That number is our own margin for estimation error and
       * response headroom, and it is not a limit any provider enforces: with the default 20,000-token
       * buffer and the 8,192-token floor under it, every route whose window is under ~22 k gets a
       * ceiling of ZERO, and a gate that refuses on it refuses EVERY dispatch on those routes. The
       * runner's own harness pins caught it — a 4,000-token test route went from "compacts and
       * continues" to "refused to dispatch".
       *
       * ⭐ What the provider actually said, verbatim (`ses_daedalus`, 2026-09-14):
       * *"you requested 16384 output tokens and your prompt contains at least 245761 input tokens,
       * for a total of at least 262145"* — the contract is `input + output ≤ window`. That is the
       * number this gate holds, and it is positive whenever the window can hold the requested output
       * at all. A degenerate route (output ≥ window) is not evidence about anything, so the gate stays
       * out of the way and the packer's own "a degenerate window still sends the newest message" rule
       * governs, exactly as before.
       *
       * ⚠️ Deliberately NOT subtracting `promptEstimate.marginTokens`: that uncertainty term has a
       * 1,000-token floor, which is a quarter of a small window, and a gate that refuses on it is the
       * same defect with a smaller constant. Estimation error is the COMPACTOR's business — it fires
       * earlier, at 90 % of the window — and this gate is the last resort behind it.
       */
      const requestedOutputTokens = request.generation?.maxTokens ?? model.route.defaults.limits?.output ?? 0
      const dispatchCeiling = Math.max(0, preparedDispatch.packed.contextSize - Math.max(0, requestedOutputTokens))
      let ceilingRefusal: LLMError | undefined
      if (dispatchCeiling > 0 && outboundPromptTokens > dispatchCeiling) {
        yield* Log.event("session.context.ceiling.exceeded", {
          "session.id": session.id,
          "session.prompt.tokens": outboundPromptTokens,
          "session.prompt.ceiling": dispatchCeiling,
          "session.prompt.overrun": outboundPromptTokens - dispatchCeiling,
          "session.context.size": preparedDispatch.packed.contextSize,
        })
        const shrunk = yield* prepareDispatch({
          prepare: prepareInput,
          scratchFolder,
          sessionID: session.id,
          hard: true,
        })
        const shrunkTokens = resolveOutbound(shrunk.request).estimatedTokens
        if (shrunk.packed.fits && shrunkTokens <= dispatchCeiling) {
          yield* Log.event("session.context.ceiling.shrunk", {
            "session.id": session.id,
            "session.prompt.tokens": shrunkTokens,
            "session.prompt.ceiling": dispatchCeiling,
            "session.dropped": shrunk.packed.dropped,
          })
          request = shrunk.request
          outboundPromptTokens = shrunkTokens
        } else {
          /**
           * ⚠️ **REFUSING IS THE LAST RESORT, AND IT IS REACHED ONLY WHEN NO DROP CAN HELP.** Hard
           * mode leaves at least the newest message, so `fits: false` here means that ONE message is
           * over the window on its own — there is no smaller request to send, and a provider that
           * accepts it either refuses it (the 400 this gate exists to prevent) or, on a compatible
           * server that reports no window, silently FRONT-TRUNCATES it (`context-pack.ts`'s header:
           * the agent loses its system prompt and earlier tool results mid-task with no error).
           *
           * ⭐ The sentence distinguishes the two shapes, because the user's remedy differs: a paste
           * that is too big for this model versus a chat that is too big. `keptMessages === 1` is what
           * tells them apart — hard mode has already given up everything else.
           */
          const alone = shrunk.packed.messages.length <= 1
          ceilingRefusal = new LLMError({
            module: "SessionRunner",
            method: "dispatch",
            reason: new InvalidRequestReason({
              message: alone
                ? `This message is too large to send on its own: about ${outboundPromptTokens} tokens against ` +
                  `this model's ${dispatchCeiling}-token prompt limit. Send a smaller part of it, or switch this ` +
                  `chat to a model with a larger context window.`
                : `This chat is too large to send: about ${outboundPromptTokens} tokens against this model's ` +
                  `${dispatchCeiling}-token prompt limit, and dropping older messages could not get it under. ` +
                  `NovaClaw is about to try folding the conversation instead.`,
              classification: "context-overflow",
            }),
          })
        }
      }
      const prefixCacheObservation =
        prepared.ran?.prefixCache?.enabled === true
          ? yield* ModelPrefixCache.observe(db, {
              model: `${prepared.ran.providerID}/${prepared.ran.id}`,
              prompt: ModelPrefixCache.serialize(request),
              promptTokens: outboundPromptTokens,
              ttlMinutes: prepared.ran.prefixCache.ttlMinutes,
            }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
          : undefined
      const retryAuthorization =
        overflowRecovery === undefined
          ? undefined
          : OverflowRecoveryPolicy.authorizeRetry({
              plan: overflowRecovery.plan,
              compressedPromptTokens: outboundPromptTokens,
              failedRoute: overflowRecovery.failedRoute,
              retryRoute: routeProfileScope,
            })
      // Measured AFTER packing, because packing is what actually goes out — reading `openingRequest`
      // would report a request that was never sent and hide eviction entirely. Numbers only, at
      // `debug`: this fires every turn, and the value is the series rather than any one line.
      yield* Log.event("session.request.footprint", {
        "session.id": session.id,
        ...RequestFootprint.attributes(
          RequestFootprint.measure({ system: request.system, messages: request.messages, tools: request.tools }),
        ),
      })
      // The exact bytes the provider is about to receive, kept in the agent's scratch so the Work tab
      // and the context view can export them.
      //
      // ⚠️ **`prepare`, and NOT the packed `LLMRequest` shape.** The harness's request is not the
      // wire body: the protocol adapter lowers it (roles, `tool_calls`, `stream` flags, `max_tokens`)
      // and the transport merges any `http.body` overlay (sampling split, `chat_template_kwargs`)
      // before encoding. The export is defined as the RAW request, so it is the encoded text
      // `prepare` hands the transport — the same string this dispatch sends for the request below.
      //
      // Best-effort by construction: a failed compile is swallowed and `capture` swallows every write
      // error, so a debug artifact can never fail a turn.
      if (scratchFolder !== undefined) {
        const capturedText = yield* llm.prepare(request).pipe(
          Effect.map((prepared) => prepared.bodyText),
          Effect.catchCause(() => Effect.succeed(undefined)),
        )
        if (capturedText !== undefined)
          yield* Effect.promise(() =>
            PromptCapture.capture({ scratchFolder, sessionID: session.id, text: capturedText }),
          )
      }
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
      const publisher = createLLMEventPublisher(events, {
        sessionID: session.id,
        assistantMessageID,
        agent: agent.id,
        model: attemptModelRef,
        snapshot: startSnapshot,
        prefixCache: prefixCacheObservation,
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
      // A successful provider stream that emitted no assistant output. This must travel with the
      // provider turn: rereading the transcript after `failAssistant` sees the durable ERROR row (or,
      // before that existed, the previous tool row), so absence cannot be reconstructed from history.
      let emptyResponse = false
      let handledResponseFailure = false
      let providerPromptAnchor: SessionMessage.PromptAnchor | undefined
      // MindControl thinking budget (reasoning-budget.ts): when the model carries a budget and this
      // isn't the tool-less final step, run the turn through the budget controller — it monitors the
      // reasoning stream and, only if the model runs past the budget still thinking, stops and
      // continues with a nudge (and a forced `</think>` close at the end). A model that answers on
      // its own streams through untouched. Skipped when thinking is explicitly disabled for the turn.
      const budgetedSource =
        ceilingRefusal !== undefined
          ? // The gate refused: nothing goes on the wire. Failing the STREAM (rather than the effect)
            // hands the refusal to the same machinery a real 400 reaches — publish, then the one
            // bounded overflow recovery, which folds the conversation and retries this step. The
            // classification is `context-overflow` because that is what this is: the provider never
            // had to say it, we measured it.
            Stream.fail(ceilingRefusal)
          : retryAuthorization?.action === "stop"
            ? Stream.succeed(overflowRecovery!.failure)
            : ProviderDispatch.stream({
                llm,
                request,
                preparedOpening: request,
                enabled: budgetEnforced && !isLastStep,
                budget: thinkingBudget,
                ...(reasoningModel === undefined ? {} : { reasoningModel }),
                ...(reasoningModel === undefined
                  ? {}
                  : {
                      prepareAnswer: (answer) =>
                        ProviderDispatch.prepare({
                          request: answer,
                          promptCacheKey,
                          contextSize: model.route.defaults.limits?.context,
                          prefixCacheRetentionTokens: routeProfile.prefixCacheRetentionTokens,
                          profile: ContextBudget.enabled(harness.context, config.contextBudget)
                            ? ContextBudget.resolve(harness.context, config.type)
                            : undefined,
                          memoryRecall: recallMessage,
                          promptCorrectionTokens: promptEstimate.correctionTokens,
                          promptMarginTokens: promptEstimate.marginTokens,
                          imagePatchPixels: routeProfile.imagePatchPixels,
                          minimumResponseReserveTokens: harness.compaction.settings.buffer,
                        }).request,
                    }),
                ...(reasoningScheduledDevice === undefined || reasoningScheduledDevice.key === scheduledDevice.key
                  ? {}
                  : {
                      reasoningPhase: {
                        // The outer dispatch owns the ordinary device. Move that lease, rather than
                        // holding two devices or attributing one model's work to the other's queue.
                        enter: scheduler
                          .release({ sessionID: session.id as string, deviceKey: scheduledDevice.key })
                          .pipe(
                            Effect.andThen(
                              scheduler.admit({
                                sessionID: session.id as string,
                                deviceKey: reasoningScheduledDevice.key,
                                sessionClass: SessionScheduler.classForSessionType(config.type),
                                ...(config.priority > 0 ? { priority: config.priority } : {}),
                                ...(reasoningScheduledDevice.concurrency === undefined
                                  ? {}
                                  : { concurrency: reasoningScheduledDevice.concurrency }),
                                ...(reasoningScheduledDevice.minRunMs === undefined
                                  ? {}
                                  : { minRunMs: reasoningScheduledDevice.minRunMs }),
                                ...(reasoningScheduledDevice.locality === undefined
                                  ? {}
                                  : { locality: reasoningScheduledDevice.locality }),
                              }),
                            ),
                          ),
                        leave: (costTokens: number | undefined) =>
                          (costTokens === undefined
                            ? Effect.void
                            : scheduler.report({
                                sessionID: session.id as string,
                                deviceKey: reasoningScheduledDevice.key,
                                costTokens,
                              })
                          ).pipe(
                            Effect.andThen(
                              scheduler.release({
                                sessionID: session.id as string,
                                deviceKey: reasoningScheduledDevice.key,
                              }),
                            ),
                            Effect.andThen(
                              scheduler.admit({
                                sessionID: session.id as string,
                                deviceKey: scheduledDevice.key,
                                sessionClass: SessionScheduler.classForSessionType(config.type),
                                ...(config.priority > 0 ? { priority: config.priority } : {}),
                                ...(scheduledDevice.concurrency === undefined
                                  ? {}
                                  : { concurrency: scheduledDevice.concurrency }),
                                ...(scheduledDevice.minRunMs === undefined
                                  ? {}
                                  : { minRunMs: scheduledDevice.minRunMs }),
                                ...(scheduledDevice.locality === undefined
                                  ? {}
                                  : { locality: scheduledDevice.locality }),
                              }),
                            ),
                            Effect.uninterruptible,
                          ),
                      },
                    }),
                onProviderStep: ({ request: providerRequest, usage, providerMetadata, anchorable, phase }) => {
                  // The reasoning request has a different model, prompt shape and cache history. Its
                  // usage is aggregated into the turn below, but feeding it into the ordinary route's
                  // calibration would poison the next prompt estimate.
                  if (phase === "reasoning") return Effect.void
                  const estimatedPrompt = PromptEstimate.whole(providerRequest, routeProfile.imagePatchPixels)
                  const reportedPrompt = PromptEstimate.reportedPromptTokens(usage)
                  const servedBy = ProviderCapability.servingIdentityOf(providerMetadata)
                  const observationScope: PromptEstimate.Scope = {
                    ...promptScope,
                    ...(servedBy === undefined ? {} : { servedBy }),
                  }
                  // Re-resolve the exact outbound request: packing can make it differ from the pre-pack
                  // opening request. Only a compatible durable anchor is eligible for the
                  // residual series; whole-request fallbacks continue feeding the separate bias ratio.
                  const providerEstimate = PromptEstimate.resolve({
                    request: providerRequest,
                    messages: entries.map((entry) => entry.message),
                    scope: observationScope,
                    calibrationFactor: routeProfile.promptFactor,
                    anchoredResidualRatios: routeProfile.promptResidualRatios,
                    imagePatchPixels: routeProfile.imagePatchPixels,
                  })
                  const anchoredEstimatedPrompt =
                    anchorable && providerEstimate.confidence !== "whole" ? providerEstimate.estimatedTokens : undefined
                  if (anchorable) {
                    const observed = PromptEstimate.observe({
                      request: providerRequest,
                      usage,
                      scope: observationScope,
                      imagePatchPixels: routeProfile.imagePatchPixels,
                    })
                    if (observed !== undefined) providerPromptAnchor = observed
                  }
                  const comparable = reportedPrompt !== undefined && estimatedPrompt > 0
                  const remember = comparable
                    ? routeProfiles
                        .observe(
                          routeProfileScope,
                          {
                            estimatedTokens: estimatedPrompt,
                            reportedTokens: reportedPrompt!,
                            ...(anchoredEstimatedPrompt === undefined
                              ? {}
                              : { anchoredEstimatedTokens: anchoredEstimatedPrompt }),
                          },
                          servedBy,
                        )
                        .pipe(Effect.ignore)
                    : Effect.void
                  return remember.pipe(
                    Effect.andThen(
                      Log.event("session.context.estimate.drift", {
                        "session.id": session.id,
                        "provider.id": attemptModelRef.providerID,
                        "model.id": attemptModelRef.id,
                        "session.prompt.reported": reportedPrompt !== undefined,
                        "session.prompt.tokens": reportedPrompt ?? 0,
                        "session.estimated.tokens": estimatedPrompt,
                        "session.estimate.comparable": comparable,
                        "session.estimate.ratio": comparable
                          ? Math.round((reportedPrompt! / estimatedPrompt) * 100) / 100
                          : 0,
                      }),
                    ),
                  )
                },
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
      const runProviderStream = ProviderStreamLiveness.runForEach(
        budgetedSource.pipe(Stream.takeUntil(() => steerInterrupt)),
        harness.providerStallTimeoutMs,
        publisher.hasAssistantStarted,
        (event) =>
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
            //
            // 🔴 **CHARGE THE FAIRNESS LEDGER BEFORE RELEASING — the ordering `provider-dispatch.ts`
            // documents has to be honoured HERE, because this release is the one that happens.**
            // That file charges `report` then calls `release` and says why: both address the same
            // slot, and releasing first drains a waiter that then races the charge for this turn's
            // cost (`scheduler.release` → `drain`). But this release is strictly earlier — first
            // `tool-call` event, inside the stream — so on every tool-calling turn, which is every
            // agent turn, the dispatch's release was already a no-op and its stated guarantee never
            // held. A session that just spent a large turn was picked again by `drain()` against an
            // uncharged ledger.
            //
            // ⚠️ The turn's OUTPUT tokens are not known yet — usage arrives with the step settlement,
            // after the tool calls. What IS spent, provably, is the PROMPT: the model has produced a
            // tool call from it. So the prompt estimate is charged here and `costTokens` below reports
            // only the remainder, leaving the turn's total charge unchanged (`KernelEevdf.charge` is
            // additive). It is an ESTIMATE, calibrated by `routeProfile.promptFactor`; charging a
            // calibrated estimate a few hundred milliseconds early is the small error, and admitting
            // the next waiter against a ledger missing the whole turn is the large one.
            if (chargedTokens === 0 && outboundPromptTokens > 0) {
              chargedTokens = outboundPromptTokens
              yield* scheduler.report({ ...dispatchSlot, costTokens: chargedTokens })
            }
            yield* scheduler.release(dispatchSlot)
            // ⚠️ Taken HERE, at dispatch, and not inside the fiber below. See `imageBudget`'s own
            // comment: the stream's event handler is sequential and the settlements are not, so this
            // is the only point at which two calls in one turn can be told apart.
            const reservedImages = imageBudget.reserve()
            yield* Effect.uninterruptibleMask((restore) =>
              restore(
                toolMaterialization.settle({
                  sessionID: session.id,
                  agent: agent.id,
                  assistantMessageID,
                  // The model that ACTUALLY runs this turn, not the model merely configured before
                  // availability/health fallback. `self` consumes it, and the runner context-key
                  // ratchet test prevents this hand-off from silently losing it.
                  model: {
                    providerID: modelRef?.providerID ?? String(model.provider),
                    id: modelRef?.id ?? String(model.id),
                    ...(ran?.name === undefined ? {} : { name: ran.name }),
                  },
                  attachmentPaths,
                  // The mechanical half of the vision fix (`tool/tool.ts` → `imageBudget`). Counted
                  // PER ASSISTANT TURN, which is what makes it sound: within one turn there is no
                  // assistant text between tool calls, so every image past the cap is necessarily
                  // undescribed and `budgetImages` would elide one to fit it. `read` returns a
                  // sentence instead, the turn ends, the model describes what it holds — and the
                  // descriptions are what survive when the pixels later go.
                  // ⚠️ A DIRECT property, never a conditional spread. `resolveImageLimit` always
                  // answers with a number, so the spread's `undefined` arm was dead — and a spread
                  // is exempt from excess-property checking, which is exactly how this field spent
                  // its whole life being sent to a parameter type that did not declare it and
                  // dropped it. Written plainly, a name the receiver does not know is a type error.
                  imageBudget: { limit: modelImageLimit, held: reservedImages },
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
                    // The registry has already retained and mechanically bounded oversized output.
                    // Only the runner knows the selected model and its context, so semantic
                    // map/reduction happens here. A failed utility pass keeps the deterministic
                    // preview; a >4 MiB artifact never carries `semanticSummarySource` and therefore
                    // never reaches a model call at all.
                    const modelSettlement = yield* summarizeToolSettlement(
                      settlement,
                      model,
                      modelGuard,
                      session.id,
                      scheduledDevice,
                    )
                    // A pre-action policy halted. The call did not run; the refusal is already the
                    // tool result the model sees, and this latch is the half a `deny` does not have —
                    // it ends the drain rather than letting the model route around the refusal.
                    if (modelSettlement.halted === true) policyHalted = true
                    // Convert this call's RESERVATION into what it actually handed over, so a later
                    // call in the same turn sees a true count rather than an assumption. Counting
                    // the settled RESULT rather than the call is deliberate: a read that failed, was
                    // denied, or returned the withheld notice hands over no pixels and must not
                    // consume the budget. `release()` below then drops the reservation itself.
                    if (modelSettlement.result.type === "content")
                      imageBudget.handed(
                        modelSettlement.result.value.filter(
                          (entry) => entry.type === "file" && entry.mime.toLowerCase().startsWith("image/"),
                        ).length,
                      )
                    yield* deliverNudges(
                      session.id,
                      String(agent.id),
                      {
                        type: "tool",
                        id: event.id,
                        name: event.name,
                        input: event.input,
                        output: modelSettlement.result,
                      },
                      !ShortChat.enabled(config.shortChat),
                    )
                    // A missing file is authoritative negative evidence. If recalled memory led this
                    // exact step to that path, invalidate the claim before the next step recalls again.
                    // Re-stat instead of parsing the generic tool error: permission, binary, size, and
                    // transient I/O failures must never erase a valid memory.
                    if (
                      event.name === "read" &&
                      modelSettlement.result.type === "error" &&
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
                        result: modelSettlement.result,
                        output: modelSettlement.output,
                      }),
                      modelSettlement.outputPaths ?? [],
                    )
                  }),
                ),
              ),
            )
              // ⚠️ On EVERY exit, including a failed or interrupted settlement. A reservation that is
              // never dropped is a budget slot lost for the rest of the turn — conservative, but it
              // would make a dead fiber quietly withhold the next call's images.
              .pipe(Effect.ensuring(Effect.sync(imageBudget.release)), FiberSet.run(toolFibers))
          }),
      ).pipe(Effect.ensuring(withPublication(publisher.flush())))

      // A session worker may outlive the host process's in-memory catalog reload. Gate EVERY
      // network attempt (including ProviderDispatch retries) against the shared SQLite switch at
      // the last possible seam. When the chosen model was switched off, re-enter this same step so
      // model resolution selects an enabled substitute; no request reaches the disabled endpoint.
      const providerStream = models
        .guardDispatch(attemptModelRef, runProviderStream)
        .pipe(
          Effect.catchTag("SessionRunnerModel.ModelUnavailableError", () =>
            Effect.die(retryOnReplacedModel(currentStep)),
          ),
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
      const dispatchSlot = {
        sessionID: session.id as string,
        deviceKey: scheduledDevice.key,
        sessionClass: SessionScheduler.classForSessionType(config.type),
        ...(config.priority > 0 ? { priority: config.priority } : {}),
        ...(scheduledDevice.concurrency === undefined ? {} : { concurrency: scheduledDevice.concurrency }),
        ...(scheduledDevice.minRunMs === undefined ? {} : { minRunMs: scheduledDevice.minRunMs }),
        ...(scheduledDevice.locality === undefined ? {} : { locality: scheduledDevice.locality }),
      }
      const generation = (stream: Exit.Exit<void, LLMError>, restore: ProviderDispatch.Restore) =>
        Effect.gen(function* () {
          const failure =
            stream._tag === "Failure" ? Option.getOrUndefined(Cause.findErrorOption(stream.cause)) : undefined
          // ⚠️ AHEAD of the overflow arm, and the order is the decision. Compaction summarises TEXT
          // and removes not one image, so recovering an image-cap refusal that way would burn a
          // compaction and then fail again identically — with the history now shorter and the same
          // four images still in it.
          // 🔴 A MODEL THAT IS NOT THERE is an operational event, not the user's problem. Diverted
          // BEFORE anything is published, so the turn recovers instead of ending in a red block the
          // user has to read, understand and re-send past. Owner, 2026-09-03: *"such failure
          // shouldn't stop execution, but switch seamlessly."*
          //
          // ⚠️ `!publisher.hasAssistantStarted()` — the same guard the image-cap arm below uses, and
          // for the same reason: once tokens have reached the transcript a silent re-run would
          // duplicate them. A 404 lands before any output, so this is the ordinary case, not a
          // narrow one.
          //
          // ⚠️ Bounded by construction rather than by a counter. Each pass retires ONE model, and
          // `healthyAlternative` never routes onto a retired one, so an instance whose models are
          // all gone walks the list once and then stops — the last pass finds no replacement, falls
          // through, and reports the real fault.
          if (
            failure !== undefined &&
            !publisher.hasAssistantStarted() &&
            isModelMissing(String(failure.message ?? ""))
          ) {
            const dead = modelRef ?? { providerID: String(model.provider), id: String(model.id) }
            ModelHealth.retired(dead)
            const replacement = yield* models
              .resolve({ ...session, model: undefined }, { requested: false })
              .pipe(Effect.orElseSucceed(() => undefined))
            const ref =
              replacement === undefined
                ? undefined
                : ModelV2.Ref.make({
                    providerID: ProviderV2.ID.make(String(replacement.provider)),
                    id: ModelV2.ID.make(String(replacement.id)),
                  })
            if (ref !== undefined && `${ref.providerID}/${ref.id}` !== `${dead.providerID}/${dead.id}`) {
              // Written to the ROW, so the next process starts on the live model — module state does
              // not survive a turn (every turn drains in a fresh worker). The switch is a durable
              // event, so the transcript shows WHAT it moved to without an error beside it.
              yield* events
                .publish(SessionEvent.ModelSwitched, {
                  sessionID: session.id,
                  messageID: SessionMessage.ID.create(),
                  timestamp: yield* DateTime.now,
                  model: ref,
                })
                .pipe(Effect.ignore)
              yield* Log.event("session.model.retired", {
                "session.id": session.id,
                "model.retired": `${dead.providerID}/${dead.id}`,
                "model.used": `${ref.providerID}/${ref.id}`,
              })
              return yield* Effect.die(retryOnReplacedModel(currentStep))
            }
          }
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
          const recoveryFailure = overflowProviderError(overflowFailure ?? failure)
          const recoveryPlan =
            recoveryFailure === undefined
              ? undefined
              : OverflowRecoveryPolicy.plan({
                  failure: recoveryFailure,
                  // ⭐ THE PROVIDER'S OWN COUNT BEATS OUR ESTIMATE when it gave us one. It measured the
                  // exact request that failed; we approximated it. Measured 2026-09-14: the harness
                  // said 281,140 for a request the provider counted at 245,761 — 14 % high, which
                  // moved the 25 % cut target by ~8,800 tokens in the wrong direction and could make
                  // `authorizeRetry` reject a retry that would in fact have fitted.
                  originalPromptTokens: promptTokensFrom(recoveryFailure.message) ?? outboundPromptTokens,
                  recoveryAttempts: 0,
                })
          if (
            recoverOverflow &&
            !publisher.hasAssistantStarted() &&
            recoveryFailure !== undefined &&
            recoveryPlan?.action === "compress" &&
            (yield* restore(
              recoverOverflow({
                sessionID: session.id,
                scratchFolder: prepared.agent.id ? Scratch.forAgent(String(prepared.agent.id)) : undefined,
                entries,
                model,
                guard: modelGuard,
                request,
                imagePatchPixels: routeProfile.imagePatchPixels,
                /**
                 * ⚠️ **THE RECORD MUST NAME THE NUMBER THAT WAS ACTUALLY AVAILABLE.** This call site
                 * used to pass nothing, so the compactor fell back to `PromptEstimate.unsupported`
                 * — the raw heuristic with no anchor — and the durable row it wrote said
                 * `estimate.mode: "full"`, `anchor.fallback: "unsupported"`. Measured 2026-09-15
                 * (`ses_geryon`): a compatible anchor existed on the session, and the request it
                 * describes was recorded as 229,614 when the provider had counted it at 162,572.
                 * The same defect as the dispatch gate above, one layer down: a site that holds the
                 * anchored estimate and measures without it. No behaviour changes here — this input
                 * reaches the decision metadata only — but the row a person reads to answer "which
                 * number did it compare" must not report a fallback that never happened.
                 */
                promptEstimate: resolveOutbound(request),
                overflowPromptTokens: recoveryPlan.originalPromptTokens,
                overflowTargetTokens: recoveryPlan.targetPromptTokens,
              }),
            ))
          )
            return yield* Effect.die(
              continueAfterOverflowCompaction(currentStep, {
                plan: recoveryPlan,
                failure: recoveryFailure,
                failedRoute: routeProfileScope,
              }),
            )
          if (overflowFailure) yield* publish(overflowFailure)
          const llmFailure = failure instanceof LLMError ? failure : undefined
          if (
            llmFailure &&
            !publisher.hasProviderError() &&
            // ⚠️ A settlement the PROVIDER reported. `openai-chat`'s halt path now also synthesizes
            // one for a stream cut before its terminal event, and reason `"error"` is how it says
            // "nothing here was delivered" — the exact opposite of this branch's premise. Without
            // this test a truncated reply falls in here and is presented as finished.
            publisher.stepSettlement()?.finish !== undefined &&
            publisher.stepSettlement()?.finish !== "error" &&
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
            // …and the mirror of the note above: a synthesized `"error"` settlement means the halt
            // recovered nothing, so this IS the truncated-reply case and still needs a continuation.
            (publisher.stepSettlement() === undefined || publisher.stepSettlement()?.finish === "error") &&
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
            emptyResponse = true
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
          // ⚠️ Keyed on the model the turn RAN on, which `modelRef` now IS — it is read off
          // `Resolution.ran`, the catalog entry `resolve()` actually routed to after its fallbacks.
          // 🔴 **This comment used to say "never on `modelRef`" while the line below read
          // `modelRef ?? …`, and BOTH halves were right about something.** `models.ref` reported what
          // the session SELECTED, which after a fallback is the sick model rather than the one that
          // answered — so a successful turn on the healthy substitute cleared the SICK model's
          // record, the next turn went back to it, and the pair flapped one failed turn per cycle
          // forever. The prose named the hazard and the code walked into it, because the accessor's
          // meaning was the thing that was wrong. Fixing the accessor is what makes this line honest;
          // re-deriving an identity here would put the second answer back.
          // ⚠️ **CATALOG identity, and the wire id is a different string.** `fromCatalogModel` builds
          // the route with `id: model.api.id` — a model may deliberately route requests under an api
          // id while the catalog, the config and the user know it by another (`test-model` vs
          // `api-test-model` in `session-runner-model.test.ts`). `runner/model.ts` asks
          // `ModelHealth.sick(selected)` with the CATALOG entry, so recording under the wire id would
          // file every failure where nothing ever looks for it — the tracker would count forever and
          // the fallback would never fire. It happens to agree for `spark-holo/holo3.1`, which is
          // exactly why this survived being driven.
          const ranOn =
            modelRef ??
            ModelV2.Ref.make({
              providerID: ProviderV2.ID.make(String(model.provider)),
              id: ModelV2.ID.make(String(model.id)),
            })
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
          const providerFailureRetryable =
            llmFailure !== undefined
              ? ProviderRetry.isTransientProviderFailure(llmFailure)
              : publisher.assistantFailureRetryable()
          // A provider that explicitly rejected THIS request cannot recover by replaying the same
          // payload after a delay. Treating `retryable:false` as endpoint health made autonomous
          // sessions resubmit one malformed history forever (441 identical DeepSeek 400s live).
          const providerHalted = turnFailed && providerFailureRetryable === false
          // Replaying a failed pre-action turn on a substitute is safe. Replaying after a tool call
          // is not: the call may already have changed a file or sent a message, even if the provider
          // connection died before acknowledging the result.
          const reroutableProviderFailure =
            turnFailed &&
            !providerHalted &&
            !sawToolCall &&
            !(stream._tag === "Failure" && Cause.hasInterrupts(stream.cause))
          let providerFailureRecorded = false
          if (turnFailed) {
            // 🔴 An endpoint saying it does not HAVE this model is not a flaky turn, and counting it
            // as one is why a dead pin kept failing. The threshold exists because a transport blip is
            // weak evidence; a 404 naming the model is the endpoint telling us the catalog is wrong,
            // and the next turn will fail exactly the same way. Retiring it takes effect on the very
            // next resolution, with no threshold and no window, so a colleague on the default heals
            // itself instead of failing twice more first.
            //
            // ⚠️ Only the DEFAULT heals silently. `resolve` refuses to reroute a model the user named
            // (owner, 2026-09-02) — retiring it here is still right, because it is a fact about the
            // endpoint, but what the user sees is the error and the offer to switch.
            if (isModelMissing(publisher.assistantFailureMessage() ?? "")) {
              ModelHealth.retired(ranOn)
              // 🔴 CLEAR THE PIN, which is the half that actually heals.
              //
              // Retiring the model only steers the next RESOLUTION, and a session whose row pins the
              // dead model never reaches that decision: `resolveWithDevice` is called with
              // `requested: session.model !== undefined`, so a pinned session is treated as one the
              // user explicitly asked for and is deliberately not rerouted.
              //
              // ⚠️ And that pin is usually not a choice anybody made. Measured on a live instance:
              // a Companion chat carried `holo3.1` because that was the default the DAY THE CHAT WAS
              // CREATED, and it kept asking for it after the endpoint moved. The row is a snapshot,
              // not an instruction.
              //
              // `ModelSwitched.model` is nullable — the kernel's own event for "go back to
              // inheriting" — so clearing is a supported state rather than a hole punched in the
              // row. The next turn then resolves the live default, and the retirement above keeps
              // that resolution off the dead model even if it is still the default.
              //
              // The user is not kept in the dark: THIS turn already failed with the fault on screen,
              // and the switch is a durable event the transcript and the UI both show.
              // 🔴 RESOLVE THE REPLACEMENT HERE, and persist it — because in-memory health does not
              // survive this turn.
              //
              // Measured 2026-09-03: every turn drains in a FRESH session-worker process, so
              // `ModelHealth` (module state) starts empty each time. Turn 1 retired the model in
              // pid A; turn 2 resolved in pid B and saw `retired=false`. That is why the threshold
              // of two failures could never be reached either — the whole health mechanism is
              // invisible to itself across turns in this topology.
              //
              // The retirement IS live in this process, so asking the resolver now — with the pin
              // removed, which also drops the `requested` flag that suppresses rerouting — returns
              // the model the next turn should use. Writing that choice to the row is what makes it
              // durable: a session component, not a memory the next process will not have.
              const replacement = yield* models
                .resolve({ ...session, model: undefined }, { requested: false })
                .pipe(Effect.orElseSucceed(() => undefined))
              // ⚠️ The resolved model carries the LLM ROUTE's brands (`LLM.ProviderID`/`LLM.ModelID`),
              // not the catalog's. They are different vocabularies on purpose — the wire id and the
              // catalog id can differ — so the conversion is explicit here rather than a cast.
              const replacementRef =
                replacement === undefined
                  ? undefined
                  : ModelV2.Ref.make({
                      providerID: ProviderV2.ID.make(String(replacement.provider)),
                      id: ModelV2.ID.make(String(replacement.id)),
                    })
              const healed =
                replacementRef !== undefined &&
                `${replacementRef.providerID}/${replacementRef.id}` !== `${ranOn.providerID}/${ranOn.id}`
              // ⚠️ Nothing else can serve: leave the pin alone and let the fault stand. Clearing it
              // would only move the same failure to a different sentence, and the invariant the
              // owner asked for is explicitly conditioned on a model being available.
              if (healed || session.model !== undefined) {
                yield* events
                  .publish(SessionEvent.ModelSwitched, {
                    sessionID: session.id,
                    messageID: SessionMessage.ID.create(),
                    timestamp: yield* DateTime.now,
                    model: healed ? replacementRef! : null,
                  })
                  .pipe(Effect.ignore)
                yield* Log.event("session.model.retired", {
                  "session.id": session.id,
                  "model.retired": `${ranOn.providerID}/${ranOn.id}`,
                  "model.used": healed ? `${replacementRef!.providerID}/${replacementRef!.id}` : "none",
                })
              }
            } else {
              const failedAt = yield* Clock.currentTimeMillis
              ModelHealth.failed(ranOn, failedAt)
              providerFailureRecorded = yield* models.providerFailed(ranOn, failedAt)
            }
          } else if (!publisher.hasAssistantFailed()) {
            ModelHealth.succeeded(ranOn)
            yield* models.providerSucceeded(ranOn)
          }
          if (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) yield* FiberSet.clear(toolFibers)
          const settled = yield* restore(awaitToolFibers(toolFibers)).pipe(Effect.exit)
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
                  ...(providerPromptAnchor === undefined ? {} : { promptAnchor: providerPromptAnchor }),
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
          // A durable provider failure is now a routing fact, not the end of the drain. Its recovery
          // row was stored above; return it to the outer loop so the same user turn can resolve a
          // capability-compatible substitute. Failures with no durable verdict still propagate.
          if (
            stream._tag === "Failure" &&
            !handledResponseFailure &&
            !providerHalted &&
            !(reroutableProviderFailure && providerFailureRecorded)
          )
            return yield* Effect.failCause(stream.cause)
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
            emptyResponse,
            providerHalted,
            providerFailed: reroutableProviderFailure && providerFailureRecorded ? ranOn : undefined,
            maxProviderAttempts,
            offeredTools: toolMaterialization?.definitions.map((definition) => definition.name) ?? [],
            model,
            scheduledDevice,
            auditModel: reasoningModel ?? model,
            auditGuard,
            auditSlot:
              reasoningScheduledDevice === undefined
                ? dispatchSlot
                : {
                    sessionID: session.id as string,
                    deviceKey: reasoningScheduledDevice.key,
                    sessionClass: SessionScheduler.classForSessionType(config.type),
                    ...(config.priority > 0 ? { priority: config.priority } : {}),
                    ...(reasoningScheduledDevice.concurrency === undefined
                      ? {}
                      : { concurrency: reasoningScheduledDevice.concurrency }),
                    ...(reasoningScheduledDevice.minRunMs === undefined
                      ? {}
                      : { minRunMs: reasoningScheduledDevice.minRunMs }),
                    ...(reasoningScheduledDevice.locality === undefined
                      ? {}
                      : { locality: reasoningScheduledDevice.locality }),
                  },
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
          // The REMAINDER, not the total: a tool-calling turn already charged its prompt estimate at
          // the in-band release above, where the ordering `provider-dispatch.ts` documents is decided.
          // `KernelEevdf.charge` is additive and ignores a non-positive cost, so the turn's total is
          // the same whether it was charged in one part or two.
          costTokens: () => {
            if (publisher.hasProviderError()) return undefined
            const settlement = publisher.stepSettlement()
            if (settlement === undefined) return undefined
            const remainder = settlement.tokens.input + settlement.tokens.output - chargedTokens
            return remainder > 0 ? remainder : undefined
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
        /** This provider turn emitted no assistant output before its durable failure row was added. */
        readonly emptyResponse: boolean
        /** The provider explicitly said replaying this same request cannot succeed. */
        readonly providerHalted: boolean
        /** Failed before useful output; the drain may immediately resolve a compatible substitute. */
        readonly providerFailed: ModelV2.Ref | undefined
        readonly maxProviderAttempts: number
        readonly offeredTools: readonly string[]
        /** The exact route and scheduler placement this turn used; finish audit must judge like-for-like. */
        readonly model: Parameters<typeof LLM.request>[0]["model"]
        readonly scheduledDevice: SessionRunnerModel.ScheduledDevice
        /** Completion review is reasoning work: use the configured reasoning model when distinct. */
        readonly auditModel: Parameters<typeof LLM.request>[0]["model"]
        readonly auditGuard: SessionRunnerModel.DispatchGuard
        /** Critical-path audit admission; never the preemptible interactive-idle maintenance lane. */
        readonly auditSlot: SessionScheduler.AdmitInput
      },
      RunError
    >

    // ⚠️ The compaction re-entries below carry the SAME `harness` deliberately. A turn that overflows
    // and is retried over compacted history is still ONE turn — re-deriving mid-retry would let the
    // second attempt compose a different system prompt than the first, which is the within-turn
    // incoherence B7 is trying not to introduce. The next turn re-derives (see `run`).
    type RunTurnEffect = ReturnType<RunTurn>
    const runAfterOverflowCompaction: (
      sessionID: SessionSchema.ID,
      harness: Harness,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      recovery: OverflowRecovery,
      timing?: TurnTiming.Recorder,
    ) => RunTurnEffect = Effect.fnUntraced(function* (
      sessionID,
      harness,
      promotion,
      step,
      recovery,
      timing = TurnTiming.make(),
    ) {
      return yield* runTurnAttempt(sessionID, harness, promotion, step, undefined, recovery, timing).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            // A learned cap is applied by REBUILDING the request, which the ordinary re-entry does.
            // The row already names the replacement, so the ordinary re-entry re-resolves onto it —
            // the same mechanism the image cap uses, which also recovers by REBUILDING the request.
            if (defect.transition._tag === "RetryOnReplacedModel")
              return yield* runAfterOverflowCompaction(
                sessionID,
                harness,
                undefined,
                defect.transition.step,
                recovery,
                timing,
              )
            if (defect.transition._tag === "RetryUnderImageBudget")
              return yield* runAfterOverflowCompaction(
                sessionID,
                harness,
                undefined,
                defect.transition.step,
                recovery,
                timing,
              )
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* Effect.die("Post-compaction provider attempt cannot recover another overflow")
            yield* Effect.yieldNow
            return yield* runAfterOverflowCompaction(
              sessionID,
              harness,
              undefined,
              defect.transition.step,
              recovery,
              timing,
            )
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
        undefined,
        timing,
      ).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            yield* Effect.yieldNow
            if (defect.transition._tag === "RetryOnReplacedModel")
              return yield* runTurnAttempt(
                sessionID,
                harness,
                undefined,
                defect.transition.step,
                harness.compaction.compactAfterOverflow,
                undefined,
                timing,
              )
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* runAfterOverflowCompaction(
                sessionID,
                harness,
                undefined,
                defect.transition.step,
                defect.transition.recovery,
                timing,
              )
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
      const { session, model, scheduledDevice, entries } = prepared
      const routeProfile = yield* routeProfiles
        .resolve(
          {
            providerID: model.provider,
            wireModelID: model.id,
            serverKey: PromptEstimate.serverKey(model.route.endpoint?.baseURL, scheduledDevice.key),
            routeID: model.route.id,
            protocolID: model.route.protocol,
          },
          { safeDefault: { imagePatchPixels: Token.DEFAULT_IMAGE_PATCH_PIXELS } },
        )
        .pipe(
          Effect.orElseSucceed(() => ({
            promptFactor: 1,
            imagePatchPixels: Token.DEFAULT_IMAGE_PATCH_PIXELS,
          })),
        )
      // The compactor reads only `generation?.maxTokens` (else the model's own output limit)
      // from the request — a minimal envelope is enough.
      const request = LLM.request({ model, messages: [], tools: [] })
      // The branch that actually declined, so the notice below STATES it instead of guessing. The
      // shipped sentence asserted "still small enough … or the summary model was unavailable" for
      // every decline — including the one that means the chat is too LARGE to summarise in one pass,
      // so a user whose chat was wedged over its ceiling was told it was too small.
      let declined: SessionCompaction.DeclineReason | undefined
      const compacted = yield* compaction.compactAfterOverflow(
        {
          sessionID: session.id,
          scratchFolder: prepared.agent.id ? Scratch.forAgent(String(prepared.agent.id)) : undefined,
          entries,
          model,
          guard: SessionRunnerModel.dispatchGuard(models, prepared.ran),
          request,
          imagePatchPixels: routeProfile.imagePatchPixels,
          maintenance: {
            ownerID: session.id,
            task: "manual-compaction",
            deviceKey: scheduledDevice.key,
            ...(scheduledDevice.concurrency === undefined ? {} : { concurrency: scheduledDevice.concurrency }),
            ...(scheduledDevice.locality === undefined ? {} : { locality: scheduledDevice.locality }),
          },
          onDecline: (reason) => {
            declined = reason
          },
        },
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
          memoryOwner: prepared.memoryOwner,
          memory,
          session,
        }).pipe(reportArchiveFailure(session.id, prepared.memoryOwnerAgent))
      if (compacted) {
        const latest = yield* SessionHistory.latestCompaction(db, session.id)
        if (latest)
          yield* deliverNudges(
            session.id,
            prepared.config.agent,
            { type: "compaction", id: latest.id },
            !ShortChat.enabled(prepared.config.shortChat),
          )
      }
      yield* Log.event("session.compaction.manual.settled", { "session.id": session.id, compacted })
      if (!compacted)
        yield* events.publish(SessionEvent.Synthetic, {
          sessionID: session.id,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          text:
            declined === undefined
              ? "⚠️ Compaction didn't run — see the server log for details."
              : SessionCompaction.declineNotice(declined),
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
      routeProfiles,
      components,
    })

    const runBody = Effect.fn("SessionRunner.run.body")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly force: boolean
    }) {
      // The drives' cross-drain facts, from the store that outlives this drain (`drive-state.ts`).
      yield* hydrateDriveState(input.sessionID)
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
      // A provider recovery latch IS pending work even though it is not a `session_input` row. The
      // automatic boot/supervisor path wakes with `force=false`; checking only the two input queues
      // here made that replacement worker return successfully before it reached the recovery block
      // below. The executor then stamped the new lease `settled`, leaving the prior assistant turn's
      // tools permanently `running` and the task abandoned behind "A previous reply was interrupted".
      //
      // Keep this read above the no-work return. Manual `resume` uses `force=true`, which is why the
      // old recovery test passed while the shipped automatic path failed twice in the same live chat.
      const providerRecovery =
        (yield* SessionExecutionAttempt.providerRecoveryCurrent()) ??
        (yield* store.get(input.sessionID))?.providerRecovery
      let hasSteer = yield* SessionInput.hasPending(db, input.sessionID, "steer")
      const hasQueue = hasSteer ? false : yield* SessionInput.hasPending(db, input.sessionID, "queue")
      if (!input.force && !hasSteer && !hasQueue && providerRecovery === undefined) return
      // B10: live control handoff — when a human operator has taken control, Nova does NOT
      // auto-respond. Input still QUEUES durably (nothing lost); it drains the moment control
      // is handed back to nova. Resolve via the config walk so a child inherits the parent's
      // responder unless it overrides.
      const handoff = yield* effective.resolve(input.sessionID)
      if (handoff.responder === "operator") {
        yield* Log.event("session.control.operator", { "session.id": input.sessionID })
        return
      }
      // Targeted ambient hooks are evaluated only when this drain already has work. They never wake
      // an idle colleague just because the clock moved or the host crossed a pressure line.
      const now = new Date()
      const nudgesEnabled = !ShortChat.enabled(handoff.shortChat)
      const clockNudges = yield* deliverNudges(
        input.sessionID,
        handoff.agent,
        { type: "clock", at: now },
        nudgesEnabled,
      )
      const pressureLevel = yield* resourcePressure.level()
      let ambientNudges = clockNudges
      if (pressureLevel === "warning" || pressureLevel === "floor") {
        const event: Nudge.Event = {
          type: "resource",
          level: pressureLevel,
          bucket: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}T${String(now.getHours()).padStart(2, "0")}`,
          detail: yield* resourcePressure.inspect(),
        }
        ambientNudges += yield* deliverNudges(input.sessionID, handoff.agent, event, nudgesEnabled)
      }
      if (ambientNudges > 0 && !hasQueue) hasSteer = true
      if (providerRecovery) {
        const interruptedWaits = RecoveryJoin.interruptedChildIDs(yield* getContext(input.sessionID))
        const directChildren = new Set(yield* store.children(input.sessionID))
        const joinsToResume = interruptedWaits.filter((childID) => directChildren.has(SessionSchema.ID.make(childID)))
        yield* events.publish(SessionEvent.Synthetic, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          // Recovery is routine unless its circuit opens. Give the transcript renderer the same
          // provenance marker as the actionable steer below so routine notices fold; the repeated-
          // failure notice remains visible and carries the diagnosis when recovery actually loops.
          text: applySteerProvenance(
            joinsToResume.length > 0
              ? `Recovery resumed this work. A wait for ${joinsToResume.join(", ")} was interrupted; the child work was not cancelled.`
              : providerRecovery.toolProtocol
                ? "Recovery resumed this work. Inspect an interrupted tool's target before repeating it."
                : "Recovery resumed this work from its saved transcript.",
          ),
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
        // A replacement worker with no pending input exits successfully after closing the orphaned
        // provider attempt. That is process recovery but task abandonment: the user's work remains
        // stopped behind a reassuring banner. Admit the continuation DURABLY before clearing the
        // latch, and make inspection part of the steer so an uncertain tool is never blindly replayed.
        yield* SessionInput.steer(
          db,
          events,
          input.sessionID,
          joinsToResume.length > 0
            ? `A process loss interrupted your read-only wait for child ${joinsToResume.join(", ")}. ` +
                "The child sessions remain authoritative and were not cancelled. Before editing files or redoing any delegated slice, " +
                `call wait again for ${joinsToResume.join(", ")} and use the returned result. ` +
                "Only replace a child if wait reports that it ended without finishing. Continue the user's task; do not merely report the interruption."
            : "A process loss interrupted your previous reply. Continue the user's task now from the durable transcript. " +
                "Previously saved response content remains valid. Any in-flight tool was closed with an unknown outcome; " +
                "inspect the workspace or external target's current state before deciding whether to repeat it. Do not stop merely to report the interruption.",
        )
        // `promotion` and `shouldRun` below are derived from this snapshot. The recovery branch has
        // just changed the durable queue, so leaving the old `false` here passes the first no-work
        // gate only to stop at the second one.
        hasSteer = true
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
      // latch; 1N/A3 adds a consecutive-empty-turn counter.
      const nudged = new Set<string>()
      const nudgedTargets = new Set<string>()
      let consecutiveEmpty = 0
      /** How many times this drain has steered the turn back to the rest of a set. Bounded by
       *  `UnfinishedSet.MAX_STEER_ROUNDS` — an automatic drive needs a visible ceiling, exactly as
       *  the self-drive's own round cap does. */
      // Latched per drain: one re-prompt for a narrated-but-uncalled tool. A second would mean the
      // call cannot get through at all, which is the empty-turn diagnostic's territory.
      let announcedRecovered = false
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
      // ⚠️ The sibling gate `qualityOn` applies below (`!ShortChat.enabled`) was missing HERE, so a
      // Pure Chat session on an instance with quality enabled was steered to run the provisioner —
      // a tool call it can never make (`ShortChat.offered` withdraws every name; the permission
      // floor denies every action). Same class as the announced-tool nudge Xenia hit: an agentic
      // intervention fired at a session with no tool horizon.
      if (
        !ShortChat.enabled(handoff.shortChat) &&
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
      // A goal-oriented officer treats accepted exit as a checkpoint, not death. It sleeps after
      // closing the current work unit, and any newly admitted prompt wakes that sleep immediately.
      let acceptedGoalExit = false
      let providerHalted = false
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
          // A queued user message is work for the NEXT atomic boundary. `runTurn` does not return
          // until reasoning has ended and every locally executed tool call has settled, so this is
          // the first safe place to preempt an autonomous tool/continuation chain. Waiting for
          // `needsContinuation` to become false strands the queue behind a goal-oriented officer
          // that can keep producing tool turns indefinitely (measured live on ses_geryon).
          const queuedAtBoundary = yield* SessionInput.hasPending(db, input.sessionID, "queue")
          promotion = queuedAtBoundary ? "queue" : "steer"
          if (queuedAtBoundary) needsContinuation = true
          // The failed route's durable recovery row was written before `runTurn` returned. Resolve
          // the next turn immediately: while that route is inside its backoff window, model
          // resolution chooses a healthy substitute with matching declared capabilities.
          if (result.providerFailed) {
            needsContinuation = true
            continue
          }
          if (result.providerHalted) {
            providerHalted = true
            needsContinuation = false
            yield* Log.event("session.provider.halted", { "session.id": input.sessionID })
            break
          }
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
          brokenResponseAttempts = 0
          // F2 — the provider stopped this turn at its OUTPUT-TOKEN LIMIT (finish=length) and the
          // drain is not already continuing: the answer is truncated, not finished. This runs
          // BEFORE the heuristic nudge chain below and short-circuits it on purpose — those
          // branches (empty-turn recovery and textual-call) are guesses about
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
          const callsSinceLastUser = toolCallsSinceLastUser(context)
          // `exit` requests completion; it does not grant it. Review immediately after the tool has
          // settled, before the ordinary tool-result continuation can start another provider turn.
          // This is the sole healthy-path automatic steer: YES publishes the one durable completion
          // event, NO sends the reviewer-grounded continuation, and an unavailable/ambiguous reviewer
          // leaves the session open without inventing a verdict.
          const exitRequest = FinishAudit.exitRequest(context)
          if (exitRequest !== undefined) {
            // A background command is child work. Refuse completion mechanically before asking the
            // semantic auditor: a reviewer can judge the prose complete while an owned process is
            // still mutating the world. The next turn receives exact join/stop calls for every job.
            const runningShells = yield* BashJobs.listRunning(db, [input.sessionID])
            if (runningShells.length > 0) {
              yield* Log.event("session.finish.shells.restart", {
                "session.id": input.sessionID,
                "session.shells.running": runningShells.length,
              })
              yield* SessionInput.steer(db, events, input.sessionID, UnfinishedShells.exitNudge(runningShells))
              needsContinuation = true
              continue
            }
            const audit = yield* auditExit(
              input.sessionID,
              result.auditModel,
              result.auditGuard,
              result.auditSlot,
              context,
              exitRequest,
            ).pipe(
              Effect.catchCause((cause) =>
                Log.event("session.finish.audit.failed", {
                  "session.id": input.sessionID,
                  "session.cause": Log.fault(cause),
                }).pipe(Effect.as("unknown" as const)),
              ),
            )
            yield* Log.event("session.finish.audit", {
              "session.id": input.sessionID,
              "session.finish.audit.yes": audit === "yes",
              "session.finish.audit.no": audit === "no",
              // Without this third flag an unusable verdict reads as BOTH false, which is how the
              // defect above stayed invisible: "not yes and not no" looked like a state, not a failure.
              "session.finish.audit.unknown": audit === "unknown",
            })
            if (audit === "yes") {
              yield* events.publish(SessionEvent.ExitAccepted, {
                sessionID: input.sessionID,
                messageID: exitRequest.messageID,
                timestamp: yield* DateTime.now,
                result: exitRequest.result,
              })
              const completionTarget = yield* store.get(input.sessionID).pipe(Effect.orElseSucceed(() => undefined))
              if (completionTarget?.type === "goal-oriented") {
                acceptedGoalExit = true
                needsContinuation = false
                break
              }
              yield* events.publish(SessionEvent.Completed, {
                sessionID: input.sessionID,
                timestamp: yield* DateTime.now,
                result: exitRequest.result,
              })
              exitedMidDrain = true
              yield* Log.event("session.drain.exit", { "session.id": input.sessionID, step })
              break
            }
            if (audit === "no") {
              yield* SessionInput.steer(db, events, input.sessionID, FinishAudit.CONTINUE_NUDGE)
              needsContinuation = true
              continue
            }
          }
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
          if (harness.drives.set && !setRequests.has(input.sessionID)) {
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
                named: UnfinishedSet.requestedNames(firstText),
              })
            yield* flushDriveState(input.sessionID)
          }
          // 1E doom-loop break: only while the model is still acting (made a tool call).
          // If its last few tool calls are byte-identical, inject a one-shot redirect as a
          // steer so the next turn is nudged to change approach.
          if (result.needsContinuation) {
            consecutiveEmpty = 0 // 1N/A3: a tool call is genuine progress — re-arm empty-turn recovery.
            const looping = detectDoomLoop(callsSinceLastUser)
            const key = looping ? `${looping.name}\x00${looping.input}` : undefined
            if (looping && key !== undefined && !nudged.has(key)) {
              nudged.add(key)
              yield* SessionInput.steer(db, events, input.sessionID, redirectMessage(looping))
            }
            // 1N/A2: target-keyed failure streak over the tool calls made since the last user
            // message. Catches failed loops the byte-identical detector misses when a small model
            // rewords the same broken attempt.
            const streak = detectFailureStreak(callsSinceLastUser)
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
          } else {
            // Logged BEFORE the arms, so a run says which one it took. Measured 2026-08-20: a parent
            // made 66 read calls across 29 steps and `set.branch` never fired ONCE, and nothing in the
            // logs could say whether the drive declined or was never reached — the same trap that cost
            // this programme two days on the fan-out. The three predicates are computed once here and
            // the arms branch on the locals; until 2026-09-03 this log sat INSIDE an `else if` condition
            // with a body marked unreachable, and every arm below recomputed the predicates.
            const finishCalls = callsSinceLastUser.length
            // The provider-local fact outranks the transcript heuristic after useful work.
            // `failAssistant` turns an empty stream into an error-bearing assistant row, so history
            // cannot reconstruct that absence. An empty first response remains a provider failure;
            // there is no completed work for a completion auditor to judge.
            const finishEmpty = (result.emptyResponse && finishCalls > 0) || isEmptyAssistantTurn(context)
            // 🔴 A "go call that tool" recovery PRESUMES the model was GIVEN tools this turn. Pure
            // Chat (`shortChat`) materializes none — `ShortChat.offered` withdraws every name — so
            // `offeredTools` is the provider-local fact that no tool-call recovery has anything to
            // point at. Measured on Xenia: an ordinary chat reply ending "Let me check that."
            // matched the announce heuristic and was steered to issue a tool call she cannot have —
            // the same class as the QE-A provision nudge, an agentic intervention aimed at a
            // session with no tool horizon. The fact gates this arm AND the textual-call recovery
            // below (whose json-fence / tag / repeat / prose cues fire without consulting the
            // offered list). A tool-bearing agent's ordinary turn always materializes tools, so
            // this changes nothing for it; the step-capped turn (`isLastStep`) materializes none,
            // and a model given no tools this turn cannot be nudged to call one.
            const toolHorizon = result.offeredTools.length > 0
            const finishAnnounced = toolHorizon && announcedToolButCalledNone(context)
            yield* Log.event("session.finish.arm", {
              "session.id": input.sessionID,
              "session.finish.empty": finishEmpty,
              "session.finish.announced": finishAnnounced,
              "session.finish.tools": toolHorizon,
              "session.finish.calls": finishCalls,
            })
            if (finishEmpty) {
              // 1N/A3: the turn produced no text AND no tool call — typically a tool call streamed
              // into the reasoning channel and dropped by the server's parser. Inject ONE synthetic
              // re-prompt (re-armed on progress above); a SECOND consecutive empty means the re-prompt
              // isn't working, so stop and surface the server-side fix instead of looping silently.
              consecutiveEmpty++
              if (consecutiveEmpty === 1) {
                yield* Log.event("session.turn.empty.recovered", { "session.id": input.sessionID })
                yield* SessionInput.steer(
                  db,
                  events,
                  input.sessionID,
                  ShortChat.enabled(handoff.shortChat) ? EMPTY_TURN_RECOVERY_CHAT : EMPTY_TURN_RECOVERY,
                )
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
            } else if (finishAnnounced && !announcedRecovered) {
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
              const finalText = lastAssistantText(context)
              // The SILENT-NO-OP guard (notes/osint/silent-noop-bug.md): this branch means the turn ended
              // with text and NO tool call, which the runner otherwise settles as a finished answer. Three
              // live runs showed the model writing its call as MARKDOWN instead (a ```bash fence, an
              // invented adhoc-tool JSON, a repeated <thinking> block) and the run reporting SUCCESS having
              // done nothing — fatal for an unattended scheduled agent. Steer once; never execute what it
              // wrote (a ```bash fence is ordinary output, so running it would turn docs into execution).
              if (!textualNudged && toolHorizon) {
                // ⚠️ `toolHorizon`: `detect` consults the offered list only for the fenced-tool cue —
                // the json-fence, literal-tag, repeated-block and prose cues fire on a session with
                // ZERO tools offered, and the recovery message then demands "Issue the call
                // properly now" of a model that has no calls to issue. Same gate as the announced arm.
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
              // before the generic silent-response handling because a one-call partial answer need not SAY it is unfinished,
              // and because naming the unopened files is a stronger instruction than asking the model
              // to walk its own acceptance criteria. See `unfinished-set.ts` for why every clause is a
              // case that must not fire.
              // ⚠️ Ordered so an ordinary turn does NO work: the user's wording and the turn's own
              // tool calls are both in memory, and the folder is only read once both say a set was
              // asked for and partly covered. `groundingListing` itself lives in the per-provider-turn
              // scope and is not visible here.
              // `lastRealUserText` answers undefined for a files-only prompt (no words to read a set from).
              // Latched on the first turn that HAS a real user text, then never re-derived: after
              // compaction the honest answer to "what did the user ask?" is no longer in the window,
              // and asking again returns a confident wrong answer rather than an absent one.
              const realUserText = lastRealUserText(context)
              if (harness.drives.set && !setRequests.has(input.sessionID) && realUserText !== undefined)
                setRequests.set(input.sessionID, {
                  // Same exemption as the sibling latch above — see its note.
                  asked: UnfinishedSet.asksForSet(realUserText) && !UnfinishedSet.asksToDelegate(realUserText),
                  ...(UnfinishedSet.requestedLimit(realUserText) === undefined
                    ? {}
                    : { limit: UnfinishedSet.requestedLimit(realUserText) }),
                  named: UnfinishedSet.requestedNames(realUserText),
                })
              if (harness.drives.set) yield* flushDriveState(input.sessionID)
              const setRequest = setRequests.get(input.sessionID)
              const askedForSet = setRequest?.asked ?? false
              // ⚠️ Logged BEFORE either gate. `set.considered` fires only after both pass, so a run that
              // logs it once cannot tell "the branch never ran" from "it ran and declined" — which is
              // exactly the question the 100-icon run left open.
              if (harness.drives.set)
                yield* Log.event("session.finish.set.branch", {
                  "session.id": input.sessionID,
                  "session.set.asked": askedForSet,
                  "session.set.calls": finishCalls,
                })
              const readsThisTurn = askedForSet
                ? callsSinceLastUser.flatMap((call) => {
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
                      return path.length > 0 ? [{ path, failed: call.failed }] : []
                    } catch {
                      // A malformed argument is not a read we can attribute to a file.
                      return []
                    }
                  })
                : []
              /**
               * The reads that SUCCEEDED — what the session has actually seen.
               *
               * Only successful reads count as coverage. A read that errored returned no file, so the
               * `session.set.opened` log field must not claim it was seen.
               */
              const openedThisTurn = readsThisTurn.filter((read) => !read.failed).map((read) => read.path)
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
                // 🔴 SUCCESSFUL reads only. A file the model tried and failed to read has not been
                // seen, and must stay in the set the steer names.
                for (const name of openedThisTurn) opened.add(name)
                setOpened.set(input.sessionID, opened)
                // ⚠️ EVERY read, failed or not — this derives the DIRECTORY, and a failed read still
                // says where the model is working. See `setAttempted`.
                const attempted = setAttempted.get(input.sessionID) ?? new Set<string>()
                for (const read of readsThisTurn) attempted.add(read.path)
                setAttempted.set(input.sessionID, attempted)
                yield* flushDriveState(input.sessionID)
                const setDir = UnfinishedSet.resolveSetDirectory(location.directory, [...attempted])
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
                  // 🔴 The request's own NAMES outrank both the count and the folder — see
                  // `UnfinishedSet.scopeAvailable`. Without this a delegated child assigned ten of a
                  // hundred files is driven against all hundred (measured 2026-08-31, ten children,
                  // seven still working after global coverage hit 100/100), and a count is applied as
                  // an alphabetical PREFIX, which is the right ten for one child in ten.
                  available: UnfinishedSet.scopeAvailable({
                    listing: allNames,
                    named: setRequest?.named ?? [],
                    limit: requested,
                  }),
                  // ⚠️ The accumulated set, never `openedThisTurn` — that is one window's worth and it
                  // shrinks under compaction. See `setOpened`.
                  opened: [...opened],
                }
                // ⚠️ Logged at the DECISION, not after it. This check has now failed to fire twice on
                // runs it was built for, and each time the cause was invisible afterwards — the same
                // trap that cost this programme two days on the fan-out. One line names every clause.
                yield* Log.event("session.finish.set.considered", {
                  "session.id": input.sessionID,
                  "session.set.available": setCoverage.available.length,
                  "session.set.opened": setCoverage.opened.length,
                  "session.set.rounds": 0,
                })
                // Counted BEFORE the decision: a round that opened nothing new is barren whether or not
                // the drive goes on to steer again.
                // Session-scoped: a drain-local counter resets on every steer and can never reach the
                // bound. See `setBarrenBySession`.
                const barrenState = setBarrenBySession.get(input.sessionID) ?? { barren: 0, lastOpened: 0 }
                barrenState.barren = setCoverage.opened.length > barrenState.lastOpened ? 0 : barrenState.barren + 1
                barrenState.lastOpened = Math.max(barrenState.lastOpened, setCoverage.opened.length)
                setBarrenBySession.set(input.sessionID, barrenState)
                yield* flushDriveState(input.sessionID)
              }
              /**
               * 🔴 **THE FAN-OUT SUPERVISOR — a child that was never joined.**
               *
               * Measured 2026-08-27 on the delegated 100-file run `4623-S2`: `spawn:10` against
               * `wait:9` and `exit:9`. Ten children started, nine joined, one launched and never
               * accounted for — and the run completed, reported success, and surfaced nothing. ⭐ The
               * nine successes are what hide the tenth: a merge of nine slices of ten has no ragged
               * edge to notice.
               *
               * A model missing a whole slice cannot honestly claim the delegated whole; the child
               * arithmetic is completion evidence, not an inferred confidence signal.
               *
               * ⚠️ Runs on EVERY finished turn rather than behind a delegation cue, because the
               * evidence that this task delegated is its successful `spawn` outputs, retained across
               * drains and confirmed against one indexed `WHERE parent_id = ?` query. Reading the
               * user's prompt for a cue is the substring hazard `unfinished-set.ts` paid 835,145
               * tokens to learn. A task with no spawned children skips the supervisor.
               */
              // ⚠️ Gated BEFORE the query for the same reason: `off` must not pay for an indexed read
              // it will throw away.
              // A colleague's root session is a durable chat, so `store.children(session)` is an
              // all-history inventory. The supervisor is request-scoped: only successful `spawn`
              // results after the latest REAL user message create an obligation for this answer.
              // Accumulate those ids into host state because compaction can later remove the tool
              // call from the runner window while the same request is still active.
              const userIndex = lastRealUserIndex(context)
              const currentChildTask = userIndex < 0 ? undefined : context[userIndex]?.id
              const priorChildTask = childrenTask.get(input.sessionID)
              if (currentChildTask !== undefined && currentChildTask !== priorChildTask) {
                childrenTask.set(input.sessionID, currentChildTask)
                childrenSpawned.set(input.sessionID, new Set())
                childrenJoined.set(input.sessionID, new Set())
                childRestartRounds.set(input.sessionID, 0)
              }
              const spawned = childrenSpawned.get(input.sessionID) ?? new Set<string>()
              // With no task anchor and no retained state (for example, a restart after compaction),
              // silence is safer than attaching an arbitrary historical spawn trail to this answer.
              if (currentChildTask !== undefined || priorChildTask !== undefined) {
                for (const call of callsSinceLastUser) {
                  if (call.name !== SpawnTool.name || call.failed) continue
                  const childID =
                    typeof call.structured === "object" &&
                    call.structured !== null &&
                    "childID" in call.structured &&
                    typeof call.structured.childID === "string"
                      ? call.structured.childID
                      : undefined
                  if (childID !== undefined) spawned.add(childID)
                }
              }
              childrenSpawned.set(input.sessionID, spawned)
              yield* flushDriveState(input.sessionID)
              const directKids =
                harness.drives.children && spawned.size > 0
                  ? yield* store.children(input.sessionID).pipe(Effect.orElseSucceed(() => []))
                  : []
              // Intersect the transcript-derived ids with the durable parent relation: neither a
              // malformed tool result nor a child from another parent can become this task's debt.
              const kids = directKids.filter((id) => spawned.has(id))
              if (kids.length > 0) {
                // ⚠️ Accumulated into the SESSION's set, never read fresh from the window — see
                // `childrenJoined`. `wait` carries the child id in its input and a terminal marker in
                // its persisted structured output, so a live timeout is not mistaken for a join.
                const joined = childrenJoined.get(input.sessionID) ?? new Set<string>()
                for (const call of callsSinceLastUser) {
                  if (
                    call.name !== WaitTool.name ||
                    call.failed ||
                    !UnjoinedChildren.isTerminalWaitResult(call.structured)
                  )
                    continue
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
                yield* flushDriveState(input.sessionID)
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
                  const slice =
                    title !== undefined && title !== "" && !SessionTitle.isDefault(title) ? title : undefined
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
                  yield* flushDriveState(input.sessionID)
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
            // Close the small race after `queuedAtBoundary`: post-turn harness work can take long
            // enough for a user message to arrive. The same next-turn rule applies here too.
            const queuedAfterChecks = yield* SessionInput.hasPending(db, input.sessionID, "queue")
            if (queuedAfterChecks) {
              needsContinuation = true
              promotion = "queue"
            } else if (!needsContinuation) {
              needsContinuation = yield* SessionInput.hasPending(db, input.sessionID, "steer")
            }
          }
        }
        // F2: the truncation halt ends the RUN, not just the inner step loop — otherwise the
        // queue promotion or the self-drive continuation below would immediately steer the same
        // starved model straight back into the same wall, and the two-strike bound would be
        // decorative. Pending input is safe for the same reason it is safe on the exit path.
        if (exitedMidDrain || truncationHalted || policyHalted || providerHalted) break
        shouldRun = yield* SessionInput.hasPending(db, input.sessionID, "queue")
        promotion = shouldRun ? "queue" : undefined
        if (!shouldRun) {
          const driveConfig = yield* effective.resolve(input.sessionID)
          if (ShortChat.enabled(driveConfig.shortChat)) break
          // The auto-prompt SELF-DRIVE (architecture.md "run until exit()"): an auto-prompting /
          // goal-oriented session whose queue ran dry keeps working — the harness injects the next
          // prompt as a provenance-prefixed steer. Accepted exit terminates an auto-prompting run;
          // for a goal-oriented officer it closes the visible work unit and starts an interruptible
          // ten-minute sleep instead. Keyed on the session's OWN declared type (never the inherited walk) so
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
          const officer = latest?.agent === undefined ? undefined : yield* agents.get(AgentV2.ID.make(latest.agent))
          const officerGoal = officer?.goal
          const decision = SessionDrive.decide(latest, driveState, DateTime.toEpochMillis(yield* DateTime.now), {
            acceptedExit: acceptedGoalExit,
            // ⚠️ Through the SAME helper the system prompt uses (`assignedGoal`), so the goal a session
            // is steered by and the goal it is shown cannot be two different things.
            goal: SessionDrive.assignedGoal({ officerGoal, component: goalEntry?.value }),
            steps: planEntries.map((entry) => {
              const value = entry.value as SessionComponentRegistry.PlanStep
              return { text: value.text, status: value.status, verdict: value.verdict }
            }),
          })
          if (decision.kind === "sleep") {
            const heartbeatMinutes = officer?.runtimeHeartbeatMinutes ?? OwnedRuntimeContext.DEFAULT_HEARTBEAT_MINUTES
            const ownedRuntime = yield* OwnedRuntimeContext.observe({
              db,
              sessionID: input.sessionID,
              heartbeatMinutes,
            })
            const sleepMilliseconds = OwnedRuntimeContext.sleepMilliseconds({
              ordinaryMilliseconds: decision.milliseconds,
              heartbeatMinutes,
              observation: ownedRuntime,
            })
            const next = Date.now() + sleepMilliseconds
            yield* events
              .publish(SessionStatusEvent.Status, {
                sessionID: input.sessionID,
                status: {
                  type: "retry",
                  attempt: 1,
                  message: "Waiting for the environment to change…",
                  next,
                },
              })
              .pipe(Effect.ignore)
            yield* Log.event("session.drive.sleep", {
              "session.id": input.sessionID,
              milliseconds: sleepMilliseconds,
            })
            // No provider request or scheduler slot is held here. Stop interrupts this wait. A new
            // message wakes it early (the event is instant; the bounded queue probe closes the tiny
            // check/subscribe race). An external change with no event is retried at the ordinary
            // ten-minute recheck, tightened to the configured live-work heartbeat while work exists.
            let remaining = sleepMilliseconds
            let wokeForInput = false
            while (remaining > 0 && !wokeForInput) {
              const pendingSteer = yield* SessionInput.hasPending(db, input.sessionID, "steer")
              const pendingQueue = pendingSteer ? false : yield* SessionInput.hasPending(db, input.sessionID, "queue")
              if (pendingSteer || pendingQueue) {
                wokeForInput = true
                break
              }
              const slice = Math.min(5_000, remaining)
              wokeForInput = yield* Effect.race(
                events.subscribe(SessionEvent.PromptAdmitted).pipe(
                  Stream.filter((event) => event.data.sessionID === input.sessionID),
                  Stream.runHead,
                  Effect.as(true),
                ),
                Effect.sleep(Duration.millis(slice)).pipe(Effect.as(false)),
              )
              remaining -= slice
            }
            driveState.rounds = 0
            driveState.stagnantRounds = 0
            acceptedGoalExit = false
            if (wokeForInput) {
              const pendingSteer = yield* SessionInput.hasPending(db, input.sessionID, "steer")
              shouldRun = pendingSteer || (yield* SessionInput.hasPending(db, input.sessionID, "queue"))
              promotion = shouldRun ? (pendingSteer ? "steer" : "queue") : undefined
            } else {
              yield* SessionInput.steer(db, events, input.sessionID, decision.message)
              shouldRun = true
              promotion = "steer"
            }
          }
          if (decision.kind === "continue") {
            driveState.rounds++
            yield* Log.event("session.drive.continue", {
              "session.id": input.sessionID,
              round: driveState.rounds,
            })
            yield* SessionInput.steer(db, events, input.sessionID, decision.message)
            shouldRun = true
            promotion = "steer"
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
      // Derive the terminal lifecycle from the durable row and ALWAYS publish it. The previous
      // `if result is absent, publish idle; otherwise publish nothing` relied on exit's tool fiber
      // having won an event-ordering race against later snapshot timing. On a real long turn the
      // snapshot's final `busy` landed after `exited`, and every outer finalizer skipped its chance
      // to repair the lie for exactly the same reason.
      const settled = yield* store.get(input.sessionID).pipe(Effect.orElseSucceed(() => undefined))
      yield* events
        .publish(SessionStatusEvent.Status, {
          sessionID: input.sessionID,
          status: { type: settled?.result === undefined ? "idle" : "exited" },
        })
        .pipe(Effect.ignore)
      yield* maintenance.postRun(input.sessionID)
    })

    const run = Effect.fn("SessionRunner.run")(
      (input: { readonly sessionID: SessionSchema.ID; readonly force: boolean }) =>
        // The store's pin outranks the local caches' sweep: under the worker executor the host
        // pins the whole drain, and this inner call is the in-process executor's own pin.
        driveState.withSession(input.sessionID, sessionMapRetention.withSession(input.sessionID, runBody(input))),
    )

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
    ModelRouteProfileStore.node,
    SessionMaintenance.node,
    SessionStore.node,
    SessionEffectiveConfig.node,
    Location.node,
    SystemContextRegistry.node,
    ReferenceGuidance.node,
    AdhocGuidance.node,
    Config.node,
    Snapshot.node,
    SessionScheduler.node,
    SessionCompactionRequest.node,
    Database.node,
    AppProcess.node,
    WorldMemory.node,
    SessionDriveState.node,
    // Strict's host-execution context (ruling 6): the messenger trust of the chain + the shared
    // OFF-C policy. Both are global nodes, so this adds no per-location state.
    MessengerStore.node,
    Offline.node,
    // The quality gate executes persisted (possibly model-supplied) commands through the agent
    // shell, so it asserts `bash` like every other execution surface — see `runQualityCheck`.
    PermissionV2.node,
    PluginV2.node,
    SessionComponentRegistry.node,
    NudgeService.node,
    ResourcePressureContext.node,
  ],
})
