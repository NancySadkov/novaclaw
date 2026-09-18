import { afterEach, describe, expect } from "bun:test"
import { AgentV2 } from "@novaclaw/core/agent"
import { Location } from "@novaclaw/core/location"
import { LocationServiceMap } from "@novaclaw/core/location-service-map"
import { AbsolutePath } from "@novaclaw/core/schema"
import { Effect, Layer } from "effect"
import { ServerLocationServiceMap } from "../../src/location-service-map"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { testEffectShared } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

type ExecutionIdentity = {
  readonly agent: AgentV2.ID
}

const ambientCreate: ExecutionIdentity = {
  agent: AgentV2.ID.make("calendar-http-ambient-create"),
}
const ambientUpdate: ExecutionIdentity = {
  agent: AgentV2.ID.make("calendar-http-ambient-update"),
}

const locationRef = (directory: string) => Location.Ref.make({ directory: AbsolutePath.make(directory) })

const seedLocation = (
  locations: LocationServiceMap.Service["Service"],
  directory: string,
  identities: ReadonlyArray<ExecutionIdentity>,
) =>
  Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    yield* agents.transform((draft) => {
      for (const identity of identities) {
        draft.update(identity.agent, (agent) => {
          agent.description = `HTTP calendar fixture ${identity.agent}`
        })
      }
    })
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
  it.effect("resolves the responsible agent through the directory header", () =>
    Effect.gen(function* () {
      const ambientDirectory = yield* tmpdirScoped({ git: true })
      const otherDirectory = yield* tmpdirScoped({ git: true })
      const locations = yield* LocationServiceMap.Service

      yield* seedLocation(locations, ambientDirectory, [ambientCreate, ambientUpdate])

      const recurrence = { kind: "once", at: Date.now() + 86_400_000 }

      // The SAME agent is refused when the request names a directory whose graph does not hold it:
      // success in the first call below cannot be explained by one global roster.
      const wrongDirectory = yield* jsonRequest("/api/calendar/schedule", otherDirectory, "POST", {
        title: "wrong directory",
        recurrence,
        prompt: "run from a directory that does not know this colleague",
        agent: ambientCreate.agent,
      })
      expect(wrongDirectory.status).toBe(400)
      yield* wrongDirectory.text

      const created = yield* jsonRequest("/api/calendar/schedule", ambientDirectory, "POST", {
        title: "ambient create",
        recurrence,
        prompt: "run from the ambient folder",
        agent: ambientCreate.agent,
      })
      expect(created.status).toBe(200)
      const schedule = JSON.parse(yield* created.text) as { readonly id: string; readonly agent: string | null }
      expect(schedule.agent).toBe(ambientCreate.agent)

      // No location in the patch means the still-unvalidated replacement identity must be resolved
      // through x-novaclaw-directory too, not through the server process directory.
      const updated = yield* jsonRequest(`/api/calendar/schedule/${schedule.id}`, ambientDirectory, "PATCH", {
        title: "ambient update",
        agent: ambientUpdate.agent,
      })
      expect(updated.status).toBe(200)
      expect(JSON.parse(yield* updated.text)).toMatchObject({
        title: "ambient update",
        agent: ambientUpdate.agent,
      })
    }),
  )
})
