import { describe, expect, test } from "bun:test"
import { AgentV2 } from "@novaclaw/core/agent"
import { Database } from "@novaclaw/core/database/database"
import { CalendarStore } from "@novaclaw/core/schedule/store"
import { Authorization } from "@novaclaw/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@novaclaw/protocol/middleware/schema-error"
import { Effect, Layer } from "effect"
import { Api } from "../api"
import { LocationMiddleware } from "../location"
import { CalendarHandler } from "./calendar"

const AMBIENT_AGENT = "ambient-agent"

const services = (agents: readonly string[]) =>
  Layer.succeed(
    AgentV2.Service,
    AgentV2.Service.of({
      all: () => Effect.succeed(agents.map((id) => ({ id, kind: id === "chat" ? "chat" : id === "human" ? "human" : "agent" }) as AgentV2.Info)),
    } as unknown as AgentV2.Interface),
  )

const middleware = Layer.mergeAll(
  Layer.succeed(
    LocationMiddleware,
    LocationMiddleware.of((effect) => effect as never),
  ),
  Layer.succeed(
    Authorization,
    Authorization.of((effect) => effect as never),
  ),
  Layer.succeed(
    SchemaErrorMiddleware,
    SchemaErrorMiddleware.of((effect) => effect as never),
  ),
)

const environment = Layer.mergeAll(Database.layerFromPath(":memory:"), services([AMBIENT_AGENT, "chat", "human"]), middleware)

type CreateHandler = (request: {
  readonly params: { readonly agentID: string }
  readonly payload: Record<string, unknown>
}) => Effect.Effect<CalendarStore.Schedule, unknown, any>

type UpdateHandler = (request: {
  readonly params: { readonly agentID: string; readonly id: string }
  readonly payload: Record<string, unknown>
}) => Effect.Effect<CalendarStore.Schedule, unknown, any>

type CalendarHandlers = {
  readonly create: CreateHandler
  readonly update: UpdateHandler
}

const withCalendar = <A>(body: (handlers: CalendarHandlers) => Effect.Effect<A, unknown, any>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const context = yield* Layer.build(CalendarHandler as unknown as Layer.Layer<never, never, never>)
      const key = (Api.groups as Record<string, { readonly key: string }>)["server.calendar"]!.key
      const built = context.mapUnsafe.get(key) as {
        readonly handlers: Map<string, { readonly handler: CreateHandler | UpdateHandler }>
      }
      const create = built.handlers.get("calendar.schedule.create")?.handler as CreateHandler | undefined
      const update = built.handlers.get("calendar.schedule.update")?.handler as UpdateHandler | undefined
      expect(create, "calendar.schedule.create has no registered handler").toBeDefined()
      expect(update, "calendar.schedule.update has no registered handler").toBeDefined()
      return yield* body({ create: create!, update: update! })
    }).pipe(Effect.scoped, Effect.provide(environment)) as Effect.Effect<A>,
  )

const createInput = (overrides: Record<string, unknown> = {}) => ({
  recurrence: { kind: "daily", time: { hour: 9, minute: 0 } },
  prompt: "Review the work",
  ...overrides,
})

const failureText = (exit: unknown) => JSON.stringify(exit)

describe("agent schedule ownership", () => {
  test("create accepts a runnable agent and refuses an unknown agent", async () => {
    await withCalendar(({ create }) =>
      Effect.gen(function* () {
        const accepted = yield* create({ params: { agentID: AMBIENT_AGENT }, payload: createInput() })
        expect(accepted.agent).toBe(AMBIENT_AGENT)

        const refused = yield* Effect.exit(create({ params: { agentID: "ghost" }, payload: createInput() }))
        expect(refused._tag).toBe("Failure")
        expect(failureText(refused)).toContain('No runnable agent named \\"ghost\\"')

        for (const agentID of ["chat", "human"]) {
          const unrunnable = yield* Effect.exit(create({ params: { agentID }, payload: createInput() }))
          expect(unrunnable._tag).toBe("Failure")
          expect(failureText(unrunnable)).toContain(`No runnable agent named \\"${agentID}\\"`)
        }

        const { db } = yield* Database.Service
        expect(yield* CalendarStore.list(db)).toHaveLength(1)
      }),
    )
  })

  test("update cannot cross agent ownership", async () => {
    await withCalendar(({ create, update }) =>
      Effect.gen(function* () {
        const schedule = yield* create({ params: { agentID: AMBIENT_AGENT }, payload: createInput() })
        const refused = yield* Effect.exit(update({ params: { agentID: "ghost", id: schedule.id }, payload: { title: "wrong" } }))
        expect(refused._tag).toBe("Failure")
        expect(failureText(refused)).toContain(`No such schedule: ${schedule.id}`)

        const { db } = yield* Database.Service
        expect((yield* CalendarStore.get(db, schedule.id))?.agent).toBe(AMBIENT_AGENT)
      }),
    )
  })
})
