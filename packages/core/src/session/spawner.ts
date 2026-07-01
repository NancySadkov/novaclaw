export * as SessionSpawner from "./spawner"

import { Context, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { ProjectV2 } from "../project"
import { Location } from "../location"
import { AgentV2 } from "../agent"
import { ModelV2 } from "../model"
import { createSessionRecord } from "../session"
import { SessionStore } from "./store"
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

/** Raised when the parent chain is already `MAX_SPAWN_DEPTH` deep — surfaced to the model, not fatal. */
export class SpawnLimitError extends Schema.TaggedErrorClass<SpawnLimitError>()("SessionSpawner.LimitError", {
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
    return Service.of({
      spawn: Effect.fn("SessionSpawner.spawn")(function* (input) {
        // Fork-bomb guard (recursion depth): refuse if the parent chain is already too deep. A
        // cycle-guarded parentID walk, like resolveSessionConfig. Flat max-children + spawn-rate
        // quotas are a follow-up (architecture.md step 6 / todo Vision).
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
        if (depth >= MAX_SPAWN_DEPTH) return yield* Effect.fail(new SpawnLimitError({ depth, limit: MAX_SPAWN_DEPTH }))
        const child = yield* createSessionRecord(
          { db, events, projects, store },
          {
            parentID: input.parentID,
            agent: input.agent,
            model: input.model,
            systemPromptOverride: input.systemPromptOverride,
            location, // the parent's location = this seam's location
          },
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
