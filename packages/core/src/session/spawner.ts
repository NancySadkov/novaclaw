export * as SessionSpawner from "./spawner"

import { and, count, eq, gt, isNull } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { copySessionRecipes, storeRootIn } from "../adhoc-tools"
import { makeLocationNode } from "../effect/app-node"
import { KeyedMutex } from "../effect/keyed-mutex"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { Global } from "../global"
import { ProjectV2 } from "../project"
import { Location } from "../location"
import { AgentV2 } from "../agent"
import { ModelV2 } from "../model"
import { createSessionRecord } from "../session"
import { SessionRunCoordinator } from "./run-coordinator"
import { SessionStore } from "./store"
import { SessionTable } from "./sql"
import { SessionInput } from "./input"
import { SessionSchema } from "./schema"
import { SessionMessage } from "./message"
import { Prompt } from "./prompt"

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

/** Recursion-depth cap: a child deeper than this is refused (fork-bomb guard, must ship with spawn). */
export const MAX_SPAWN_DEPTH = 8

/** Active fan-out cap: one parent may have at most this many unfinished direct children (K1 quota). */
export const MAX_SPAWN_CHILDREN = 16

/** Rate cap: one parent may spawn at most this many children per rolling minute (K1 quota). */
export const MAX_SPAWNS_PER_MINUTE = 10
const RATE_WINDOW_MS = 60_000

/** Raised when a spawn quota trips (depth / children / rate) — surfaced to the model, not fatal. */
export class SpawnLimitError extends Schema.TaggedErrorClass<SpawnLimitError>()("SessionSpawner.LimitError", {
  reason: Schema.Literals(["depth", "children", "rate"]),
  depth: Schema.Number,
  limit: Schema.Number,
}) {}

export interface SpawnInput {
  /** The spawning session — becomes the child's `parentID`, the root of config inheritance. */
  readonly parentID: SessionSchema.ID
  /** The child's opening prompt — admitted with delivery "queue", then woken (see `SpawnResult`). */
  readonly text: string
  readonly agent?: AgentV2.ID
  readonly model?: ModelV2.Ref
  readonly systemPromptOverride?: string
  /** Thread type for the child (defaults to "sub-agent" — a spawned session waits on its supervisor). */
  readonly type?: "interactive" | "sub-agent" | "auto-prompting" | "goal-oriented"
  readonly priority?: number
  /** Child mode request — resolveConfig NARROWS it against the parent chain (never escalates). */
  readonly permissionMode?: "plan" | "ask" | "surgical" | "bypass" | "yolo"
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
  readonly spawn: (input: SpawnInput) => Effect.Effect<SpawnResult, SpawnLimitError>
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
    const wake = yield* SessionRunCoordinator.Wake
    // The ad-hoc store's root through the SERVICE, composed with `storeRootIn` — the same
    // resolution `adhoc-tools/guidance.ts`, `tool/tool-manual.ts` and `tool/define-tool.ts` use, so
    // the 4D copy below lands in the root the child's own prompt will later read. Identical in
    // production; the point is that one graph can only ever have one answer.
    const sessionStoreRoot = storeRootIn((yield* Global.Service).data)
    // The session rows ARE the durable quota ledger. A per-parent mutex makes the count+create
    // decision atomic within the one instance process; a restart loses no history, and unrelated
    // parents still spawn concurrently.
    const spawnLocks = KeyedMutex.makeUnsafe<string>()
    return Service.of({
      spawn: Effect.fn("SessionSpawner.spawn")(function* (input) {
        const child = yield* spawnLocks.withLock(input.parentID)(
          Effect.gen(function* () {
            // Fork-bomb guards (K1): recursion depth + ACTIVE direct fan-out + durable spawn rate.
            // Depth is a cycle-guarded parentID walk, like resolveSessionConfig.
            let depth = 0
            let ancestor: SessionSchema.ID | undefined = input.parentID
            const seen = new Set<string>()
            while (ancestor !== undefined && !seen.has(ancestor)) {
              seen.add(ancestor)
              const parent: SessionSchema.Info | undefined = yield* store.get(ancestor)
              if (!parent) break
              depth++
              ancestor = parent.parentID
            }
            if (depth >= MAX_SPAWN_DEPTH)
              return yield* Effect.fail(new SpawnLimitError({ reason: "depth", depth, limit: MAX_SPAWN_DEPTH }))

            const active = yield* db
              .select({ n: count() })
              .from(SessionTable)
              .where(and(eq(SessionTable.parent_id, input.parentID), isNull(SessionTable.result)))
              .get()
              .pipe(Effect.orDie)
            if ((active?.n ?? 0) >= MAX_SPAWN_CHILDREN)
              return yield* Effect.fail(
                new SpawnLimitError({ reason: "children", depth: active?.n ?? 0, limit: MAX_SPAWN_CHILDREN }),
              )

            const now = Date.now()
            const recent = yield* db
              .select({ n: count() })
              .from(SessionTable)
              .where(
                and(eq(SessionTable.parent_id, input.parentID), gt(SessionTable.time_created, now - RATE_WINDOW_MS)),
              )
              .get()
              .pipe(Effect.orDie)
            if ((recent?.n ?? 0) >= MAX_SPAWNS_PER_MINUTE)
              return yield* Effect.fail(
                new SpawnLimitError({ reason: "rate", depth: recent?.n ?? 0, limit: MAX_SPAWNS_PER_MINUTE }),
              )

            return yield* createSessionRecord(
              { db, events, projects, store },
              {
                parentID: input.parentID,
                agent: input.agent,
                model: input.model,
                systemPromptOverride: input.systemPromptOverride,
                // A spawned session is a sub-agent thread unless the caller says otherwise (Vision).
                type: input.type ?? "sub-agent",
                priority: input.priority,
                permissionMode: input.permissionMode,
                location, // the parent's location = this seam's location
              },
            )
          }),
        )
        // 4D: the child inherits the parent's session-DEFINED ad-hoc recipes (copy-on-spawn —
        // the session scope is the "hand your sub-agents a tool set" channel). Best-effort:
        // a store hiccup must never fail the spawn.
        yield* Effect.tryPromise(() => copySessionRecipes(input.parentID, child.id, { root: sessionStoreRoot })).pipe(
          Effect.catch((cause) => Effect.logWarning("adhoc-tool copy-on-spawn failed", { cause }).pipe(Effect.as(0))),
        )
        yield* SessionInput.admit(db, events, {
          id: SessionMessage.ID.create(),
          sessionID: child.id,
          prompt: Prompt.make({ text: input.text }),
          delivery: "queue",
        })
        // B1: RUN the child. Strictly after the admit — the executor's drain reads the queued row
        // from the database, so waking first is a race that ends in an empty turn. `wake` coalesces
        // and never fails, so this cannot turn a completed spawn into a reported failure.
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
    // Global only — a dependency-free hoisted global (`Global.node` declares `deps: []`), so it adds
    // no edge to the cycle-free set the header above is protecting.
    Global.node,
  ],
})
