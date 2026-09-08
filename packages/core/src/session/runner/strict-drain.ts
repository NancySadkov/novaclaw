export * as StrictDrain from "./strict-drain"

import { LLM, LLMEvent, Message, SystemPart, type LLMClientShape } from "@novaclaw/llm"
import { Cause, DateTime, Deferred, Duration, Effect, Fiber, Stream } from "effect"
import fs from "node:fs"
import { Log } from "@novaclaw/schema/log"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { Location } from "../../location"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import { HostExec } from "../../host-exec"
import { MessengerStore } from "../../messenger/store"
import { Offline } from "../../offline"
import { Snapshot } from "../../snapshot"
import type { RelativePath } from "../../schema"
import { JhStore } from "../../jh/store"
import type { JhEngine } from "../../jh/engine"
import { rootSessionType, stanceOf, type EffectiveConfig } from "../config-resolve"
import { SessionEvent } from "../event"
import { SessionExecutionAttempt } from "../execution-attempt"
import { SessionInput } from "../input"
import { SessionMessage } from "../message"
import { SessionPlan } from "../plan"
import type { SessionComponentRegistry } from "../component-registry"
import { SessionScheduler } from "../scheduler"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { ContextBudget } from "./context-budget"
import { HarnessConfig } from "./harness-config"
import { SessionMaintenance } from "./maintenance"
import { SessionRunnerModel } from "./model"
import { createLLMEventPublisher } from "./publish-llm-event"
import { ProviderDispatch } from "./provider-dispatch"
import { ProviderRetry } from "./provider-retry"
import { SessionStrict } from "./strict"
import { ModelRouteProfileStore } from "./model-route-profile-store"
import { PromptEstimate } from "./prompt-estimate"
import { Token } from "../../util/token"

type Harness = Pick<HarnessConfig.Derived, "configuredShell" | "context" | "quality" | "strict">

export interface Dependencies {
  readonly events: EventV2.Interface
  readonly llm: LLMClientShape
  readonly models: SessionRunnerModel.Interface
  readonly store: SessionStore.Interface
  readonly location: Location.Interface
  readonly snapshots: Snapshot.Interface
  readonly messengerStore: MessengerStore.Interface
  readonly offline: Offline.Interface
  readonly maintenance: SessionMaintenance.Interface
  readonly scheduler: SessionScheduler.Interface
  readonly db: Database.Interface["db"]
  readonly routeProfiles: ModelRouteProfileStore.Interface
  /** The component registry: `SessionPlan.projectJh` writes the goal and plan through it. */
  readonly components: SessionComponentRegistry.Interface
}

/**
 * The scheduler identity of ONE generation.
 *
 * ⚠️ The scheduler keys a slot by `slot.sessionID` and `admit` is idempotent per that id, so N
 * concurrent generations sharing one id are counted as **1**: `device.concurrency` is enforced
 * against one participant, and the FIRST of them to settle releases the slot for all of them —
 * admitting a waiting turn while N−1 generations are still on the wire. Anything that fans out
 * completions (best-of-N racing) therefore gives each fan-out branch its own slot identity, the
 * same rule `SessionScheduler.admitMaintenance` states for overlapping maintenance work.
 *
 * This is NOT a decision to serialize: a device is not single-threaded (AGENTS.md, Devices) and the
 * cap is a policy we choose. The defect it closes is a cap that was advertised and then bypassed.
 */
export const attemptSlot = (slot: SessionScheduler.AdmitInput, attempt: number): SessionScheduler.AdmitInput => ({
  ...slot,
  sessionID: `${slot.sessionID}#a${attempt}`,
})

/**
 * One Strict engine per FOLDER.
 *
 * The invariant is about a DIRECTORY, so this is what enforces it — one instance per Location, held
 * for as long as the engine's own fiber lives. `enter` is a test-and-set inside a single
 * `Effect.suspend`: reading the token, claiming it and starting the fiber that owns it happen with
 * no step boundary between them, so two callers can never both find the folder free. `undefined`
 * means the folder is already claimed and the caller must refuse — the holder is the engine's
 * DETACHED fiber, which outlives a Stop by design and must keep the folder for exactly that long.
 *
 * 🔴 IN-PROCESS ONLY. Production runs one disposable child process per drain
 * (`session-worker/execution.ts`), so two SESSIONS are two processes and neither sees the other's
 * token. Closing this across processes needs a cross-process lock (`util/flock.ts`, keyed on the
 * directory); that is filed, and this is the seam it slots into.
 */
export const folderExclusion = () => {
  let held: Deferred.Deferred<void> | undefined
  return {
    /** Advisory read — for a message, never for a decision. `enter` is what decides. */
    busy: () => held !== undefined,
    enter: (run: Effect.Effect<void>): Effect.Effect<Fiber.Fiber<void> | undefined> =>
      Effect.suspend((): Effect.Effect<Fiber.Fiber<void> | undefined> => {
        if (held !== undefined) return Effect.succeed(undefined)
        const token = Deferred.makeUnsafe<void>()
        held = token
        return Effect.forkDetach(
          run.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (held === token) held = undefined
                Deferred.doneUnsafe(token, Effect.void)
              }),
            ),
          ),
        )
      }),
  }
}

/**
 * Build the Strict drain for one Location-scoped runner.
 *
 * The folder exclusion and the per-session tail deliberately live inside this constructor: they are
 * runtime state owned by one location, while every dependency is passed explicitly. That makes
 * Strict a real collaborator behind the runner seam instead of a second engine hidden in llm.ts's
 * closure.
 */
export const make = (dependencies: Dependencies) => {
  const {
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
  } = dependencies
  const getSession = Effect.fn("StrictDrain.getSession")(function* (sessionID: SessionSchema.ID) {
    const session = yield* store.get(sessionID)
    if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
    return session
  })
  const getContext = Effect.fn("StrictDrain.getContext")(function* (sessionID: SessionSchema.ID) {
    return yield* store.context(sessionID)
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
  //
  // ⚠️ TWO ENGINES MUST NEVER WORK THE SAME FOLDER. That is a claim about a DIRECTORY, so what
  // enforces it is keyed by the directory (`folderExclusion`, above). It used to be a `Map` keyed by
  // session id, which answers a different question entirely ("has THIS session left a straggler?"),
  // and two chats open on one project therefore both started an engine against the same working
  // tree. `make` runs once per Location (`llm.ts` builds the runner as a location node), so
  // `location.directory` is invariant across every session this closure serves — one exclusion IS
  // the folder's lock.
  const folder = folderExclusion()
  // The tail of ONE session's own previous run: a stopped run finalizes on a detached fiber, and
  // that fiber is still writing this session's JhStore rows — which the next drain reads to decide
  // resume. A per-SESSION question, so a per-session key is the right one here.
  const sessionTail = new Map<SessionSchema.ID, Fiber.Fiber<void>>()
  return Effect.fn("SessionRunner.strictDrain")(function* (
    sessionID: SessionSchema.ID,
    harness: Harness,
    resolved: EffectiveConfig,
    first: SessionInput.Delivery | undefined,
  ) {
    const notice = (text: string, repair?: SessionMessage.SyntheticRepair) =>
      Effect.gen(function* () {
        yield* events.publish(SessionEvent.Synthetic, {
          sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          text,
          repair,
        })
      }).pipe(Effect.ignore)
    const session = yield* getSession(sessionID)
    const modelSession = { ...session, model: resolved.model as typeof session.model, device: resolved.device }
    const selected = yield* models
      .resolveWithDevice(modelSession)
      .pipe(
        Effect.catch((error: unknown) =>
          notice(
            error instanceof SessionRunnerModel.DevicePinError
              ? `⚠️ This turn couldn't run — ${error.message}.`
              : `⚠️ Strict mode couldn't run — the session's model is unavailable (${error instanceof Error ? error.message : String(error)}).`,
            error instanceof SessionRunnerModel.DevicePinError
              ? { type: "unpin-device", device: error.deviceID }
              : undefined,
          ).pipe(Effect.as(undefined)),
        ),
      )
    if (selected === undefined) return "handled" as const
    const model = selected.model
    // The route's HONORED context window. `completeOnce` below already hands it to
    // `ProviderDispatch.prepare` as `contextSize`, but packing cannot save the Strict route — the engine's
    // prompt is ONE `Message.user`, so there is nothing to evict and `dropped` is always 0. So the same
    // number goes to the engine, which budgets the workspace render where it is BUILT.
    const contextTokens = model.route.defaults.limits?.context
    const maxProviderAttempts = ProviderRetry.maxAttempts(yield* models.retryAttempts(modelSession))
    const scheduledDevice = selected.device
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
          prefixCacheRetentionTokens: undefined,
        })),
      )
    const dispatchSlot = {
      sessionID: session.id as string,
      deviceKey: scheduledDevice.key,
      sessionClass: SessionScheduler.classForSessionType(resolved.type),
      ...(resolved.priority > 0 ? { priority: resolved.priority } : {}),
      ...(scheduledDevice.concurrency === undefined ? {} : { concurrency: scheduledDevice.concurrency }),
      ...(scheduledDevice.locality === undefined ? {} : { locality: scheduledDevice.locality }),
    }
    // ⚠️ ONE GENERATION = ONE PARTICIPANT ON THE DEVICE. The scheduler's identity for a slot is
    // `slot.sessionID`, and `admit` is idempotent per that id: N generations sharing one id are
    // counted as 1, so `device.concurrency` is enforced against 1 — and the FIRST of them to settle
    // releases the slot for all N, admitting a waiting interactive turn while N−1 are still on the
    // wire. Best-of-N racing (`strict.attempts`, up to 8) fans out exactly that way, so each racer
    // takes its own slot identity. This is the same rule `scheduler.admitMaintenance` already
    // states for overlapping maintenance work ("a fresh identity per invocation prevents the
    // scheduler's idempotent re-admit rule from turning that overlap into uncounted device
    // concurrency") — racing is that overlap under another name.
    //
    // Serializing is NOT what this buys: a device is not single-threaded (AGENTS.md, Devices), and
    // the cap is a POLICY. The defect was that the policy was stated and then bypassed. An
    // interactive race now holds N interactive slots and frees the device only when the last one
    // settles; a batch-class race queues its racers past the device's declared ceiling instead of
    // running 8 completions against a cap of 2.
    //
    // 🔴 SCOPE: in production the worker's scheduler is an RPC bridge and the HOST substitutes the
    // fenced lease's session id for whatever the worker sent (`session-worker/device-bridge.ts`:
    // "Worker-supplied session IDs never reach the scheduler"), so these identities collapse back
    // to one there. Carrying a per-generation discriminator across that boundary — the way
    // `admitMaintenance` already carries a host-minted `maintenanceID` — is the other half, and it
    // is filed. The seam is correct here, and correct for every in-process executor.
    const slotFor = (attempt: number) => attemptSlot(dispatchSlot, attempt)
    const promptCacheKey = /^ses_[0-9a-f]{64}$/.test(session.id) ? session.id.slice(4) : session.id
    const thinkingBudget = resolved.reasoningBudget ?? model.route.defaults.limits?.thinkingBudget ?? 0
    const budgetEnforced = stanceOf("thinkingBudget", resolved.thinkingBudget)
    // The engine's one-shot completion (the judgeCompletion idiom). The budget is per-CALL and comes
    // from ConfigStrict: execution steps need a whole non-trivial source file of headroom (jh.md §3
    // "Measured": a C program is ~13-15k tokens; truncation is fatal), and reasoning steps need room
    // to CLOSE their think block or they return empty (notes/jh/think-stage.md). The user owns both
    // numbers because only they know what their served context can afford.
    // `slot` is REQUIRED, so a caller that fans out cannot reach the device without saying which
    // participant it is: the shared `dispatchSlot` has to be named, and naming it once per racer is
    // the wrong-looking call rather than the shorter one.
    const completeOnce = (slot: SessionScheduler.AdmitInput, system: string, user: string, maxTokens: number) =>
      Effect.gen(function* () {
        const text: string[] = []
        const reasoning: string[] = []
        let costTokens: number | undefined
        const ordinaryRequest = LLM.request({
          model,
          system: [SystemPart.make(system)],
          messages: [Message.user(user)],
          tools: [],
          generation: { maxTokens },
        })
        const prepared = ProviderDispatch.prepare({
          request:
            resolved.reasoningBudget === 0 ? ProviderDispatch.withoutReasoning(ordinaryRequest) : ordinaryRequest,
          promptCacheKey,
          contextSize: model.route.defaults.limits?.context,
          prefixCacheRetentionTokens: routeProfile.prefixCacheRetentionTokens,
          imagePatchPixels: routeProfile.imagePatchPixels,
          profile: ContextBudget.enabled(harness.context, resolved.contextBudget)
            ? ContextBudget.resolve(harness.context, resolved.type)
            : undefined,
        })
        if (prepared.packed.dropped > 0)
          yield* Log.event("session.context.pack.evicted", {
            "session.id": session.id,
            "session.dropped": prepared.packed.dropped,
            "session.kept.tokens": prepared.packed.estimatedTokens,
            "session.context.size": prepared.packed.contextSize,
          })
        const attempt = ProviderDispatch.stream({
          llm,
          request: prepared.request,
          enabled: budgetEnforced,
          budget: thinkingBudget,
        }).pipe(
          Stream.runForEach((event) => {
            if (LLMEvent.is.textDelta(event)) text.push(event.text)
            else if (event.type === "reasoning-delta") reasoning.push(event.text)
            else if (event.type === "step-finish" && event.usage !== undefined)
              costTokens =
                (event.usage.nonCachedInputTokens ?? event.usage.inputTokens ?? 0) + (event.usage.outputTokens ?? 0)
            return Effect.void
          }),
        )
        const result = yield* ProviderDispatch.run({
          events,
          scheduler,
          // The SESSION id stays the real one — status events, timing and logs all belong to the
          // chat. Only the scheduler's slot identity splits per racer.
          sessionID: session.id,
          slot,
          maxAttempts: maxProviderAttempts,
          hasOutput: () => text.length > 0 || reasoning.length > 0,
          costTokens: () => costTokens,
          attempt,
        })
        if (result._tag === "Failure") return yield* Effect.failCause(result.cause)
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
      // A stopped run finalizes on a detached fiber at its next step boundary, and it is still
      // saving THIS session's plan rows — so wait for our own straggler before reading them for
      // resume. The folder's exclusion is a different claim and is taken below, at the fork.
      {
        const tail = sessionTail.get(sessionID)
        if (tail !== undefined) {
          yield* Fiber.await(tail)
          sessionTail.delete(sessionID)
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
            "session.defect": Log.fault(defect),
          }).pipe(Effect.as(0)),
        ),
      )
      let resumeReadFailed = false
      const saved = yield* JhStore.latest(db, `jh_${sessionID}_`).pipe(
        Effect.catchDefect((defect) =>
          Effect.sync(() => {
            resumeReadFailed = true
          }).pipe(
            Effect.andThen(
              Log.event("session.strict.resume.failed", {
                "session.id": sessionID,
                "session.defect": Log.fault(defect),
              }),
            ),
            Effect.as(undefined),
          ),
        ),
      )
      const resumable = saved !== undefined && saved.status !== "done"
      const wantsResume = SessionStrict.resumeIntent(task)
      if (wantsResume && resumeReadFailed) {
        yield* notice(
          "Strict could not safely read the saved controller state. Your working files remain available. Describe a new task to continue from those files.",
        )
        return "handled" as const
      }
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
              yield* completeOnce(dispatchSlot, SessionStrict.ROUTE_SYSTEM, task, SessionStrict.ROUTE_TOKENS).pipe(
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
        safeMode: stanceOf("safeMode", resolved.safeMode),
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
      // The folder refusal, said in the same voice and at the same place as the host-execution one.
      // This read is ADVISORY — the binding test-and-set is at the fork below, which is the only
      // point where a claim can be made atomically. Refusing here as well keeps the common case
      // legible: without it the user would read "Strict mode: working on this step-by-step" and
      // then, two lines later, that it never started.
      const folderBusyNotice =
        "🛡️ Strict mode can't run this here yet — another Strict run is already working in this folder, " +
        "and two engines must never edit the same working tree. Answering normally instead; ask again once it finishes."
      if (folder.busy()) {
        yield* notice(folderBusyNotice)
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
      const removeForks = (dirs: readonly string[]) =>
        Effect.all(
          dirs.map((dir) =>
            Effect.promise(() => fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined)),
          ),
          { concurrency: "unbounded", discard: true },
        )
      if (attempts > 1) {
        baseline = yield* Effect.promise(() => SessionStrict.manifestFor(location.directory))
        for (let i = 0; i < attempts; i++) {
          const fork = yield* Effect.promise(() => SessionStrict.forkWorkspace(location.directory, i + 1))
          if ("refused" in fork) {
            yield* notice(`🛡️ Racing is OFF for this task — ${fork.refused}. Running a single attempt instead.`)
            yield* removeForks(forks)
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
      // One racer, one slot. A single-attempt run IS the session's one generation, so it keeps the
      // session's own slot; racers 1..N each get theirs (`slotFor`), which is what makes N
      // concurrent generations count as N against the device.
      const completeAbortable = (i: number) => (system: string, user: string, maxTokens: number) =>
        Effect.raceFirst(completeOnce(single ? dispatchSlot : slotFor(i + 1), system, user, maxTokens), abortWatch)
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
      // Single-attempt runs publish actions live and used to DISCARD them, which is why the run
      // summary had no file list on the default path (see `SessionStrict.filesWritten`). Keeping the
      // names — not the actions — costs nothing and is what the summary needs.
      const singleActions: SessionStrict.MaterializedAction[] = []
      let actionSeq = 0
      const publishAction = (action: SessionStrict.MaterializedAction) =>
        Effect.gen(function* () {
          if (single) singleActions.push(action)
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
              "session.cause": Log.fault(cause),
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
          ...(contextTokens === undefined ? {} : { contextTokens }),
          host: strictHost,
          completeOnce: completeAbortable(i),
          ...(resumeState === undefined ? {} : { resume: resumeState }),
          onMilestone: (text) => notice(single ? text : `[attempt ${i + 1}/${attempts}] ${text}`),
          aborted: () => stopRequested || (winnerIdx !== undefined && winnerIdx !== i),
          onAction: single ? publishAction : recordAction(i),
          checkpoint: single
            ? (state) => {
                const now = Date.now()
                return Effect.gen(function* () {
                  yield* JhStore.save(db, { id: savedKey, goal, status: "running", state, now })
                  yield* SessionPlan.projectJh(dependencies.components, { sessionID, goal, state, now })
                }).pipe(Effect.ignore)
              }
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
              "session.cause": Log.fault(cause),
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
      // ⚠️ THE RUN'S MESSAGE IS SETTLED ON EVERY EXIT, not only the ones that produce a report.
      // A run that published tool parts owns a live assistant message, and `Step.Ended` is what
      // carries the END boundary that `session/changes.ts` and `session/revert.ts` read — so a run
      // that dies without settling leaves a message unfinished forever AND makes Revert restore
      // ZERO files for a folder it just rewrote. That guard existed, but it lived inside
      // `publishSummary` and was therefore unreachable from every path that never got that far.
      // One home, and it runs from `finalize`'s own finalizer.
      let runSettled = false
      const settleRunMessage = Effect.gen(function* () {
        if (runSettled) return
        if (actionSeq === 0) return
        if (runPublisher.stepSettlement() !== undefined) return
        runSettled = true
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
      }).pipe(Effect.ignore)
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
          const prepared = ProviderDispatch.prepare({
            request: LLM.request({
              model,
              system: [SystemPart.make(prompts.system)],
              messages: [Message.user(prompts.user)],
              tools: [],
              generation: { maxTokens: SessionStrict.SUMMARY_TOKENS },
            }),
            promptCacheKey,
            contextSize: model.route.defaults.limits?.context,
            prefixCacheRetentionTokens: routeProfile.prefixCacheRetentionTokens,
            imagePatchPixels: routeProfile.imagePatchPixels,
            profile: ContextBudget.enabled(harness.context, resolved.contextBudget)
              ? ContextBudget.resolve(harness.context, resolved.type)
              : undefined,
          })
          let summaryOutput = false
          const attempt = ProviderDispatch.stream({
            llm,
            request: prepared.request,
            enabled: budgetEnforced,
            budget: thinkingBudget,
          }).pipe(
            Stream.runForEach((event) => {
              if (LLMEvent.is.textDelta(event) || LLMEvent.is.reasoningDelta(event)) summaryOutput = true
              return publisher.publish(event)
            }),
          )
          const dispatched = yield* ProviderDispatch.run({
            events,
            scheduler,
            sessionID: session.id,
            slot: dispatchSlot,
            maxAttempts: maxProviderAttempts,
            hasOutput: () => summaryOutput,
            costTokens: () => {
              if (publisher.hasProviderError()) return undefined
              const settlement = publisher.stepSettlement()
              return settlement === undefined ? undefined : settlement.tokens.input + settlement.tokens.output
            },
            attempt,
          })
          if (dispatched._tag === "Failure") yield* Effect.failCause(dispatched.cause)
          const settlement = publisher.stepSettlement()
          if (settlement !== undefined && !publisher.hasProviderError()) {
            runSettled = true
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
              "session.cause": Log.fault(cause),
            }),
          ),
          // The run message may already exist (tool parts) — a failed/empty summary must not
          // leave it visibly unsettled forever. Settled here so it happens BEFORE `postRun` reads
          // the turn; `finalize`'s finalizer repeats the call for every other exit and the flag
          // makes the second one a no-op.
          Effect.andThen(settleRunMessage),
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
          // ⚠️ "left as-is" was TRUE only of the racing branch, whose work is in temp forks. On the
          // single-attempt path — the default — the engine writes straight into the working
          // directory and every successful write was already published as a tool part, so the old
          // wording described a fault falsely (ruling 2). Say which of the two happened; the
          // conditional is the one `SessionStrict.terminalNotice` already applies for `single`.
          yield* notice(
            !single
              ? "⚠️ The Strict run hit an internal error — see the server log. YOUR FOLDER IS UNCHANGED — the attempts ran on isolated copies of it."
              : actionSeq > 0
                ? `⚠️ The Strict run hit an internal error — see the server log. It had already written to your working directory (${actionSeq} action${actionSeq === 1 ? "" : "s"} above) and those changes are still there; use Revert on this message to undo them.`
                : "⚠️ The Strict run hit an internal error — see the server log. It had not written anything yet, so your folder is unchanged.",
          )
          yield* removeForks(forks)
          return
        }
        // The racing branch below overwrites this with `applyBack`'s authoritative list; on the
        // single path the engine's own successful writes ARE the answer.
        let appliedFiles: string[] = single ? [...SessionStrict.filesWritten(singleActions)] : []
        if (!single) {
          const winner = winnerIdx
          if (winner !== undefined && baseline) {
            appliedFiles = yield* Effect.promise(() =>
              SessionStrict.applyBack(forks[winner]!, location.directory, baseline),
            )
            yield* notice(
              `🏁 Attempt ${winner + 1}/${attempts} WON the race — ${appliedFiles.length} changed file${appliedFiles.length === 1 ? "" : "s"} applied to the folder: ${appliedFiles.slice(0, 8).join(", ")}${appliedFiles.length > 8 ? ", …" : ""}`,
            )
            yield* removeForks(forks)
          } else if (stopRequested) {
            yield* notice(`🏁 The race was stopped before any attempt verified success — YOUR FOLDER IS UNCHANGED.`)
            yield* removeForks(forks)
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
        yield* SessionPlan.projectJh(dependencies.components, {
          sessionID,
          goal,
          state: report.state,
          now: Date.now(),
        })
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
            // Sampled before the run started, so a `completion_unverified` can say whether this run
            // BROKE the project's checks or merely inherited them broken.
            ...(report.baselineRed === undefined ? {} : { baselineRed: report.baselineRed }),
          }),
        )
        // Racing legibility: replay the WINNER's buffered actions as real tool parts on the run
        // message (single attempts already materialized them live) — so a raced run reads like a
        // normal run, not just notices. The summary then streams onto the same message.
        if (!single && winnerIdx !== undefined)
          for (const action of racerActions[winnerIdx]!) yield* publishAction(action)
        yield* publishSummary(report, appliedFiles)
      }).pipe(
        Effect.catchCause((cause) =>
          Log.event("session.strict.finalize.failed", {
            "session.id": sessionID,
            "session.cause": Log.fault(cause),
          }),
        ),
        // EVERY exit owes the same two things, so neither is written on a branch. `postRun` used to
        // be the last line of the happy path and `Step.Ended` lived inside `publishSummary`, so a
        // dead engine skipped both: no auto-title, no changes-summary refresh, no memory
        // extraction, and an assistant message that never settled. Both are idempotent.
        Effect.andThen(settleRunMessage),
        Effect.andThen(maintenance.postRun(sessionID).pipe(Effect.ignore)),
      )
      // ── the FOLDER claim (`folderExclusion`, top of file) ──
      // A second session is REFUSED, not queued, and that is deliberate. Queueing would hold this
      // chat silent for the other run's whole wall, and worse: the START snapshot above was already
      // captured, so a queued run's Revert boundary would span the OTHER engine's changes and undo
      // them. Refusing is the shape the host-execution gate above already uses — name it once and
      // answer normally. The drain's own queued messages never see this: each iteration joins its
      // fiber before the next one starts, and a stopped run's straggler is awaited by `sessionTail`.
      const worker = yield* folder.enter(
        finalize.pipe(Effect.ensuring(Effect.sync(() => sessionTail.delete(sessionID)))),
      )
      if (worker === undefined) {
        yield* removeForks(forks)
        yield* notice(folderBusyNotice)
        return "chat" as const
      }
      // ⚠️ Deleted by the fiber's own finalizer as well as here: a Stop interrupts the join and this
      // line is never reached, which is exactly the case that used to leave a completed fiber in the
      // map until that session drained again.
      sessionTail.set(sessionID, worker)
      yield* Fiber.join(worker).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            stopRequested = true
          }),
        ),
      )
      sessionTail.delete(sessionID)
      promotion = "queue"
      if (!(yield* SessionInput.hasPending(db, sessionID, "queue"))) return "handled" as const
    }
  })
}
