export * as SessionMaintenance from "./maintenance"

import { LLM, LLMEvent, Message, SystemPart, type FinishReason } from "@novaclaw/llm"
import { SessionRecall } from "./recall"
import { Context, DateTime, Deferred, Duration, Effect, Fiber, FiberSet, Layer, Stream } from "effect"
import { Log } from "@novaclaw/schema/log"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import * as MemoryAccess from "../../kb-graph/memory-access"
import { KbEmbedder } from "../../kb-graph/embedder"
import { WorldMemory } from "../../kb-graph/world-memory"
import { MemoryClient } from "../../kb-graph/memory-client"
import { Snapshot } from "../../snapshot"
import { makeLocationNode } from "../../effect/app-node"
import { llmClient } from "../../effect/app-node-platform"
import { stanceOf } from "../config-resolve"
import { SessionEffectiveConfig } from "../effective-config"
import { ShortChat } from "./short-chat"
import { SessionChanges } from "../changes"
import { SessionMessageRead } from "../message-read"
import { SessionPatch } from "../patch"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionTitle } from "../title"
import { LLMClient } from "@novaclaw/llm"
import { SessionExtract } from "./extract"
import { SessionRunnerModel } from "./model"
import { SessionScheduler } from "../scheduler"
import { ReasoningBudget } from "./reasoning-budget"
import { ShortAnswer } from "./short-answer"
import { UtilityCap } from "./utility-cap"
import { UtilityPass } from "./utility-pass"

/**
 * Post-drain maintenance — everything the runner does *after* a turn has settled.
 *
 * ⚖️ **Why this is a service and not three helpers inside `runner/llm.ts`.** These passes share
 * nothing with a turn: they take a session id, run best-effort, and are forbidden from failing the
 * drain they follow. Living inside the runner's single `Layer.effect` closure they were reachable
 * only by reading 2 900 lines, and every one of them needed the runner's *whole* dependency set to
 * be exercised at all. Extracted, the contract is stateable in one sentence and testable without a
 * drain: **nothing in here may fail its caller.** That is enforced structurally — every method
 * returns `Effect<void, never>` — rather than by each call site remembering a `catchCause`.
 *
 * 🔴 **This layer MUST stay one module-scope object.** Effect's `MemoMap` keys on the layer's
 * OBJECT IDENTITY, and only `Layer.effect` is ever a key (`provide`/`catchCause`/`unwrap` are
 * pass-throughs). A sibling subsystem made its service layer a *function of a parameter* — minting
 * a fresh key per call — and got two instances, two `:memory:` databases, and a `NotFoundError` on
 * every read, invisible to nineteen of its own tests because each built exactly ONE composition.
 * So: no `layerWith`, no factory, no `Layer.fresh` in the production graph.
 * Pinned by `maintenance-identity.test.ts`, which has a negative control.
 *
 * ⚠️ **`Effect.catch`/`Effect.ignore` do not see defects.** Every arm below uses `catchCause`, which
 * does — a defect-blind catch in this very family once let a judge kill the drain it was written
 * never to fail. Interruption is deliberately NOT caught: an interrupted drain must stay interrupted.
 */
export interface Interface {
  /**
   * The post-drain pass, shared by the normal and the Strict routes: the changes summary first (one
   * git tree-diff; feeds the Changes review/badge), then the auto-title (an LLM call) while the user
   * reads the response, then memory extraction.
   */
  readonly postRun: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /**
   * Arm the 30 s auto-title fallback for a LONG turn, then return immediately. The pass itself runs
   * on a DETACHED fiber, so an interrupted drain cannot swallow it (the dying-fiber trap).
   */
  readonly scheduleEarlyTitle: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /**
   * Mark the recorded changes summary stale at drain ENTRY — the diff it describes is about to stop
   * being the whole story, and a badge that silently describes the previous turn is worse than one
   * that admits it is mid-flight.
   */
  readonly markChangesIncomplete: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /**
   * Wait for detached memory organisation to finish.
   *
   * Memory extraction is deliberately NOT awaited by `postRun` — owner ruling 2026-08-12, it must not
   * delay the reply — which makes it invisible to anything that needs to know it happened. Two
   * callers do: a test asserting the pass ran at all, and shutdown, which would otherwise drop an
   * in-flight extraction on quit.
   *
   * ⚠️ Without this, detaching silently converts "memory was written" into "memory was probably
   * written", and a lost write is the hardest kind of bug to notice in a memory system.
   */
  readonly settleMemory: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/SessionMaintenance") {}

/**
 * A title needs essentially no reasoning. Kept deliberately far below an interactive turn's
 * model-level budget; `ReasoningBudget` owns the bounded multi-request recovery when a reasoning
 * model nevertheless opens a think stream. Provider-neutral until the controller's final best-effort
 * hard stop, unlike putting a Qwen-specific flag on the first request.
 */
/**
 * When post-drain housekeeping stops being background and starts being a wait.
 *
 * ⚠️ **Read the WINDOW before the numbers.** `total` is `Date.now() - started` over the AWAITED
 * passes only, and memory extraction is forked (see `postRun`), so it is outside this measurement
 * entirely. What is timed is `changes` + `title`.
 *
 * Measured 2026-08-11 against `holo3.1`, decomposed: changes **16 ms**, title **3 ms** when it is a
 * no-op and **643 ms** on a session's first turn where it is a real model call. So this window is
 * ~20 ms in the steady state and ~660 ms on a first turn. 5 s is roughly 8× that worst case —
 * headroom enough that it fires on a fault, not on a Tuesday.
 *
 * ⚠️ **Why a threshold at all, given those numbers are small.** This runs INSIDE the drain — after
 * the idle status is published, so no spinner shows, but before the lease is released — so the next
 * prompt waits behind it.
 *
 * 🔴 **What this threshold does NOT cover, stated because the old version of this comment implied
 * otherwise.** The same 2026-08-11 run measured memory at **623 ms of a 642 ms `postRun`** — 97% of
 * it — and the case originally worried about was *"an embedding stalls or a device is contended"*.
 * That pass is exactly the one that has since moved out of the window, so a stalled embedder is now
 * timed by NOTHING. It is joinable (`outstanding`), so closing this means timing the fiber in its
 * observer, not widening the number here. Do not re-derive a bound for the memory pass from the
 * figures above: 623 ms is a measurement of a pass this constant no longer watches.
 */
const POSTRUN_SLOW_MS = 5_000

const TITLE_REASONING_BUDGET = 128

/** The best-effort structural switch for providers that honour it. A REQUEST, never a guarantee —
 *  the rationale and the backstops every utility pass still owes live in `utility-pass.ts`. */
const NO_THINKING = UtilityPass.NO_THINKING

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const store = yield* SessionStore.Service
    const effective = yield* SessionEffectiveConfig.Service
    const models = yield* SessionRunnerModel.Service
    const scheduler = yield* SessionScheduler.Service
    const llm = yield* LLMClient.Service
    const snapshots = yield* Snapshot.Service
    // Automatic extraction belongs to the hot world model, not the user-curated/source KB.
    const memory = WorldMemory.client(yield* WorldMemory.node.service)

    const maintenanceInput = (
      ownerID: SessionSchema.ID,
      task: string,
      device: SessionRunnerModel.ScheduledDevice,
    ): SessionScheduler.MaintenanceInput => ({
      ownerID,
      task,
      deviceKey: device.key,
      ...(device.concurrency === undefined ? {} : { concurrency: device.concurrency }),
      ...(device.locality === undefined ? {} : { locality: device.locality }),
    })

    const getSession = Effect.fn("SessionMaintenance.getSession")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
      return session
    })

    const getContext = (sessionID: SessionSchema.ID) => store.context(sessionID)

    /**
     * Sessions with an auto-title pass in flight. Two callers race for it — the 30 s timer and the
     * drain end — and both would otherwise see `isDefault` still true and each spend a model call.
     *
     * ⚠️ This is per-INSTANCE state, which is exactly why the identity guard above is not academic:
     * two instances of this service are two independent guards, i.e. the duplicate model call the
     * guard exists to prevent.
     */
    const titling = new Map<string, Deferred.Deferred<void>>()

    /**
     * Detached memory organisation lives here, not in the drain.
     *
     * Owner ruling 2026-08-12: memory organisation runs off the reply path — *"such memory won't be
     * needed immediately anyway, since the still context has it"*. A `FiberSet` rather than a bare
     * `forkDetach` because the work must stay JOINABLE: `settleMemory` is what lets shutdown settle
     * it rather than lose it, and what lets a test assert the pass ran.
     *
     * ⚠️ Scoped to this layer, which in PRODUCTION is a location's services — cached with
     * `idleTimeToLive: "60 minutes"`, i.e. four orders of magnitude longer than the ~600 ms this
     * work takes. A test that tears the scope down immediately must settle first; that is the
     * harness's job, not a reason to keep the pass on the reply path.
     */
    const forkMemory = yield* FiberSet.makeRuntime<never, void, never>()
    // Early-title timers must outlive the turn that scheduled them, but never the location service
    // whose database and model graph they close over. `forkDetach` made them process-global: tests
    // closed their in-memory databases while hundreds of 30 s timers remained alive, and the core
    // process could no longer exit. A scoped FiberSet gives the timer the exact owner it needs.
    const forkTitle = yield* FiberSet.makeRuntime<never, void, never>()
    const outstanding = new Set<Fiber.Fiber<void, never>>()

    const generateTitle = Effect.fn("SessionMaintenance.generateTitle")(function* (sessionID: SessionSchema.ID) {
      const session = yield* getSession(sessionID)
      // A title the USER set is never overwritten — `isDefault` is the whole consent check here.
      if (!SessionTitle.isDefault(session.title)) return
      const text = SessionTitle.firstRealUserText(yield* getContext(sessionID))
      if (!text) return
      const { model, device } = yield* models.resolveWithDevice(session)
      // ⚠️ **This pass deliberately does NOT take the `UtilityCap` ladder the two extraction passes
      // and the introspection pass use, and the reason is worth keeping.** `ReasoningBudget` already
      // owns a bounded multi-phase recovery for exactly this failure: it counts reasoning tokens
      // live, nudges at 70% and 100% of `TITLE_REASONING_BUDGET` (128), and its mechanical hard stop
      // re-issues the turn with thinking structurally disabled — which measurably drops completion to
      // ~126 tokens, far inside this 512. Stacking a second retry loop on top would be two recoveries
      // racing over one turn, which is how a bounded thing becomes an unbounded one.
      //
      // 🔴 **But note a real assumption mismatch, recorded rather than fixed here.**
      // `reasoning-budget.ts` argues its safety from phases inheriting a `max_tokens` that is
      // "typically UNSET → the server uses the remaining context window", so an answer that starts
      // inside a phase always completes. This call site passes an explicit **512**, so that argument
      // does not hold verbatim — the checkpoints bound REASONING, not the answer. It is covered in
      // practice only because the hard stop lands so far under the cap. If either number moves, this
      // is the pairing to re-check.
      // ⚠️ Through `ShortAnswer` rather than an inline request, and the reasoning above moved with
      // it. This call is where "a short label, thinking bounded" was solved; the colleague status
      // sweep then re-derived it three files away and got it wrong (empty completions from a
      // reasoning model). One caller could keep it as a local shape; two cannot.
      const raw = yield* ShortAnswer.generate({
        model,
        llm,
        system: SessionTitle.SYSTEM,
        text,
        reasoningBudget: TITLE_REASONING_BUDGET,
        maxTokens: 512,
        scheduler,
        maintenance: maintenanceInput(sessionID, "session-title", device),
      })
      // An EMPTY completion is a broken call, not "no title worth writing" — say so. Silence here is
      // exactly how this stayed dead across three shipped phases.
      if (raw.trim() === "") yield* Log.event("session.title.generate.empty", { "session.id": sessionID })
      const title = SessionTitle.clean(raw)
      if (!title) return
      yield* SessionPatch.patchSessionRecord({ db, events }, sessionID, (info) =>
        SessionSchema.Info.make({ ...info, title, time: { ...info.time, updated: DateTime.makeUnsafe(Date.now()) } }),
      )
    })

    /**
     * `generateTitle`, but at most one pass per session at a time — and every overlapping caller
     * JOINS that pass.
     *
     * Production executes one drain in a disposable worker runtime. The 30 s pass can cross the
     * drain-end boundary: if `postRun` merely observes a boolean "already running" guard and returns,
     * worker disposal interrupts the detached fiber and the session keeps its placeholder title.
     * A Deferred makes the in-flight pass part of drain settlement without duplicating its model call.
     */
    const generateTitleOnce = (sessionID: SessionSchema.ID) =>
      Effect.suspend(() => {
        const active = titling.get(sessionID)
        if (active) return Deferred.await(active)
        const completed = Deferred.makeUnsafe<void>()
        titling.set(sessionID, completed)
        return generateTitle(sessionID).pipe(
          Effect.ensuring(
            Deferred.succeed(completed, undefined).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  if (titling.get(sessionID) === completed) titling.delete(sessionID)
                }),
              ),
              Effect.asVoid,
            ),
          ),
        )
      })

    // Auto-extraction (kb-graph §1.3.3): after the drain settles, a model pass reads the latest REAL
    // user turn and records durable facts into SESSION-scope memory (staged) — so memory fills
    // WITHOUT the agent calling `remember`, and auto-recall surfaces them in future turns. Only an
    // interactive session may enter: sub-agents and scheduled/heartbeat work are proposers, not
    // durable-memory authorities. Idempotent by content hash (re-extraction dedups). Best-effort +
    // gated on the engine being live so a disabled/still-opening memory costs no model call.
    const extractMemory = Effect.fn("SessionMaintenance.extractMemory")(function* (sessionID: SessionSchema.ID) {
      const session = yield* getSession(sessionID)
      const config = yield* effective.resolve(session.id)
      if (!SessionExtract.allowsDurableMemory(config.type)) return
      // `memory` already carries the instance ceiling (`session/effective-config.ts`).
      if (ShortChat.enabled(config.shortChat) || !stanceOf("memory", config.memory)) return
      if (!(yield* memory.health())) return
      const exchange = SessionExtract.buildExchange(yield* getContext(sessionID))
      if (!exchange) return
      const { model, device } = yield* models.resolveWithDevice({
        ...session,
        model: config.model as typeof session.model,
      })
      // ONE re-ask with a doubled budget when the pass spends everything and answers nothing.
      //
      // Measured 2026-08-06: a reasoning model cut off mid-think returns ZERO content chars, not a
      // partial answer, and `parseExtraction` reads that emptiness as "nothing worth remembering" —
      // so the pass silently records nothing. `NO_THINKING` below usually keeps us far from the
      // cliff (it is honoured by holo3.1, which drops reasoning to 0 and completion to ~126), but it
      // is a REQUEST: a growing class of models ignores it, and one that does puts this pass back on
      // a cliff at ~450 with 512 to spend. `UtilityCap` is the mechanical backstop for that case.
      //
      // ⚠️ NOT `finish-recovery.ts`: that steers a truncated turn to CONTINUE from the cutoff, which
      // is right for a conversational turn and impossible here — there is nothing to continue from
      // when the content is zero chars. Re-asking with room is the shape that fits one JSON blob.
      const chunks: string[] = []
      let cap = 512
      for (let attempt = 0; ; attempt++) {
        chunks.length = 0
        let finish: FinishReason | undefined
        const attemptCap = cap
        yield* SessionScheduler.runMaintenance(
          scheduler,
          maintenanceInput(sessionID, "memory-extract", device),
          llm
            .stream(
              LLM.request({
                model,
                system: [SystemPart.make(SessionExtract.SYSTEM)],
                messages: [Message.user(exchange)],
                tools: [],
                generation: { maxTokens: attemptCap },
                http: { body: NO_THINKING }, // else the budget goes to reasoning and the reply is EMPTY
              }),
            )
            .pipe(
              Stream.runForEach((event) => {
                if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
                else if (event.type === "finish") finish = event.reason
                return Effect.void
              }),
            ),
          Effect.void,
        )
        const verdict = UtilityCap.decide({ finish, text: chunks.join(""), attempt, cap: attemptCap })
        if (!verdict.retry) {
          // Ruling 2: an empty result that was a BUDGET reading must not look like an honest "[]".
          if (chunks.join("").trim() === "")
            yield* Log.event("session.memory.extract.giveup", {
              "session.id": sessionID,
              "extract.cause": UtilityCap.giveUpCause({ finish, text: "", attempt, cap: attemptCap }),
              "extract.cap": attemptCap,
            })
          break
        }
        yield* Log.event("session.memory.extract.retry", {
          "session.id": sessionID,
          "extract.cap": verdict.cap,
        })
        cap = verdict.cap
      }
      // 🔴 THE OFFICER'S CABINET, not this chat's drawer.
      //
      // This was `session:${sessionID}`, hardcoded, and it broke the filing-cabinet promise — "a
      // D&D companion's recall never reaches the trading desk".
      //
      // ⚠️ **It was a LEAK, not a loss, and the first version of this comment said the wrong one.**
      // The obvious reading is that a session-scoped fact dies when the user clears the chat. It did
      // not: `kb-graph/memory.ts` runs a consolidation pass every five minutes that promotes exactly
      // `source = 'auto-extract'` memories in `session:` scopes into `global`
      // (`wasm-engine.ts` → `consolidate`). So everything a colleague learned WITHOUT being asked
      // became readable by EVERY colleague within about five minutes, and showed up in the Memory
      // app under "shared" rather than under the officer who learned it. Explicit `kb remember`
      // facts were unaffected — they already went to `agent:<id>` (`tool/kb.ts` → `scopeForWrite`) —
      // so the partition held for what a user watched being written and failed for what it did not.
      //
      // Filing them in the officer's cabinet fixes it by construction: `consolidate` only picks up
      // `session:` scopes, so nothing promotes them, and recall reads `agent:<id>` anyway.
      //
      // ⚠️ `SessionRecall.rememberScope` is the rule, and it already existed — written for exactly
      // this ("an officer's durable facts belong to the officer"), tested, and never called by
      // anything. Using it rather than re-deriving the fallback keeps ONE answer to "where does a
      // remember go when nobody said": the officer's cabinet, or this chat when there is no officer.
      const scope = SessionRecall.rememberScope({ sessionID, agentID: config.agent })
      const rawExtraction = chunks.join("")
      // Distinguish "the model said there is nothing to remember" (a legitimate `[]`) from "the model
      // returned NOTHING" (a broken call). Conflating them is what hid this failure for three phases.
      if (rawExtraction.trim() === "") yield* Log.event("session.memory.extract.empty", { "session.id": sessionID })
      const facts = SessionExtract.parseExtraction(rawExtraction)
      const namedFacts = facts.filter((f): f is SessionExtract.Extracted & { name: string } => !!f.name)
      const names = [...new Set(namedFacts.map((f) => f.name))]
      // Embed the extracted facts so they're reachable by the VECTOR leg later (measured: hybrid
      // retrieval 85% vs 77% keyword-only). ONE batched call for the whole extraction, and this runs
      // in `postRun` — off the turn hot-path. No device ⇒ undefined ⇒ FTS-only memories.
      // ONE embed call covers both node kinds: the fact texts, then the entity names. Entities are
      // embedded on their name so they are reachable by the vector leg too, and appending them here
      // keeps that free — a second call would double the per-turn embedding cost for no new content.
      const vectors =
        facts.length === 0
          ? undefined
          : yield* Effect.promise(() => KbEmbedder.embed([...facts.map((f) => f.text), ...names]))
      // ENTITIES FIRST. `entityID` keys on the NAME, so these nodes are shared across turns and
      // across sessions in the same scope — writing the same name again is a dedup, not a duplicate.
      // They must exist before the episodes below, because those episodes link INTO them.
      for (const [index, name] of names.entries()) {
        const vector = vectors?.[facts.length + index]
        yield* memory
          .addMemory({
            id: SessionExtract.entityID(scope, name),
            kind: "entity",
            text: name,
            name,
            scope,
            source: "auto-extract",
            relation: "staged",
            ...(vector === undefined ? {} : { embedding: vector }),
          })
          .pipe(Effect.ignore) // duplicate id = this entity is already known; never fail the drain
      }
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
      // Each episode MENTIONS the entity it is about. This single edge is what makes the graph
      // connected over time: an episode from this turn and one from forty turns ago attach to the
      // same entity node, so they are two hops apart instead of unreachable. It costs no model call —
      // the association was already in the extraction, and was simply being discarded.
      for (const fact of namedFacts) {
        yield* memory
          .addEdge(
            {
              from: SessionExtract.memoryID(scope, fact.text),
              to: SessionExtract.entityID(scope, fact.name),
              type: "mentions",
              scope,
              source: "auto-extract",
            },
            // SYSTEM: extraction's own bookkeeping, no session asking. The engine derives the edge's
            // scope from its endpoints regardless, so this cannot promote visibility.
            MemoryAccess.system(),
          )
          .pipe(Effect.ignore) // duplicate edge = already linked; never fail the drain
      }
      // Stage 2 (KB-D (a)): link the facts we just wrote. Deliberately AFTER the node writes — an edge
      // needs its endpoints to exist, and more importantly a failing/slow link call must never cost us
      // the memories themselves (computing links first would abort the whole extraction on any link
      // error). Skipped entirely below 2 named facts: nothing to connect, so no model call.
      const links =
        names.length < 2
          ? []
          : yield* Effect.gen(function* () {
              // Stage 2 rides the SAME budget ladder as stage 1 above, for the same reason: an empty
              // completion here is read as "no relationships", which is a legitimate answer and
              // therefore indistinguishable from a truncated one. Without this the graph quietly
              // accumulates disconnected nodes and the multi-hop win never materialises — the exact
              // outcome `LINK_SYSTEM`'s own note says the edges exist to prevent.
              const linkChunks: string[] = []
              let linkCap = 512
              for (let attempt = 0; ; attempt++) {
                linkChunks.length = 0
                let finish: FinishReason | undefined
                const attemptCap = linkCap
                yield* SessionScheduler.runMaintenance(
                  scheduler,
                  maintenanceInput(sessionID, "memory-link", device),
                  llm
                    .stream(
                      LLM.request({
                        model,
                        system: [SystemPart.make(SessionExtract.LINK_SYSTEM)],
                        messages: [Message.user(SessionExtract.buildLinkPrompt(exchange, names))],
                        tools: [],
                        generation: { maxTokens: attemptCap },
                        http: { body: NO_THINKING }, // else the budget goes to reasoning and the reply is EMPTY
                      }),
                    )
                    .pipe(
                      Stream.runForEach((event) => {
                        if (LLMEvent.is.textDelta(event)) linkChunks.push(event.text)
                        else if (event.type === "finish") finish = event.reason
                        return Effect.void
                      }),
                    ),
                  Effect.void,
                )
                const verdict = UtilityCap.decide({ finish, text: linkChunks.join(""), attempt, cap: attemptCap })
                if (!verdict.retry) break
                yield* Log.event("session.memory.extract.retry", {
                  "session.id": sessionID,
                  "extract.cap": verdict.cap,
                })
                linkCap = verdict.cap
              }
              return SessionExtract.parseLinks(linkChunks.join(""), names)
            }).pipe(Effect.catchCause(() => Effect.succeed([] as SessionExtract.ExtractedLink[])))
      // An extracted link names two SUBJECTS, so it is a relation between entities — "Acme Robotics"
      // employs "Sofia" is a fact about those two things, not about the two sentences that happened
      // to mention them.
      //
      // ⚠️ This used to bind each endpoint to the first EPISODE carrying that name, via
      // `memoryID(scope, fact.text)`. That made every relation an artefact of one turn's phrasing:
      // re-stating the same relationship next week minted two fresh episode nodes and a third edge
      // between them, unconnected to the first. Anchoring on `entityID` means repetition REINFORCES
      // one edge instead of scattering new ones.
      //
      // `parseLinks` already guaranteed both endpoints are names from `names`, and every name in
      // `names` was written as an entity above, so both lookups resolve by construction.
      for (const link of links) {
        yield* memory
          .addEdge(
            {
              from: SessionExtract.entityID(scope, link.from),
              to: SessionExtract.entityID(scope, link.to),
              type: link.type,
              scope,
              source: "auto-extract",
            },
            // SYSTEM: extraction's own bookkeeping, no session asking. The engine derives the edge's
            // scope from its endpoints regardless, so this cannot promote visibility.
            MemoryAccess.system(),
          )
          .pipe(Effect.ignore) // duplicate edge = already linked; never fail the drain
      }
    })

    // The session-changes summary (the app's "Changes" review + the chats badge reads
    // `SessionInfo.summary` — F1e re-pointed it to the record; V1 wrote per-user-message diffs the
    // native transcript doesn't carry, and NOTHING wrote the record field until this landed).
    // Recomputed after each drain from the FULL transcript's cumulative snapshot boundaries (the
    // packed runner context may have compacted the first `snapshot.start` away, so read the store,
    // not the context) and patched onto the record only when it actually changed — the app updates
    // live off `session.updated`.
    const refreshChangesSummary = Effect.fn("SessionMaintenance.refreshChangesSummary")(function* (
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

    const markChangesIncompleteAttempt = Effect.fn("SessionMaintenance.markChangesIncomplete")(function* (
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

    /**
     * The one place a maintenance pass is allowed to end. `catchCause` and not `catch`/`ignore`,
     * because only `catchCause` sees a DEFECT — and a die inside a best-effort pass killing the
     * drain it follows is precisely the failure this whole module is shaped to make impossible.
     */
    const bestEffort = <A, E>(
      event: "session.changes.refresh.failed" | "session.title.generate.failed" | "session.memory.extract.failed",
      sessionID: SessionSchema.ID,
      effect: Effect.Effect<A, E, never>,
    ): Effect.Effect<void> =>
      effect.pipe(
        Effect.asVoid,
        Effect.catchCause((cause) => Log.event(event, { "session.id": sessionID, "session.cause": Log.fault(cause) })),
      )

    return Service.of({
      postRun: (sessionID) =>
        Effect.gen(function* () {
          const started = Date.now()
          const passes: Array<{ readonly stage: string; readonly ms: number }> = []
          const timed = Effect.fnUntraced(function* (stage: string, pass: Effect.Effect<void>) {
            const at = Date.now()
            yield* pass
            passes.push({ stage, ms: Date.now() - at })
          })
          yield* timed(
            "changes",
            bestEffort("session.changes.refresh.failed", sessionID, refreshChangesSummary(sessionID)),
          )
          yield* timed("title", bestEffort("session.title.generate.failed", sessionID, generateTitleOnce(sessionID)))
          /**
           * DETACHED. This block runs inside the drain, after the idle status is published but
           * BEFORE the lease is released, so every millisecond here is the next prompt waiting.
           * Measured: memory was 623 ms of a 642 ms `postRun` — essentially all of it.
           *
           * `changes` and `title` stay awaited above: the UI reads both the moment the turn ends, so
           * they are not "needed later" in the sense the ruling describes.
           */
          const memoryFiber = forkMemory(
            bestEffort("session.memory.extract.failed", sessionID, extractMemory(sessionID)),
          )
          outstanding.add(memoryFiber)
          void memoryFiber.addObserver(() => outstanding.delete(memoryFiber))
          const total = Date.now() - started
          if (total < POSTRUN_SLOW_MS) return
          const slowest = passes.toSorted((a, b) => b.ms - a.ms)[0]
          yield* Log.event("session.maintenance.postrun.slow", {
            "session.id": sessionID,
            "session.stage": slowest?.stage ?? "none",
            "session.stage.ms": slowest?.ms ?? 0,
            "session.maintenance.ms": total,
          })
        }),
      /**
       * Title the session after 30 s if the turn is still going (owner 2026-07-25). The drain-end pass
       * is the right moment for a SHORT turn — the user is reading the answer while the model is idle
       * — but a long one (compile, test, retry) leaves the chat list showing a placeholder for
       * minutes, which is exactly when a name is most useful for finding it again. Whichever fires
       * first wins; the loser no-ops on `isDefault` (or the in-flight guard above), and a user-set
       * title stops both.
       *
       * Detached, because it must outlive neither the turn's failure nor its interruption.
       */
      scheduleEarlyTitle: (sessionID) =>
        Effect.sync(() => {
          forkTitle(
            Effect.sleep(Duration.seconds(30)).pipe(
              Effect.andThen(generateTitleOnce(sessionID)),
              Effect.catchCause((cause) =>
                Log.event("session.title.early.failed", {
                  "session.id": sessionID,
                  "session.cause": Log.fault(cause),
                }),
              ),
            ),
          )
        }),
      markChangesIncomplete: (sessionID) =>
        bestEffort("session.changes.refresh.failed", sessionID, markChangesIncompleteAttempt(sessionID)),
      // Joins whatever is in flight NOW. `bestEffort` already swallowed any failure, so awaiting
      // these can only wait — it can never turn a background fault into a caller's error.
      settleMemory: Effect.suspend(() =>
        Effect.forEach([...outstanding], (fiber) => Fiber.await(fiber).pipe(Effect.ignore), { discard: true }),
      ),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Database.node,
    EventV2.node,
    SessionStore.node,
    SessionEffectiveConfig.node,
    SessionRunnerModel.node,
    SessionScheduler.node,
    Snapshot.node,
    WorldMemory.node,
    llmClient,
  ],
})
