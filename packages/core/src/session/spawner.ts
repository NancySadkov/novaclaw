export * as SessionSpawner from "./spawner"

import { count, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { copySessionRecipes } from "../adhoc-tools"
import { makeLocationNode } from "../effect/app-node"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { ProjectV2 } from "../project"
import { Location } from "../location"
import { AgentV2 } from "../agent"
import { ModelV2 } from "../model"
import { createSessionRecord } from "../session"
import { SessionStore } from "./store"
import { SessionTable } from "./sql"
import { SessionInput } from "./input"
import { SessionSchema } from "./schema"
import { SessionMessage } from "./message"
import { Prompt } from "./prompt"

// Location-scoped seam that lets a running session (a location tool) SPAWN a child session — the OS
// `fork` (architecture.md Phase 3 step 6). It deliberately depends ONLY on the cycle-free primitives
// that create + enqueue need (Database / EventV2 / ProjectV2 / SessionStore / Location), NEVER
// `SessionV2.node`: `SessionV2` depends on `LocationServiceMap`, which builds the per-location
// services, so a location tool reaching `SessionV2` would close the runner cycle
// `SessionV2 -> LocationServiceMap -> location services -> spawn -> SessionV2`. The child is only
// CREATED + ENQUEUED here (delivery "queue"); the normal coordinator — which holds
// `LocationServiceMap` at global scope — runs it. Config (agent/model/system-prompt/permissions) it
// doesn't override is inherited from the parent via `resolveSessionConfig` (the child carries
// `parentID`). The child inherits the parent's location (this seam's `Location`).

/** Recursion-depth cap: a child deeper than this is refused (fork-bomb guard, must ship with spawn). */
export const MAX_SPAWN_DEPTH = 8

/** Flat fan-out cap: one parent may have at most this many direct children (K1 quota). */
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
  /** The child's opening prompt (enqueued; the coordinator runs it on the next idle cycle). */
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

export interface Interface {
  readonly spawn: (input: SpawnInput) => Effect.Effect<SessionSchema.ID, SpawnLimitError>
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
    // Spawn-rate ledger: parentID -> recent spawn timestamps within the rolling window. In-memory
    // per process — a restart clears it, which is fine: the rate cap guards runaway LOOPS, not
    // long-term accounting (the flat children cap below is the durable bound).
    const rateLedger = new Map<string, number[]>()
    return Service.of({
      spawn: Effect.fn("SessionSpawner.spawn")(function* (input) {
        // Fork-bomb guards (K1): recursion depth + flat fan-out + spawn rate. Depth is a
        // cycle-guarded parentID walk, like resolveSessionConfig.
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
        const children = yield* db
          .select({ n: count() })
          .from(SessionTable)
          .where(eq(SessionTable.parent_id, input.parentID))
          .get()
          .pipe(Effect.orDie)
        if ((children?.n ?? 0) >= MAX_SPAWN_CHILDREN)
          return yield* Effect.fail(
            new SpawnLimitError({ reason: "children", depth: children?.n ?? 0, limit: MAX_SPAWN_CHILDREN }),
          )
        const now = Date.now()
        const recent = (rateLedger.get(input.parentID) ?? []).filter((t) => now - t < RATE_WINDOW_MS)
        if (recent.length >= MAX_SPAWNS_PER_MINUTE)
          return yield* Effect.fail(
            new SpawnLimitError({ reason: "rate", depth: recent.length, limit: MAX_SPAWNS_PER_MINUTE }),
          )
        rateLedger.set(input.parentID, [...recent, now])
        const child = yield* createSessionRecord(
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
        // 4D: the child inherits the parent's session-DEFINED ad-hoc recipes (copy-on-spawn —
        // the session scope is the "hand your sub-agents a tool set" channel). Best-effort:
        // a store hiccup must never fail the spawn.
        yield* Effect.tryPromise(() => copySessionRecipes(input.parentID, child.id)).pipe(
          Effect.catch((cause) => Effect.logWarning("adhoc-tool copy-on-spawn failed", { cause }).pipe(Effect.as(0))),
        )
        yield* SessionInput.admit(db, events, {
          id: SessionMessage.ID.create(),
          sessionID: child.id,
          prompt: Prompt.make({ text: input.text }),
          delivery: "queue",
        })
        return child.id
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, ProjectV2.node, SessionStore.node, Location.node],
})
