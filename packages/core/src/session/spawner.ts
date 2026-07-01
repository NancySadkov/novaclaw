export * as SessionSpawner from "./spawner"

import { Context, Effect, Layer } from "effect"
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
  readonly spawn: (input: SpawnInput) => Effect.Effect<SessionSchema.ID>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionSpawner") {}

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
