export * as SessionExecution from "./execution"

import { Context, Effect, Layer } from "effect"
import { LayerNode } from "../effect/layer-node"
import { Node } from "../effect/app-node"
import { SessionRunner } from "./runner/index"
import { SessionSchema } from "./schema"

export interface Interface {
  /** Snapshots active execution owned by this process. */
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  /** Starts execution while idle or joins the active execution. */
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, SessionRunner.RunError>
  /** Adopts durable unfinished work without joining it, so every recovered session reaches scheduling. */
  readonly adopt: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /** Registers newly recorded work. Repeated wakeups may coalesce. */
  readonly wake: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /** Interrupt active work owned by this process. Idle interruption is a no-op. */
  readonly interrupt: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /**
   * 🔴 Whether a stop is still in flight for this session — the thread manager's own flag
   * (owner, 2026-09-26). The scheduler acts on it; the Stop button samples it through the
   * execution list. A client-local "I asked" signal may only ever be an OPTIMISTIC projection
   * of this flag, cleared by the next poll — never a second state that can disagree with it.
   */
  readonly stopping: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
  /** Stop one live command, addressed by the job id the session command list shows (or the
   *  tool-call id of a command still in flight), while leaving its owning session drain running. */
  readonly stopCommand: (sessionID: SessionSchema.ID, commandID: string, reason: string) => Effect.Effect<boolean>
}

/** Routes execution from a Session ID to the runner owned by that Session's Location. */
export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/SessionExecution") {}

export const node = LayerNode.unbound(Service, Node.tags.values.global)

/** Low-level compatibility layer for callers that only need durable Session recording. */
export const noopLayer = Layer.succeed(
  Service,
  Service.of({
    active: Effect.succeed(new Set()),
    resume: () => Effect.void,
    adopt: () => Effect.void,
    wake: () => Effect.void,
    interrupt: () => Effect.void,
    stopping: () => Effect.succeed(false),
    stopCommand: () => Effect.succeed(false),
  }),
)
