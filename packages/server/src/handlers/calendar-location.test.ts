import { describe, expect, test } from "bun:test"
import { AgentV2 } from "@novaclaw/core/agent"
import { Catalog } from "@novaclaw/core/catalog"
import { Database } from "@novaclaw/core/database/database"
import { LocationServiceMap } from "@novaclaw/core/location-service-map"
import { CalendarStore } from "@novaclaw/core/schedule/store"
import { Authorization } from "@novaclaw/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@novaclaw/protocol/middleware/schema-error"
import { Effect, Layer } from "effect"
import { Api } from "../api"
import { LocationMiddleware } from "../location"
import { CalendarHandler } from "./calendar"

const AMBIENT_AGENT = "ambient-agent"
const AMBIENT_MODEL = "ambient/model"
const PINNED_AGENT = "pinned-agent"
const PINNED_MODEL = "pinned/model"
const PINNED_DIRECTORY = "C:/work/pinned"

const services = (agents: readonly string[], models: readonly string[]) =>
  Layer.mergeAll(
    Layer.succeed(
      AgentV2.Service,
      AgentV2.Service.of({
        all: () => Effect.succeed(agents.map((id) => ({ id }) as AgentV2.Info)),
      } as unknown as AgentV2.Interface),
    ),
    Layer.succeed(
      Catalog.Service,
      Catalog.Service.of({
        model: {
          all: () =>
            Effect.succeed(
              models.map((ref) => {
                const [providerID, ...id] = ref.split("/")
                return { providerID, id: id.join("/") }
              }),
            ),
        },
      } as unknown as Catalog.Interface),
    ),
  )

const ambient = services([AMBIENT_AGENT], [AMBIENT_MODEL])
const pinned = services([PINNED_AGENT], [PINNED_MODEL])

const locationMap = Layer.succeed(
  LocationServiceMap.Service,
  LocationServiceMap.Service.of({
    get: (_ref: { readonly directory: string }) => pinned,
  } as never),
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

const environment = Layer.mergeAll(Database.layerFromPath(":memory:"), ambient, locationMap, middleware)

type CreateHandler = (request: {
  readonly payload: Record<string, unknown>
}) => Effect.Effect<CalendarStore.Schedule, unknown, any>

type UpdateHandler = (request: {
  readonly params: { readonly id: string }
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

describe("calendar execution-setting validation follows schedule placement", () => {
  test("create without a pinned folder uses the request's ambient roster and catalog", async () => {
    await withCalendar(({ create }) =>
      Effect.gen(function* () {
        const accepted = yield* create({
          payload: createInput({ agent: AMBIENT_AGENT, model: AMBIENT_MODEL }),
        })
        expect(accepted.location).toBeNull()
        expect(accepted.agent).toBe(AMBIENT_AGENT)

        const refused = yield* Effect.exit(
          create({ payload: createInput({ agent: PINNED_AGENT, model: PINNED_MODEL }) }),
        )
        expect(refused._tag).toBe("Failure")
        expect(failureText(refused)).toContain(`No agent named \\"${PINNED_AGENT}\\"`)

        const { db } = yield* Database.Service
        expect(yield* CalendarStore.list(db)).toHaveLength(1)
      }),
    )
  })

  test("create with a pinned folder uses that folder instead of the ambient request", async () => {
    await withCalendar(({ create }) =>
      Effect.gen(function* () {
        const accepted = yield* create({
          payload: createInput({
            location: PINNED_DIRECTORY,
            agent: PINNED_AGENT,
            model: PINNED_MODEL,
          }),
        })
        expect(accepted.location).toBe(PINNED_DIRECTORY)

        const refused = yield* Effect.exit(
          create({
            payload: createInput({ location: PINNED_DIRECTORY, agent: AMBIENT_AGENT }),
          }),
        )
        expect(refused._tag).toBe("Failure")
        expect(failureText(refused)).toContain(`No agent named \\"${AMBIENT_AGENT}\\"`)
      }),
    )
  })

  test("update without a pin validates changed settings against the ambient request", async () => {
    await withCalendar(({ create, update }) =>
      Effect.gen(function* () {
        const schedule = yield* create({ payload: createInput({ agent: AMBIENT_AGENT }) })
        const refused = yield* Effect.exit(update({ params: { id: schedule.id }, payload: { agent: "ghost" } }))
        expect(refused._tag).toBe("Failure")
        expect(failureText(refused)).toContain('No agent named \\"ghost\\"')

        const { db } = yield* Database.Service
        expect((yield* CalendarStore.get(db, schedule.id))?.agent).toBe(AMBIENT_AGENT)
      }),
    )
  })

  test("update keeps an existing pin authoritative until the patch explicitly clears it", async () => {
    await withCalendar(({ create, update }) =>
      Effect.gen(function* () {
        const schedule = yield* create({
          payload: createInput({ location: PINNED_DIRECTORY, agent: PINNED_AGENT }),
        })

        const refused = yield* Effect.exit(update({ params: { id: schedule.id }, payload: { agent: AMBIENT_AGENT } }))
        expect(refused._tag).toBe("Failure")
        expect(failureText(refused)).toContain(`No agent named \\"${AMBIENT_AGENT}\\"`)

        const cleared = yield* update({
          params: { id: schedule.id },
          payload: { location: null, agent: AMBIENT_AGENT, model: AMBIENT_MODEL },
        })
        expect(cleared.location).toBeNull()
        expect(cleared.agent).toBe(AMBIENT_AGENT)
        expect(cleared.model).toBe(AMBIENT_MODEL)
      }),
    )
  })
})
