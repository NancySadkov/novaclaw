export * as SessionSpawner from "./spawner"

import { and, count, eq, gt } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { copySessionRecipes, storeRootIn } from "../adhoc-tools"
import { makeLocationNode } from "../effect/app-node"
import { AgentWorkerCapacity } from "../agent/worker-capacity"
import { AgentConfigStore } from "../agent-config-store"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { Global } from "../global"
import { ProjectV2 } from "../project"
import { Location } from "../location"
import { AgentV2 } from "../agent"
import { ModelV2 } from "../model"
import { createSessionRecord, OwnerRequiredError } from "../session"
import { SpawnAdmission } from "./spawn-admission"
import { SessionRunCoordinator } from "./run-coordinator"
import { SessionStore } from "./store"
import { SessionTable } from "./sql"
import { SessionSchema } from "./schema"
import { SessionMessage } from "./message"
import { FileAttachment, Prompt } from "./prompt"
import { Log } from "@novaclaw/schema/log"
import { WorkerProfile } from "./worker-profile"
import { WorkerPurpose } from "./worker-purpose"

// Location-scoped seam that lets a running session (a location tool) SPAWN a child session — the OS
// `fork` (architecture.md Phase 3 step 6). It deliberately depends ONLY on the cycle-free primitives
// that create + enqueue need (Database / EventV2 / ProjectV2 / SessionStore / Location), NEVER
// `SessionV2.node` and never `SessionExecution.node`: both reach `LocationServiceMap`, which builds
// the per-location services, so a location tool reaching either would close the runner cycle
// `SessionV2 -> LocationServiceMap -> location services -> spawn -> SessionV2`. Config
// (agent/model/system-prompt/permissions) it doesn't override is inherited from the parent via
// `resolveSessionConfig` (the child carries `parentID`). The child inherits the parent's location
// (this seam's `Location`).
//
// ⚠️ The line that used to stand here — "the normal coordinator … runs it" — was FALSE, and it was
// the whole bug (B1, fixed 2026-07-28). No coordinator polled, subscribed or timed; a spawned child
// sat in the queue until a human prompted it, which no supervising agent ever does. The child is
// created, enqueued AND handed to the executor here, through the dependency-free `Wake` relay in
// `run-coordinator.ts` (its header carries why that shape and not a layer edge). When nothing is
// attached the spawn still succeeds — the input is durable — but it reports `started: false` so the
// caller can say so rather than promising a run that will not happen.

/** Shipped officer policy: workers may not spawn another generation unless the user opts in. */
export const DEFAULT_SPAWN_DEPTH = 1

/** Shipped officer policy: maximum unfinished workers across the whole worker tree. */
export const DEFAULT_MAX_WORKERS = AgentWorkerCapacity.DEFAULT_MAX_WORKERS
/** Compatibility name for callers/tests that display the shipped worker limit. */
export const MAX_SPAWN_CHILDREN = DEFAULT_MAX_WORKERS

/** Rate cap: one parent may spawn at most this many children per rolling minute (K1 quota). */
export const MAX_SPAWNS_PER_MINUTE = 10
const RATE_WINDOW_MS = 60_000

/** Raised when a spawn quota trips (depth / children / rate) — surfaced to the model, not fatal. */
export class SpawnLimitError extends Schema.TaggedErrorClass<SpawnLimitError>()("SessionSpawner.LimitError", {
  reason: Schema.Literals(["depth", "children", "rate", "pressure"]),
  depth: Schema.Number,
  limit: Schema.Number,
}) {}

export interface SpawnInput {
  /**
   * The spawning session — becomes the child's `parentID`, the root of config inheritance.
   *
   * ⚠️ **Optional since 2026-08-11, for ROOTLESS launches.** A rootless run has no
   * parent, and inventing one to satisfy this field would put a lie in the session tree — the child
   * would inherit config from a session that never asked for it, and `wait` would offer a join to a
   * supervisor that does not exist. So it is absent, and the three fork-bomb guards are SKIPPED
   * rather than faked: depth is meaningless without ancestors, and the fan-out and rate caps are
   * per-parent DB counts with nothing to count. What bounds a rootless launch is its own schedule.
   *
   * This is the ONLY thing the caps key on, so read their absence precisely: a rootless spawn is
   * unquotaed BY CONSTRUCTION, not by oversight. If rootless launches ever become model-triggerable,
   * they need their own bound — do not assume this one covers them.
   */
  readonly parentID?: SessionSchema.ID
  /** The child's opening prompt — admitted with delivery "queue", then woken (see `SpawnResult`). */
  readonly text: string
  readonly agent?: AgentV2.ID
  readonly model?: ModelV2.Ref
  /** Explicit computer display for the child. Omit to inherit from its parent. */
  readonly controlBinding?: string
  /** Thread type for the child (defaults to "sub-agent" — a spawned session waits on its supervisor). */
  readonly type?: "interactive" | "sub-agent" | "auto-prompting" | "goal-oriented"
  readonly priority?: number
  /** Child mode request — resolveConfig NARROWS it against the parent chain (never escalates). */
  readonly permissionMode?: "plan" | "ask" | "surgical" | "bypass" | "yolo"
  // ── what a non-tool caller needs, and what its absence used to cost ──────────────────────────
  //
  // ⚠️ These four landed 2026-08-11 because their absence is WHY callers bypassed this seam. The
  // `spawn` tool needs none of them, so the seam only ever carried what one caller wanted, and the
  // messenger dispatcher — which needs all four — hand-rolled `create({parentID}) + prompt()`
  // instead, quietly losing the depth cap, the fan-out cap and the durable rate count with them.
  // A seam that does not carry its callers' fields does not get used; it gets copied badly.
  /** Human-readable child title. Omit for the default. */
  readonly title?: string
  /** Opaque per-caller routing state. The messenger's relay reads its dispatch target back out. */
  readonly metadata?: Record<string, unknown>
  /** Provenance for the opening prompt — the untrusted-content framing depends on it. */
  readonly origin?: Prompt["origin"]
  /** Attachments riding the opening prompt. */
  readonly files?: readonly FileAttachment[]
}

export interface SpawnResult {
  /** The child session's id — what a later `wait(childID)` joins on. */
  readonly id: SessionSchema.ID
  /**
   * Whether the child was handed to a live executor. `false` means the opening prompt is admitted
   * and durable but nothing in this process will run it (no `SessionExecution` attached the wake
   * relay — e.g. a location graph booted without the session kernel, as the CLI debug commands do).
   */
  readonly started: boolean
}

export interface Interface {
  /**
   * ⚠️ `OwnerRequiredError` is reachable on the ROOTLESS path only (NC-SEC-020): a spawn with no
   * `parentID` creates a root, and a root names the agent it runs as. A spawn WITH a parent inherits
   * and can never raise it.
   */
  readonly spawn: (input: SpawnInput) => Effect.Effect<SpawnResult, SpawnLimitError | OwnerRequiredError>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/SessionSpawner") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const projects = yield* ProjectV2.Service
    const store = yield* SessionStore.Service
    const location = yield* Location.Service
    const agents = yield* AgentV2.Service
    const agentConfigs = yield* AgentConfigStore.Service
    const wake = yield* SessionRunCoordinator.Wake
    // The ad-hoc store's root through the SERVICE, composed with `storeRootIn` — the same
    // resolution `adhoc-tools/guidance.ts`, `tool/tool-manual.ts` and `tool/define-tool.ts` use, so
    // the 4D copy below lands in the root the child's own prompt will later read. Identical in
    // production; the point is that one graph can only ever have one answer.
    const sessionStoreRoot = storeRootIn((yield* Global.Service).data)
    // The session rows ARE the durable quota ledger. A per-parent mutex makes the count+create
    // decision atomic within the one instance process; a restart loses no history, and unrelated
    // parents still spawn concurrently.
    return Service.of({
      spawn: Effect.fn("SessionSpawner.spawn")(function* (input) {
        const parentID = input.parentID
        // Find the ROOT before taking the lock. Parent links are immutable, so this answer cannot
        // change while we wait. Quotas belong to the officer's whole worker tree; locking the
        // immediate parent let two siblings both observe the same free final slot.
        const lineage: SessionSchema.Info[] = []
        if (parentID !== undefined) {
          let ancestor: SessionSchema.ID | undefined = parentID
          const seen = new Set<string>()
          while (ancestor !== undefined && !seen.has(ancestor)) {
            seen.add(ancestor)
            const found: SessionSchema.Info | undefined = yield* store.get(ancestor)
            if (!found) break
            lineage.push(found)
            ancestor = found.parentID
          }
        }
        const root = lineage.at(-1)
        // Rootless launches serialise on one shared key rather than per-parent: they take no quota
        // decision, so the lock is only keeping `createSessionRecord` orderly.
        const child = yield* AgentWorkerCapacity.withOfficerLock(
          db,
          root?.id ?? "@rootless",
          Effect.gen(function* () {
            // The instance-wide host verdict comes first, including for rootless launches.
            // A rootless launch has no parent quota to inspect, but it still creates a worker on this host.
            const admission = yield* SpawnAdmission.check()
            if (admission.refuse !== undefined)
              return yield* Effect.fail(new SpawnLimitError({ reason: "pressure", depth: 0, limit: 0 }))

            // Fork-bomb guards (K1): recursion depth + ACTIVE direct fan-out + durable spawn rate.
            // Depth is a cycle-guarded parentID walk, like resolveSessionConfig.
            // All three key on a parent; a rootless spawn has none — see `SpawnInput.parentID`.
            const openingPrompt = {
              messageID: SessionMessage.ID.create(),
              prompt: Prompt.fromUserMessage({
                text: input.text,
                ...(input.files === undefined ? {} : { files: input.files }),
                ...(input.origin === undefined ? {} : { origin: input.origin }),
              }),
              delivery: "queue" as const,
              timestamp: yield* DateTime.now,
            }
            if (parentID === undefined)
              return yield* createSessionRecord(
                { db, events, projects, store },
                {
                  agent: input.agent,
                  model: input.model,
                  controlBinding: input.controlBinding,
                  type: input.type ?? "sub-agent",
                  priority: input.priority,
                  permissionMode: input.permissionMode,
                  title: input.title,
                  metadata: input.metadata,
                  openingPrompt,
                  location,
                },
              )
            const ownerID = [...lineage].reverse().find((row) => row.agent !== undefined)?.agent
            const owner = ownerID === undefined ? undefined : yield* agents.resolve(ownerID)
            const ownerConfig = owner as unknown as Record<string, unknown> | undefined
            const spawnDepth =
              typeof ownerConfig?.["spawnDepth"] === "number" ? ownerConfig["spawnDepth"] : DEFAULT_SPAWN_DEPTH
            // lineage length 1 means the officer itself is spawning. A depth of zero therefore
            // refuses immediately; one allows that worker but refuses the worker's own spawn.
            if (lineage.length > spawnDepth)
              return yield* Effect.fail(
                new SpawnLimitError({ reason: "depth", depth: lineage.length - 1, limit: spawnDepth }),
              )

            const rows = yield* db
              .select({
                id: SessionTable.id,
                parentID: SessionTable.parent_id,
                result: SessionTable.result,
                archived: SessionTable.time_archived,
                created: SessionTable.time_created,
                title: SessionTable.title,
                metadata: SessionTable.metadata,
              })
              .from(SessionTable)
              .all()
              .pipe(Effect.orDie)
            const activeWorkers = root ? AgentWorkerCapacity.activeDescendants(root.id, rows).length : 0
            const maxWorkers =
              ownerID === undefined
                ? DEFAULT_MAX_WORKERS
                : yield* AgentWorkerCapacity.currentLimit(agentConfigs, String(ownerID))
            if (activeWorkers >= maxWorkers)
              return yield* Effect.fail(
                new SpawnLimitError({ reason: "children", depth: activeWorkers, limit: maxWorkers }),
              )

            const now = Date.now()
            const recent = yield* db
              .select({ n: count() })
              .from(SessionTable)
              .where(and(eq(SessionTable.parent_id, parentID), gt(SessionTable.time_created, now - RATE_WINDOW_MS)))
              .get()
              .pipe(Effect.orDie)
            if ((recent?.n ?? 0) >= MAX_SPAWNS_PER_MINUTE)
              return yield* Effect.fail(
                new SpawnLimitError({ reason: "rate", depth: recent?.n ?? 0, limit: MAX_SPAWNS_PER_MINUTE }),
              )

            const configuredPrototype =
              typeof ownerConfig?.["workerPrototype"] === "string"
                ? AgentV2.ID.make(ownerConfig["workerPrototype"])
                : undefined
            const resolvedPrototype =
              configuredPrototype === undefined ? undefined : yield* agents.resolve(configuredPrototype)
            // A prototype contributes a role snapshot, never its identity. In particular, Nova may
            // not be cloned into a child: that would turn a presentation choice into CEO authority.
            const prototype =
              input.agent === undefined &&
              resolvedPrototype !== undefined &&
              AgentV2.isColleague(resolvedPrototype) &&
              !AgentV2.isProtected(String(resolvedPrototype.id)) &&
              resolvedPrototype.paused !== true
                ? resolvedPrototype
                : undefined
            const configuredWorkerModel = ownerConfig?.["workerModel"]
            const workerModel =
              typeof configuredWorkerModel === "object" &&
              configuredWorkerModel !== null &&
              typeof (configuredWorkerModel as Record<string, unknown>)["providerID"] === "string" &&
              typeof (configuredWorkerModel as Record<string, unknown>)["id"] === "string"
                ? (() => {
                    const parsed = ModelV2.parse(
                      `${(configuredWorkerModel as Record<string, string>)["providerID"]!}/${(configuredWorkerModel as Record<string, string>)["id"]!}`,
                    )
                    return { providerID: parsed.providerID, id: parsed.modelID }
                  })()
                : undefined
            const workerProfile = prototype === undefined ? undefined : WorkerProfile.capture(prototype)
            return yield* createSessionRecord(
              { db, events, projects, store },
              {
                parentID,
                // Undefined is the architectural ownership rule: anonymous workers inherit the
                // spawning officer through the parent chain. A named prototype lives only in the
                // profile snapshot below and therefore cannot steal the worker's cabinet or scope.
                agent: input.agent,
                model: input.model ?? (prototype === undefined ? workerModel : undefined),
                controlBinding: input.controlBinding,
                // A spawned session is a sub-agent thread unless the caller says otherwise (Vision).
                type: input.type ?? "sub-agent",
                priority: input.priority,
                permissionMode: input.permissionMode,
                title: input.title,
                // The delegated task is an ownership fact, not presentation. Persist it at creation
                // so the parent can reconstruct its live fleet after compaction or a process restart,
                // before the asynchronous title sampler has produced anything useful.
                metadata: {
                  ...(input.metadata ?? {}),
                  [WorkerPurpose.KEY]: WorkerPurpose.fromPrompt(input.text),
                  ...(workerProfile === undefined ? {} : { [WorkerProfile.KEY]: workerProfile }),
                },
                openingPrompt,
                location, // the parent's location = this seam's location
              },
            )
          }),
        )
        // 4D: the child inherits the parent's session-DEFINED ad-hoc recipes (copy-on-spawn —
        // the session scope is the "hand your sub-agents a tool set" channel). Best-effort:
        // a store hiccup must never fail the spawn. Nothing to inherit without a parent.
        if (parentID !== undefined)
          yield* Effect.tryPromise(() => copySessionRecipes(parentID, child.id, { root: sessionStoreRoot })).pipe(
            Effect.catch((cause) =>
              Log.event("session.adhoc.copy.failed", {
                "session.id": child.id,
                "session.cause": Log.fault(cause),
              }).pipe(Effect.as(0)),
            ),
          )
        // B1: RUN the child. Creation and admission are one durable projection, so waking here
        // cannot observe a session whose opening prompt was stranded between two events.
        const started = yield* wake.wake(child.id)
        return { id: child.id, started }
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Database.node,
    EventV2.node,
    ProjectV2.node,
    SessionStore.node,
    Location.node,
    SessionRunCoordinator.wakeNode,
    AgentV2.node,
    AgentConfigStore.node,
    // Global only — a dependency-free hoisted global (`Global.node` declares `deps: []`), so it adds
    // no edge to the cycle-free set the header above is protecting.
    Global.node,
  ],
})
