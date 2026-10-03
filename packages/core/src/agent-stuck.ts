export * as AgentStuck from "./agent-stuck"

import { eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { AgentStuckCounterTable } from "./agent-stuck.sql"

/** The counter forgets an officer's stuck detections after an hour without a fresh one. */
export const WINDOW_MS = 60 * 60_000

/** Detections inside one window before an officer is force-compacted back to a clean context. */
export const DEFAULT_THRESHOLD = 10

export interface Outcome {
  readonly count: number
  readonly escalated: boolean
}

export interface Interface {
  readonly record: (
    agent: string,
    input: { readonly threshold: number; readonly now: number },
  ) => Effect.Effect<Outcome>
  readonly count: (agent: string, now: number) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/AgentStuck") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const readWindow = (agent: string, now: number) =>
      db
        .select({ count: AgentStuckCounterTable.count, windowStart: AgentStuckCounterTable.window_start })
        .from(AgentStuckCounterTable)
        .where(eq(AgentStuckCounterTable.agent, agent))
        .get()
        .pipe(
          Effect.orDie,
          Effect.map((row): { count: number; windowStart: number } =>
            row !== undefined && now - row.windowStart < WINDOW_MS ? row : { count: 0, windowStart: now },
          ),
        )
    const write = (agent: string, count: number, windowStart: number) =>
      db
        .insert(AgentStuckCounterTable)
        .values({ agent, count, window_start: windowStart })
        .onConflictDoUpdate({
          target: AgentStuckCounterTable.agent,
          set: { count, window_start: windowStart },
        })
        .run()
        .pipe(Effect.orDie, Effect.asVoid)
    return Service.of({
      record: (agent, { threshold, now }) =>
        Effect.gen(function* () {
          const window = yield* readWindow(agent, now)
          const count = window.count + 1
          const limit = Math.max(1, Math.floor(threshold))
          const escalated = count >= limit
          yield* write(agent, escalated ? 0 : count, window.windowStart)
          return { count, escalated }
        }),
      count: (agent, now) => readWindow(agent, now).pipe(Effect.map((window) => window.count)),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
