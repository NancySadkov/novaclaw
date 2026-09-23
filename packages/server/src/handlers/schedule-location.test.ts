import { describe, expect, test } from "bun:test"
import { AgentV2 } from "@novaclaw/core/agent"
import { Database } from "@novaclaw/core/database/database"
import { ScheduleStore } from "@novaclaw/core/schedule/store"
import { Authorization } from "@novaclaw/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@novaclaw/protocol/middleware/schema-error"
import { Effect, Layer } from "effect"
import { Api } from "../api"
import { LocationMiddleware } from "../location"
import { ScheduleHandler } from "./schedule"

const AMBIENT_AGENT = "ambient-agent"

const services = (agents: readonly string[]) =>
  Layer.succeed(
    AgentV2.Service,
    AgentV2.Service.of({
      all: () =>
        Effect.succeed(
          agents.map(
            (id) => ({ id, kind: id === "chat" ? "chat" : id === "human" ? "human" : "agent" }) as AgentV2.Info,
          ),
        ),
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

const environment = Layer.mergeAll(
  Database.layerFromPath(":memory:"),
  services([AMBIENT_AGENT, "chat", "human"]),
  middleware,
)

type CreateHandler = (request: {
  readonly params: { readonly agentID: string }
  readonly payload: Record<string, unknown>
}) => Effect.Effect<ScheduleStore.Schedule, unknown, any>

type UpdateHandler = (request: {
  readonly params: { readonly agentID: string; readonly id: string }
  readonly payload: Record<string, unknown>
}) => Effect.Effect<ScheduleStore.Schedule, unknown, any>

type ConfirmHandler = (request: {
  readonly params: { readonly agentID: string; readonly id: string }
  readonly payload: { readonly occurrenceMillis: number }
}) => Effect.Effect<ScheduleStore.Fire, unknown, any>

type ScheduleHandlers = {
  readonly create: CreateHandler
  readonly update: UpdateHandler
  readonly confirm: ConfirmHandler
}

const withSchedule = <A>(body: (handlers: ScheduleHandlers) => Effect.Effect<A, unknown, any>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const context = yield* Layer.build(ScheduleHandler as unknown as Layer.Layer<never, never, never>)
      const key = (Api.groups as Record<string, { readonly key: string }>)["server.schedule"]!.key
      const built = context.mapUnsafe.get(key) as {
        readonly handlers: Map<string, { readonly handler: CreateHandler | UpdateHandler | ConfirmHandler }>
      }
      const create = built.handlers.get("schedule.create")?.handler as CreateHandler | undefined
      const update = built.handlers.get("schedule.update")?.handler as UpdateHandler | undefined
      const confirm = built.handlers.get("schedule.confirm")?.handler as ConfirmHandler | undefined
      expect(create, "schedule.create has no registered handler").toBeDefined()
      expect(update, "schedule.update has no registered handler").toBeDefined()
      expect(confirm, "schedule.confirm has no registered handler").toBeDefined()
      return yield* body({ create: create!, update: update!, confirm: confirm! })
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
    await withSchedule(({ create }) =>
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
        expect(yield* ScheduleStore.listForAgent(db, AMBIENT_AGENT)).toHaveLength(1)
      }),
    )
  })

  test("update cannot cross agent ownership", async () => {
    await withSchedule(({ create, update }) =>
      Effect.gen(function* () {
        const schedule = yield* create({ params: { agentID: AMBIENT_AGENT }, payload: createInput() })
        const refused = yield* Effect.exit(
          update({ params: { agentID: "ghost", id: schedule.id }, payload: { title: "wrong" } }),
        )
        expect(refused._tag).toBe("Failure")
        expect(failureText(refused)).toContain(`No such schedule: ${schedule.id}`)

        const { db } = yield* Database.Service
        expect((yield* ScheduleStore.get(db, schedule.id))?.agent).toBe(AMBIENT_AGENT)
      }),
    )
  })

  test("confirmation belongs to the agent and to one occurrence", async () => {
    await withSchedule(({ create, confirm }) =>
      Effect.gen(function* () {
        const schedule = yield* create({ params: { agentID: AMBIENT_AGENT }, payload: createInput() })
        const { db } = yield* Database.Service
        const occurrenceMillis = Date.now() - 1_000
        yield* ScheduleStore.openWindow(db, schedule, occurrenceMillis, Date.now())

        const wrongAgent = yield* Effect.exit(
          confirm({ params: { agentID: "ghost", id: schedule.id }, payload: { occurrenceMillis } }),
        )
        expect(wrongAgent._tag).toBe("Failure")
        const confirmed = yield* confirm({
          params: { agentID: AMBIENT_AGENT, id: schedule.id },
          payload: { occurrenceMillis },
        })
        expect(confirmed.outcome).toBe("confirmed")
        const wrongOccurrence = yield* Effect.exit(
          confirm({
            params: { agentID: AMBIENT_AGENT, id: schedule.id },
            payload: { occurrenceMillis: occurrenceMillis + 1 },
          }),
        )
        expect(wrongOccurrence._tag).toBe("Failure")
      }),
    )
  })

  test("a named wall-clock zone is kept and an unknown zone is refused", async () => {
    await withSchedule(({ create, update }) =>
      Effect.gen(function* () {
        const recurrence = { kind: "daily", time: { hour: 1, minute: 0 }, zone: "Europe/Berlin" } as const
        const schedule = yield* create({ params: { agentID: AMBIENT_AGENT }, payload: createInput({ recurrence }) })
        expect(schedule.recurrence).toEqual(recurrence)
        const changed = yield* update({
          params: { agentID: AMBIENT_AGENT, id: schedule.id },
          payload: { recurrence: { kind: "daily", time: { hour: 2, minute: 0 }, zone: "Europe/Berlin" } },
        })
        expect(changed.recurrence).toEqual({ kind: "daily", time: { hour: 2, minute: 0 }, zone: "Europe/Berlin" })
        const cleared = yield* update({
          params: { agentID: AMBIENT_AGENT, id: schedule.id },
          payload: { recurrence: { kind: "daily", time: { hour: 3, minute: 0 } } },
        })
        expect(cleared.recurrence).toEqual({ kind: "daily", time: { hour: 3, minute: 0 } })
        const invalid = yield* Effect.exit(
          create({
            params: { agentID: AMBIENT_AGENT },
            payload: createInput({ recurrence: { ...recurrence, zone: "Unknown/Zone" } }),
          }),
        )
        expect(invalid._tag).toBe("Failure")
        expect(failureText(invalid)).toContain("Unknown time zone")
      }),
    )
  })
})
