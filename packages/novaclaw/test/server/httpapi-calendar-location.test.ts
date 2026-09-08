import { afterEach, describe, expect } from "bun:test"
import { AgentV2 } from "@novaclaw/core/agent"
import { Catalog } from "@novaclaw/core/catalog"
import { Location } from "@novaclaw/core/location"
import { LocationServiceMap } from "@novaclaw/core/location-service-map"
import { ModelV2 } from "@novaclaw/core/model"
import { ProviderV2 } from "@novaclaw/core/provider"
import { AbsolutePath } from "@novaclaw/core/schema"
import { Effect, Layer } from "effect"
import { ServerLocationServiceMap } from "../../src/location-service-map"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { testEffectShared } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

type ExecutionIdentity = {
  readonly agent: AgentV2.ID
  readonly provider: ProviderV2.ID
  readonly model: ModelV2.ID
}

type ScheduleResponse = {
  readonly id: string
  readonly title: string
  readonly agent: string | null
  readonly model: string | null
  readonly location: string | null
}

const ambientCreate: ExecutionIdentity = {
  agent: AgentV2.ID.make("calendar-http-ambient-create"),
  provider: ProviderV2.ID.make("calendar-http-ambient"),
  model: ModelV2.ID.make("create"),
}
const ambientUpdate: ExecutionIdentity = {
  agent: AgentV2.ID.make("calendar-http-ambient-update"),
  provider: ProviderV2.ID.make("calendar-http-ambient"),
  model: ModelV2.ID.make("update"),
}
const pinnedIdentity: ExecutionIdentity = {
  agent: AgentV2.ID.make("calendar-http-pinned"),
  provider: ProviderV2.ID.make("calendar-http-pinned"),
  model: ModelV2.ID.make("only"),
}

const modelRef = (identity: ExecutionIdentity) => `${identity.provider}/${identity.model}`
const locationRef = (directory: string) =>
  Location.Ref.make({ directory: AbsolutePath.make(directory) })

const seedLocation = (
  locations: LocationServiceMap.Service["Service"],
  directory: string,
  identities: ReadonlyArray<ExecutionIdentity>,
) =>
  Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    const catalog = yield* Catalog.Service
    yield* agents.transform((draft) => {
      for (const identity of identities) {
        draft.update(identity.agent, (agent) => {
          agent.description = `HTTP calendar fixture ${identity.agent}`
        })
      }
    })
    yield* catalog.transform((draft) => {
      for (const identity of identities) {
        draft.provider.update(identity.provider, (provider) => {
          provider.name = `HTTP calendar fixture ${identity.provider}`
        })
        draft.model.update(identity.provider, identity.model, (model) => {
          model.name = `HTTP calendar fixture ${identity.model}`
        })
      }
    })
  }).pipe(Effect.provide(locations.get(locationRef(directory))))

const knownAt = (locations: LocationServiceMap.Service["Service"], directory: string) =>
  Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    const catalog = yield* Catalog.Service
    return {
      agents: new Set((yield* agents.all()).map((agent) => String(agent.id))),
      models: new Set((yield* catalog.model.all()).map((model) => `${model.providerID}/${model.id}`)),
    }
  }).pipe(Effect.provide(locations.get(locationRef(directory))))

const jsonRequest = (path: string, directory: string, method: "POST" | "PATCH", body: unknown) =>
  requestInDirectory(path, directory, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

// Include the server's exact module-level layer object beside the real HTTP layer. Effect's shared
// memo map then exposes the same process-wide location graphs the request middleware and handlers use;
// building a second map here would seed fixtures the HTTP request can never observe.
const it = testEffectShared(Layer.mergeAll(httpApiLayer, ServerLocationServiceMap.layer))

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("calendar location routing over HTTP", () => {
  it.effect("uses the directory header for unpinned writes and an explicit folder for pinned writes", () =>
    Effect.gen(function* () {
      const ambientDirectory = yield* tmpdirScoped({ git: true })
      const pinnedDirectory = yield* tmpdirScoped({ git: true })
      const locations = yield* LocationServiceMap.Service

      yield* seedLocation(locations, ambientDirectory, [ambientCreate, ambientUpdate])
      yield* seedLocation(locations, pinnedDirectory, [pinnedIdentity])

      // Establish that success cannot be explained by both location graphs seeing one global roster
      // or catalog: each side deliberately lacks the identities that belong to the other.
      const ambientKnown = yield* knownAt(locations, ambientDirectory)
      const pinnedKnown = yield* knownAt(locations, pinnedDirectory)
      expect(ambientKnown.agents.has(ambientCreate.agent)).toBe(true)
      expect(ambientKnown.agents.has(ambientUpdate.agent)).toBe(true)
      expect(ambientKnown.agents.has(pinnedIdentity.agent)).toBe(false)
      expect(ambientKnown.models.has(modelRef(ambientCreate))).toBe(true)
      expect(ambientKnown.models.has(modelRef(ambientUpdate))).toBe(true)
      expect(ambientKnown.models.has(modelRef(pinnedIdentity))).toBe(false)
      expect(pinnedKnown.agents.has(pinnedIdentity.agent)).toBe(true)
      expect(pinnedKnown.agents.has(ambientCreate.agent)).toBe(false)
      expect(pinnedKnown.agents.has(ambientUpdate.agent)).toBe(false)
      expect(pinnedKnown.models.has(modelRef(pinnedIdentity))).toBe(true)
      expect(pinnedKnown.models.has(modelRef(ambientCreate))).toBe(false)
      expect(pinnedKnown.models.has(modelRef(ambientUpdate))).toBe(false)

      const recurrence = { kind: "once", at: Date.now() + 86_400_000 }
      const unpinnedCreate = yield* jsonRequest("/api/calendar/schedule", ambientDirectory, "POST", {
        title: "ambient create",
        recurrence,
        prompt: "run from the ambient folder",
        agent: ambientCreate.agent,
        model: modelRef(ambientCreate),
      })
      expect(unpinnedCreate.status).toBe(200)
      const unpinned = JSON.parse(yield* unpinnedCreate.text) as ScheduleResponse
      expect(unpinned).toMatchObject({
        title: "ambient create",
        agent: ambientCreate.agent,
        model: modelRef(ambientCreate),
        location: null,
      })

      // No location in the patch means the still-unpinned row must validate the replacement identity
      // through x-novaclaw-directory too, not through the server process directory.
      const unpinnedUpdate = yield* jsonRequest(
        `/api/calendar/schedule/${unpinned.id}`,
        ambientDirectory,
        "PATCH",
        {
          title: "ambient update",
          agent: ambientUpdate.agent,
          model: modelRef(ambientUpdate),
        },
      )
      expect(unpinnedUpdate.status).toBe(200)
      expect(JSON.parse(yield* unpinnedUpdate.text)).toMatchObject({
        title: "ambient update",
        agent: ambientUpdate.agent,
        model: modelRef(ambientUpdate),
        location: null,
      })

      // The request still names the ambient directory, but an explicit schedule location is the
      // authority for both create and subsequent updates.
      const pinnedCreate = yield* jsonRequest("/api/calendar/schedule", ambientDirectory, "POST", {
        title: "pinned create",
        recurrence,
        prompt: "run from the pinned folder",
        agent: pinnedIdentity.agent,
        model: modelRef(pinnedIdentity),
        location: pinnedDirectory,
      })
      expect(pinnedCreate.status).toBe(200)
      const pinned = JSON.parse(yield* pinnedCreate.text) as ScheduleResponse
      expect(pinned).toMatchObject({
        agent: pinnedIdentity.agent,
        model: modelRef(pinnedIdentity),
        location: pinnedDirectory,
      })

      const wrongPinnedUpdate = yield* jsonRequest(
        `/api/calendar/schedule/${pinned.id}`,
        ambientDirectory,
        "PATCH",
        { agent: ambientUpdate.agent, model: modelRef(ambientUpdate) },
      )
      expect(wrongPinnedUpdate.status).toBe(400)
      yield* wrongPinnedUpdate.text

      const pinnedUpdate = yield* jsonRequest(
        `/api/calendar/schedule/${pinned.id}`,
        ambientDirectory,
        "PATCH",
        { title: "pinned update", agent: pinnedIdentity.agent, model: modelRef(pinnedIdentity) },
      )
      expect(pinnedUpdate.status).toBe(200)
      expect(JSON.parse(yield* pinnedUpdate.text)).toMatchObject({
        title: "pinned update",
        agent: pinnedIdentity.agent,
        model: modelRef(pinnedIdentity),
        location: pinnedDirectory,
      })
    }),
  )
})
