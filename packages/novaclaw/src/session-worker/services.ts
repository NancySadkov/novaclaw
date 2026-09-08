export * as SessionWorkerServices from "./services"

import { Effect, Layer, Schema, Stream } from "effect"
import { EventV2 } from "@novaclaw/core/event"
import { PermissionV2 } from "@novaclaw/core/permission"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionScheduler } from "@novaclaw/core/session/scheduler"
import { SessionSpawner } from "@novaclaw/core/session/spawner"
import { ColleagueHandoff } from "@novaclaw/core/session/colleague-handoff"
import { SessionJoin } from "@novaclaw/core/session/join"
import { Memory } from "@novaclaw/core/kb-graph/memory"
import { WorldMemory } from "@novaclaw/core/kb-graph/world-memory"
import { LocalModelManager } from "@novaclaw/core/local-model-manager"
import { SessionDriveState } from "@novaclaw/core/session/runner/drive-state"
import { Log } from "@novaclaw/schema/log"
import type { LocalModel } from "@novaclaw/schema/local-model"
import type { ConfigLocalModelCatalog } from "@novaclaw/core/config/local-model-catalog"
import { MemoryClient } from "@novaclaw/core/kb-graph/memory-client"
import { SessionWorkerProtocol } from "@novaclaw/core/session/execution/worker-protocol"
import { EventManifest } from "@novaclaw/schema/event-manifest"
import { AgentV2 } from "@novaclaw/core/agent"
import type { SessionWorkerCapabilities } from "./capabilities"
import { makeGlobalNode, makeLocationNode } from "@novaclaw/core/effect/app-node"
import { LayerNode } from "@novaclaw/core/effect/layer-node"

const unavailable = (operation: string) => new Error(`${operation} is host-only in a session worker`)
// `session.status` used to be whitelisted here past the served set; it is IN the served set since
// 2026-09-03 (the manifest's `ServerDefinitions` note), so the set is the manifest's alone.
const hostEvents = new Set<string>(EventManifest.ServerDefinitions.map((definition) => definition.type))

const LIVE_DELTA_TYPES = new Set(["session.next.text.delta", "session.next.reasoning.delta"])
const LIVE_DELTA_FLUSH_MS = 16

type QueuedLiveDelta = {
  readonly definition: EventV2.Definition
  readonly data: Record<string, unknown>
  readonly metadata: Record<string, unknown> | undefined
  readonly key: string
}

const liveDeltaKey = (type: string, data: Record<string, unknown>) =>
  [type, data.sessionID, data.assistantMessageID, data.textID ?? data.reasoningID].join("\0")

/** Effect service implementations consumed by the real runner layer. Read/list/reply surfaces stay
 * host-only; only capabilities the draining worker legitimately needs cross the boundary. */
export function make(capabilities: SessionWorkerCapabilities.Capabilities): {
  readonly events: EventV2.Interface
  readonly permission: PermissionV2.Interface
  readonly scheduler: SessionScheduler.Interface
  readonly spawner: SessionSpawner.Interface
  readonly join: SessionJoin.Interface
  readonly colleague: ColleagueHandoff.Interface
  readonly memory: MemoryClient.Interface
  readonly worldMemory: MemoryClient.Interface
  readonly localModel: LocalModelManager.Interface
  readonly driveState: SessionDriveState.Interface
} {
  // Text/reasoning deltas are deliberately live-only. Progress checkpoints and Ended events are
  // the storage-linear/replayable boundaries, so a dropped live fragment is corrected by the next
  // checkpoint or the final value. Keep the queue here, at the worker seam, because this is where a
  // single model delta otherwise becomes a host RPC. Consecutive fragments for one stream become
  // one host publication; different streams stay ordered queue entries.
  let liveDeltaQueue: QueuedLiveDelta[] = []
  let liveDeltaTimer: ReturnType<typeof setTimeout> | undefined
  let liveDeltaWrites = Promise.resolve()

  const flushLiveDeltas = () => {
    if (liveDeltaTimer !== undefined) {
      clearTimeout(liveDeltaTimer)
      liveDeltaTimer = undefined
    }
    if (liveDeltaQueue.length === 0) return liveDeltaWrites
    const queued = liveDeltaQueue
    liveDeltaQueue = []
    liveDeltaWrites = liveDeltaWrites.then(async () => {
      for (const item of queued) {
        const encoded = Schema.encodeUnknownSync(item.definition.data)(item.data)
        await capabilities.publishEvent(item.definition.type, encoded, item.metadata)
      }
    })
    return liveDeltaWrites
  }

  const scheduleLiveDeltaFlush = () => {
    if (liveDeltaTimer !== undefined) return
    liveDeltaTimer = setTimeout(() => {
      liveDeltaTimer = undefined
      // Live-only delivery is best effort by design. A following progress/end event still reports
      // the authoritative value and propagates any host publication failure through the normal path.
      void flushLiveDeltas().catch(() => {})
    }, LIVE_DELTA_FLUSH_MS)
  }

  const events: EventV2.Interface = {
    publish: (definition, data, options) => {
      if (options?.commit) return Effect.die(unavailable("event commit callback"))
      if (options?.id) return Effect.die(unavailable("caller-assigned event id"))
      // The worker runs the server's ordinary location layers, so boot and runner code may publish
      // catalog, filesystem, PTY, and session-record events as well as message events. Forward the
      // complete server manifest through the host-owned bus so ids, projections, and subscriptions
      // remain authoritative. Events that exist only in a UI/process-local manifest stay local.
      if (!hostEvents.has(definition.type)) {
        if (definition.durable) return Effect.die(unavailable(`durable ${definition.type} event publication`))
        return Effect.succeed({
          id: EventV2.ID.create(),
          type: definition.type,
          data,
          ...(options?.metadata === undefined ? {} : { metadata: options.metadata }),
        })
      }

      if (LIVE_DELTA_TYPES.has(definition.type)) {
        const delta = data as Record<string, unknown>
        const key = liveDeltaKey(definition.type, delta)
        const metadata = options?.metadata
        const previous = liveDeltaQueue.at(-1)
        if (previous && previous.key === key && previous.metadata === metadata) {
          previous.data.delta = `${previous.data.delta as string}${delta.delta as string}`
        } else {
          liveDeltaQueue.push({
            definition,
            data: { ...delta },
            metadata,
            key,
          })
        }
        scheduleLiveDeltaFlush()
        return Effect.succeed({
          id: EventV2.ID.create(),
          type: definition.type,
          data,
          ...(metadata === undefined ? {} : { metadata }),
        })
      }

      // A checkpoint, terminal value, or any other host event is the ordering boundary for queued
      // live fragments. Awaiting this chain keeps the host's event sequence identical to the
      // worker's logical publication order.
      const encoded = Schema.encodeUnknownSync(definition.data)(data)
      return Effect.promise(() => flushLiveDeltas()).pipe(
        Effect.andThen(Effect.promise(() => capabilities.publishEvent(definition.type, encoded, options?.metadata))),
        Effect.map((published) => ({
          id: published.eventID,
          type: definition.type,
          data,
          ...(published.durable === undefined ? {} : { durable: published.durable }),
        })),
      )
    },
    subscribe: () => Stream.die(unavailable("event subscription")),
    all: () => Stream.die(unavailable("event stream")),
    durable: () => Stream.die(unavailable("durable event stream")),
    // Plugins are materialized in the worker so their registered tools can execute there, but their
    // event reactions belong to the host's long-lived location service. Registering the same
    // listener in a one-drain worker would duplicate reactions and it has no inbound event stream;
    // accept registration as an inert subscription with an idempotent unsubscribe.
    listen: () => Effect.succeed(Effect.void),
    project: () => Effect.die(unavailable("event projector")),
    replay: () => Effect.die(unavailable("event replay")),
    replayAll: () => Effect.die(unavailable("event replay")),
    remove: () => Effect.die(unavailable("event removal")),
    claim: () => Effect.die(unavailable("event ownership claim")),
  }

  const assertPermission = (
    request: PermissionV2.AssertInput,
  ): Effect.Effect<void, PermissionV2.Error | SessionV2.NotFoundError> =>
    Effect.tryPromise({
      try: () => capabilities.assertPermission(request),
      catch: () => new PermissionV2.DeniedError({ rules: [] }),
    }).pipe(
      Effect.flatMap((result): Effect.Effect<void, PermissionV2.Error | SessionV2.NotFoundError> => {
        switch (result.outcome) {
          case "allowed":
            return Effect.void
          case "denied":
            return Effect.fail(
              new PermissionV2.DeniedError({
                rules: result.rules ?? [],
                ...(Schema.is(PermissionV2.DenialReason)(result.reason) ? { reason: result.reason } : {}),
              }),
            )
          case "session-missing":
            return Effect.fail(new SessionV2.NotFoundError({ sessionID: request.sessionID }))
          case "rejected":
            return Effect.fail(new PermissionV2.DeniedError({ rules: [] }))
        }
      }),
    )

  const permission: PermissionV2.Interface = {
    /**
     * ⚠️ `ask` INSPECTS without prompting, which is why it is not bridged to the host the way
     * `assert` is: the host's answer costs a consent card when the rule says "ask", and a capability
     * REPORT that prompts once per colleague is not a report.
     *
     * The CEO's floor needs no host at all — it is an org-chart fact, not a stored rule — so it is
     * answered here and matches what `permission.ts` answers on the host side. Everyone else still
     * gets the unavailable defect; callers are expected to degrade (see `tool/self.ts`, which treats
     * an unanswerable question as "no" and now catches this).
     */
    ask: (input) =>
      AgentV2.hasFullAuthority(input.agent)
        ? Effect.succeed({ id: input.id ?? PermissionV2.ID.create(), effect: "allow" as const })
        : Effect.die(unavailable("permission request inspection")),
    assert: assertPermission,
  }

  const scheduler: SessionScheduler.Interface = {
    admit: (request) => Effect.promise(() => capabilities.admitDevice(request)).pipe(Effect.asVoid),
    release: (request) => Effect.promise(() => capabilities.releaseDevice(request)).pipe(Effect.asVoid),
    report: (request) => Effect.promise(() => capabilities.reportDevice(request)).pipe(Effect.asVoid),
    admitMaintenance: (request) => Effect.promise(() => capabilities.admitMaintenance(request)),
    awaitMaintenancePreemption: (request) =>
      Effect.promise(() => capabilities.awaitMaintenancePreemption(request.lease)).pipe(Effect.asVoid),
    // `ownerID` is deliberately not forwarded: the host stamps ownership from the fenced worker
    // lease, so worker code can neither claim nor release another session's maintenance slot.
    releaseMaintenance: (request) =>
      Effect.promise(() => capabilities.releaseMaintenance(request.lease)).pipe(Effect.asVoid),
    evict: () => Effect.die(unavailable("scheduler eviction")),
    snapshot: () => Effect.die(unavailable("scheduler snapshot")),
  }

  /**
   * 🔴 Spawn is the ONE kernel operation that concerns two sessions, so in a worker it is an RPC.
   *
   * The real spawner publishes the child's creation event and admits the child's first input — both
   * carrying an id that is not this worker's lease, which `event-bridge.ts` rejects by design. That
   * left `spawn` dead on the live runner between 2026-08-04 and this replacement. The host owns the
   * operation now, exactly as it owns permission decisions.
   *
   * ⚠️ **`input.parentID` is intentionally DROPPED.** The host uses the lease's session id, so a
   * worker spawns children of itself and of nothing else. Passing it would imply a choice that does
   * not exist, and a reader who saw it forwarded would reasonably assume forging one is possible.
   */
  const spawner: SessionSpawner.Interface = {
    spawn: (request) =>
      Effect.promise(() =>
        capabilities.spawnChild({
          text: request.text,
          ...(request.agent === undefined ? {} : { agent: request.agent }),
          ...(request.model === undefined ? {} : { model: request.model }),
          ...(request.controlBinding === undefined ? {} : { controlBinding: request.controlBinding }),
          ...(request.systemPromptOverride === undefined ? {} : { systemPromptOverride: request.systemPromptOverride }),
          ...(request.type === undefined ? {} : { type: request.type }),
          ...(request.priority === undefined ? {} : { priority: request.priority }),
          ...(request.permissionMode === undefined ? {} : { permissionMode: request.permissionMode }),
        }),
      ).pipe(
        Effect.flatMap((reply) => {
          if (reply.outcome === "spawned" && reply.child !== undefined)
            return Effect.succeed({ id: reply.child, started: reply.started ?? false })
          // A quota refusal is the spawner's OWN typed failure and must arrive as one, so the tool
          // reports "you hit the child limit" rather than an opaque transport error.
          if (reply.outcome === "limit")
            return Effect.fail(
              new SessionSpawner.SpawnLimitError({
                reason: reply.reason ?? "children",
                depth: reply.depth ?? 0,
                limit: reply.limit ?? 0,
              }),
            )
          return Effect.die(unavailable("spawn"))
        }),
      ),
  }

  /**
   * Handing work to a COLLEAGUE — the same class as `spawner` and `join` above: the delivery touches
   * a session that is NOT this worker's, so it happens host-side and the worker only asks.
   *
   * ⚠️ A rejection DIES rather than returning a polite false. `no-chat` is a real answer the model
   * acts on ("nobody has that conversation open"), while `rejected` means a stale lease — reporting
   * that as "they have no chat" would send the model off to tell the user something untrue about a
   * colleague that is perfectly fine.
   */
  const colleague: ColleagueHandoff.Interface = {
    // 🔴 STAFFING CROSSES TOO, and it must. The first build refused it here on the theory that only
    // delivery needed the host — and a hire then wrote the store from inside the worker, reloaded
    // the WORKER's roster, and left the new colleague durable and invisible to the instance
    // (measured: `Procius` was in `GET /config` and absent from `GET /api/agent`). The rule is not
    // "messages cross"; it is that anything whose EFFECT the host must see happens on the host.
    hire: (request) =>
      Effect.promise(() => capabilities.colleague({ op: "hire", ...request })).pipe(
        Effect.flatMap((reply) =>
          reply.outcome === "hired" && reply.hiredID !== undefined
            ? Effect.succeed({ id: reply.hiredID, name: reply.hiredName ?? reply.hiredID })
            : Effect.die(unavailable("colleague hire")),
        ),
      ),
    retire: (colleague) =>
      Effect.promise(() => capabilities.colleague({ op: "retire", colleague })).pipe(
        Effect.flatMap((reply) =>
          reply.outcome === "retired" ? Effect.succeed(true) : Effect.die(unavailable("colleague retire")),
        ),
      ),
    setSuperior: (request) =>
      Effect.promise(() =>
        capabilities.colleague({ op: "set_superior", colleague: request.colleague, superior: request.superior }),
      ).pipe(
        Effect.flatMap((reply) =>
          reply.outcome === "organized"
            ? Effect.succeed(true)
            : reply.outcome === "organization-refused"
              ? Effect.succeed(false)
              : Effect.die(unavailable("colleague organization")),
        ),
      ),
    deliver: (request) =>
      Effect.promise(() =>
        capabilities.colleague({ op: "ask", colleague: request.colleague, message: request.message }),
      ).pipe(
        Effect.flatMap((reply): Effect.Effect<ColleagueHandoff.Delivery> => {
          if (reply.outcome === "delivered") return Effect.succeed({ delivered: true, started: reply.started ?? false })
          if (reply.outcome === "no-chat") return Effect.succeed({ delivered: false, started: false })
          // The loop bound's refusal, rebuilt on this side so the TOOL sees the same `Delivery` shape
          // it would have seen host-side. Without this arm a bound would `die` here as an
          // unavailability — the sender would lose its turn instead of being told to go to the user.
          if (reply.outcome === "refused")
            return Effect.succeed({
              delivered: false,
              started: false,
              refused: reply.reason ?? "That hand-off was refused by this instance's colleague-loop limit.",
            })
          return Effect.die(unavailable("colleague hand-off"))
        }),
      ),
    deliverGroup: (request) =>
      Effect.promise(() =>
        capabilities.colleague({ op: "ask_group", colleagues: [...request.colleagues], message: request.message }),
      ).pipe(
        Effect.flatMap((reply): Effect.Effect<ColleagueHandoff.GroupDelivery> => {
          if (reply.outcome === "group-delivered")
            return Effect.succeed({
              delivered: reply.delivered ?? [],
              missing: reply.missing ?? [],
              started: reply.started ?? false,
              ...(reply.conversation === undefined ? {} : { conversation: reply.conversation }),
            })
          if (reply.outcome === "no-chat") return Effect.succeed({ delivered: [], missing: [], started: false })
          // Rebuilt on this side so the TOOL sees the same shape it would host-side — the same
          // reason the 1:1 arm above does it. A bound that `die`d here would cost the sender its
          // turn instead of telling it to go back to the user.
          if (reply.outcome === "refused")
            return Effect.succeed({
              delivered: [],
              missing: [],
              started: false,
              refused: reply.reason ?? "That hand-off was refused by this instance's colleague-loop limit.",
            })
          return Effect.die(unavailable("colleague group hand-off"))
        }),
      ),
  }

  /**
   * 🔴 `wait` joined a child through `events.durable(...)`, which the replacement above DIES on — so
   * `wait` failed in every session worker with "only works in host-only contexts". Same class as
   * spawn, found the moment fixing spawn let the live smoke reach the test that exercises it.
   *
   * It is a request/response rather than a forwarded stream because `wait` only ever wanted the FIRST
   * completion with a deadline. Forwarding a live stream across the protocol would be a much larger
   * job for a value nobody reads.
   */
  const join: SessionJoin.Interface = {
    awaitCompletion: (request) =>
      Effect.promise(() => capabilities.awaitChild({ childID: request.childID, timeoutMs: request.timeoutMs })).pipe(
        Effect.flatMap((reply): Effect.Effect<SessionJoin.Outcome> => {
          if (reply.outcome === "completed")
            return Effect.succeed(
              reply.result === undefined
                ? ({ completed: true } satisfies SessionJoin.Outcome)
                : ({ completed: true, result: reply.result } satisfies SessionJoin.Outcome),
            )
          // A timeout is the honest answer, not a fault: the child may still be working.
          if (reply.outcome === "timeout") return Effect.succeed({ completed: false } satisfies SessionJoin.Outcome)
          return Effect.die(unavailable("child join"))
        }),
      ),
  }

  /**
   * 🔴 **THE MEMORY GRAPH HAS ONE WRITER, AND FROM HERE IT IS THE HOST'S.**
   *
   * Every other service in this file crosses because its EFFECT must be visible to the host. Memory
   * crosses because its STORE must be the host's — which is the same rule one level down. Measured:
   * `replacements()` swapped seven services and not `Memory.node`, so a worker built a real second
   * WASM engine on `<instance data>/memory/graph` while the host's lazy engine opened the moment
   * anything host-side read memory during a live turn. `memory.ts`'s header claimed single-writer
   * throughout; generation snapshots then made two writers destructive rather than merely redundant,
   * because `publish()` picks `max(existing) + 1` and each writer prunes to KEEP=2 without knowing
   * about the other's generations.
   *
   * ⚠️ **It also fixes observation, which nothing was watching.** The host's layer provides the
   * OBSERVED client — `memory.*` events on the host bus, access-ledger rows in the host database. A
   * worker-local engine published to the worker's own bus, so a claim written mid-turn was invisible
   * to the Memory app by construction, and the ledger rows the pruning policy reads were split across
   * two processes.
   *
   * ⚠️ **The cost is an RPC per memory op**, and auto-recall makes one `search` per turn. That is a
   * request/response over the same stdio line protocol every permission assertion already uses, on a
   * path that was already going to open a WASM engine.
   */
  const memoryOp = <A>(
    store: "kb" | "world",
    op: SessionWorkerProtocol.MemoryOp,
    args: ReadonlyArray<unknown>,
  ): Effect.Effect<A, MemoryClient.MemoryError> =>
    Effect.tryPromise({
      try: () => (store === "kb" ? capabilities.memory(op, args) : capabilities.worldMemory(op, args)),
      catch: (cause) => new MemoryClient.MemoryError({ reason: String(cause).slice(0, 300) }),
    }).pipe(
      Effect.flatMap((reply) =>
        reply.outcome === "ok"
          ? Effect.succeed(reply.value as A)
          : // A host-side REJECTION reaches the model as an ordinary memory failure, because that is
            // what a caller can act on — every consumer of this interface already degrades when the
            // store says no. The distinction survives in `reason`, which is where a person debugging
            // it will look.
            Effect.fail(new MemoryClient.MemoryError({ reason: reply.reason ?? `memory ${op} ${reply.outcome}` })),
      ),
    )

  const makeMemory = (store: "kb" | "world"): MemoryClient.Interface => ({
    // `health` never fails by contract, so an unreachable host reads as "memory is not available"
    // rather than taking a turn down — the same stance the lazy client takes when the engine is off.
    health: () => memoryOp<boolean>(store, "health", []).pipe(Effect.orElseSucceed(() => false)),
    addMemory: (input) => memoryOp<void>(store, "addMemory", [input]),
    addEdge: (input, access) => memoryOp<MemoryClient.EdgeResult>(store, "addEdge", [input, access]),
    search: (input) => memoryOp<ReadonlyArray<MemoryClient.SearchHit>>(store, "search", [input]),
    neighbors: (id, access, opts) =>
      memoryOp<ReadonlyArray<MemoryClient.Neighbor>>(store, "neighbors", [id, access, opts]),
    get: (id, access) => memoryOp<MemoryClient.MemoryRow | null>(store, "get", [id, access]),
    path: (from, to, access, maxHops) =>
      memoryOp<MemoryClient.PathResult | null>(store, "path", [from, to, access, maxHops]),
    invalidate: (id, access, at) => memoryOp<void>(store, "invalidate", [id, access, at]),
    purge: (id, access) => memoryOp<void>(store, "purge", [id, access]),
    addClaim: (input, access) => memoryOp<MemoryClient.ClaimResult>(store, "addClaim", [input, access]),
    claimHistory: (id, access) => memoryOp<MemoryClient.ClaimHistory | null>(store, "claimHistory", [id, access]),
    reviewEvidence: (locator, access) => memoryOp<number>(store, "reviewEvidence", [locator, access]),
    setClaimStatus: (id, status, access) => memoryOp<boolean>(store, "setClaimStatus", [id, status, access]),
    moveScope: (from, to) => memoryOp<void>(store, "moveScope", [from, to]),
    clearScope: (scope) => memoryOp<void>(store, "clearScope", [scope]),
    eraseAll: () => memoryOp<number>(store, "eraseAll", []),
    discardLegacyGlobalExtracts: () => memoryOp<number>(store, "discardLegacyGlobalExtracts", []),
    stats: () => memoryOp<MemoryClient.Stats>(store, "stats", []),
    list: (input) => memoryOp<ReadonlyArray<MemoryClient.MemoryRow>>(store, "list", [input]),
    candidates: (input) => memoryOp<ReadonlyArray<MemoryClient.CandidateRow>>(store, "candidates", [input]),
    byIds: (ids) => memoryOp<ReadonlyArray<MemoryClient.MemoryRow>>(store, "byIds", [ids]),
    graph: (input) => memoryOp<MemoryClient.MemoryGraph>(store, "graph", [input]),
  })

  const memory = makeMemory("kb")
  const worldMemory = makeMemory("world")

  /**
   * 🔴 **THE MANAGED LOCAL MODEL HAS ONE RUNTIME, AND FROM HERE IT IS THE HOST'S.**
   *
   * Memory's rule, one rung down the stack. `ServerLocationServiceMap.replacements` points
   * `LocalModelManager.node` at `LocalModelRuntime.managerNode`, and `runner-layer.ts` compiles that
   * list into the worker too — so every worker built its OWN runtime with its own closure state
   * (`state`, `child`, `loading`), and `ensure()`, which every provider turn calls, could never take
   * the "already ready" branch in a fresh process. It spawned a second `llama-server` on the same
   * fixed port: either the bind failed while `waitUntilReady` was answered by the HOST's engine (a
   * dead child reported ready, every turn paying a spawn and a memory preflight), or the worker's
   * child bound first and the supervisor tree-killed it with the worker at the end of the turn, so
   * the model reloaded from scratch on the next one. Either way the engine was invisible to the
   * host's fleet accounting.
   *
   * `ensure` is one RPC to the host's runtime and fails as the `UnavailableError` the model resolver
   * already handles. The three status-shaped ops never cross: nothing in a worker calls them, and a
   * session process must not be able to `stop` the engine every other session is served by. They
   * answer a status that names the boundary, because their contract never fails.
   */
  const ensureOnHost = (request: LocalModelManager.ModelRequest, overrides?: ConfigLocalModelCatalog.Info) =>
    Effect.tryPromise({
      try: () => capabilities.localModel("ensure", [request, overrides]),
      catch: (cause) => new LocalModelManager.UnavailableError({ message: String(cause).slice(0, 300) }),
    }).pipe(
      Effect.flatMap((reply) =>
        reply.outcome === "ok"
          ? Effect.void
          : Effect.fail(
              new LocalModelManager.UnavailableError({
                message: reply.reason ?? `the host could not start the local model (${reply.outcome})`,
              }),
            ),
      ),
    )
  const hostOnly: LocalModel.Status = {
    supported: false,
    platform: `${process.platform}-${process.arch}`,
    profiles: [],
    stage: "idle",
    recommendedContext: 65_536,
    message: "The managed local model is controlled by the host process; a session can only ask for it to be running.",
  }
  const localModel: LocalModelManager.Interface = {
    status: () => Effect.succeed(hostOnly),
    install: () => Effect.succeed(hostOnly),
    ensure: ensureOnHost,
    stop: () => Effect.succeed(hostOnly),
  }

  /**
   * 🔴 **THE RUNNER'S CROSS-DRAIN FACTS LIVE IN THE HOST.**
   *
   * `llm.ts` keeps six maps the drives need across drains and calls them "session-scoped, this
   * process" — true for the in-process executor, false here, where the runner layer is built inside
   * ONE drain and disposed with the worker. Every steer started a fresh worker with six empty maps:
   * the barren-round stop never reached its bound, the coverage ledger restarted at the first file,
   * and the child-restart ceiling never counted (the three measured defects the maps were built to
   * fix, all back). `SessionDriveState` is the store; this client is the worker's view of the host's.
   *
   * `load` and `save` are RPCs. The three pinning calls are pass-throughs on purpose: the HOST pins
   * the session for the worker's whole life (`execution.ts`), because only the host knows when the
   * run really ends. A `load` that cannot reach the host answers `empty` — the session starts the
   * drain as a fresh one, which may repeat visible steering but never marks unfinished work done —
   * and a `save` that cannot reach it is lost the way the whole map used to be lost every drain.
   */
  const driveStateOp = (op: SessionWorkerProtocol.DriveStateOp, args: ReadonlyArray<unknown>) =>
    Effect.tryPromise({
      try: () => capabilities.driveState(op, args),
      catch: (cause) => new Error(String(cause).slice(0, 300)),
    }).pipe(
      Effect.flatMap((reply) =>
        reply.outcome === "ok"
          ? Effect.succeed(reply.value)
          : Effect.fail(new Error(reply.reason ?? `drive state ${op} ${reply.outcome}`)),
      ),
    )
  const driveState: SessionDriveState.Interface = {
    load: (sessionID) =>
      driveStateOp("load", []).pipe(
        Effect.map((value) => SessionDriveState.decode(value) ?? SessionDriveState.empty),
        Effect.catch(() => Effect.succeed(SessionDriveState.empty)),
        Effect.tap((snapshot) =>
          Log.event("session.drive.hydrated", {
            "session.id": sessionID,
            "drive.opened": snapshot.opened.length,
            "drive.barren": snapshot.barren?.barren ?? 0,
          }),
        ),
      ),
    save: (_sessionID, snapshot) =>
      driveStateOp("save", [snapshot]).pipe(
        Effect.map(() => undefined),
        Effect.ignore,
      ),
    withSession: (_sessionID, effect) => effect,
    pin: () => Effect.void,
    unpin: () => Effect.void,
  }

  return { events, permission, scheduler, spawner, join, colleague, memory, worldMemory, localModel, driveState }
}

export function replacements(capabilities: SessionWorkerCapabilities.Capabilities): LayerNode.Replacements {
  const services = make(capabilities)
  return [
    [
      EventV2.node,
      makeGlobalNode({ service: EventV2.Service, layer: Layer.succeed(EventV2.Service, services.events), deps: [] }),
    ],
    [
      PermissionV2.node,
      makeLocationNode({
        service: PermissionV2.Service,
        layer: Layer.succeed(PermissionV2.Service, services.permission),
        deps: [],
      }),
    ],
    [
      ColleagueHandoff.node,
      makeLocationNode({
        service: ColleagueHandoff.Service,
        layer: Layer.succeed(ColleagueHandoff.Service, services.colleague),
        deps: [],
      }),
    ],
    [
      SessionJoin.node,
      makeLocationNode({
        service: SessionJoin.Service,
        layer: Layer.succeed(SessionJoin.Service, services.join),
        deps: [],
      }),
    ],
    [
      SessionSpawner.node,
      makeLocationNode({
        service: SessionSpawner.Service,
        layer: Layer.succeed(SessionSpawner.Service, services.spawner),
        deps: [],
      }),
    ],
    /**
     * 🔴 **`Memory.node`, replaced the same way the other seven are — this is the single-writer fix.**
     *
     * It is rebuilt rather than pointed at, because `Memory.node` is a CAPABILITY node: consumers
     * hold `Capability<MemoryClient.Interface>` and resolve it per call, and a replacement has to
     * have the same shape or the deferral disappears along with the engine. So the proxying client
     * goes into a service node and that node is wrapped in the same `LayerNode.capability` with the
     * same name — which is also what keeps `capabilities()` reporting one `memory` capability rather
     * than two.
     *
     * ⚠️ `repair` is deliberately the SAME hint as the real node's. A worker whose memory is
     * unavailable is a worker whose HOST memory is unavailable, and pointing a reader at a different
     * knob depending on which process noticed would be a lie about where the problem is.
     */
    [
      Memory.node,
      LayerNode.capability(
        makeGlobalNode({
          service: MemoryClient.Service,
          layer: Layer.succeed(MemoryClient.Service, services.memory),
          deps: [],
        }),
        {
          name: "memory",
          service: MemoryClient.Service,
          timeout: "30 seconds",
          repair: ["runtime_flags.NOVACLAW_KB_MEMORY"],
        },
      ),
    ],
    [
      WorldMemory.node,
      LayerNode.capability(
        makeGlobalNode({
          service: WorldMemory.Service,
          layer: Layer.succeed(WorldMemory.Service, services.worldMemory),
          deps: [],
        }),
        {
          name: "world-memory",
          service: WorldMemory.Service,
          timeout: "30 seconds",
          repair: ["runtime_flags.NOVACLAW_WORLD_MEMORY"],
        },
      ),
    ],
    [
      SessionScheduler.node,
      makeGlobalNode({
        service: SessionScheduler.Service,
        layer: Layer.succeed(SessionScheduler.Service, services.scheduler),
        deps: [],
      }),
    ],
    /**
     * 🔴 **`LocalModelManager.node`, replaced so the worker never builds `LocalModelRuntime`.**
     *
     * The server's location map ALSO replaces this node (with the real runtime), and `runner-layer.ts`
     * concatenates that list before this one; `replacementMapFrom` lets the later entry win by name.
     * A plain global node is enough here — the real node is a capability so that the Instance
     * controls can report an unavailable runtime, and a worker reports nothing: its `ensure` either
     * lands on the host or fails as `UnavailableError`.
     */
    [
      LocalModelManager.node,
      makeGlobalNode({
        service: LocalModelManager.Service,
        layer: Layer.succeed(LocalModelManager.Service, services.localModel),
        deps: [],
      }),
    ],
    // The runner's cross-drain facts: the HOST's store, reached by RPC. See `driveState` above.
    [
      SessionDriveState.node,
      makeGlobalNode({
        service: SessionDriveState.Service,
        layer: Layer.succeed(SessionDriveState.Service, services.driveState),
        deps: [],
      }),
    ],
  ]
}
