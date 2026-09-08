import { Effect, Layer, Schema } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { SessionComponentRegistry } from "@novaclaw/core/session/component-registry"
import { SessionSchema } from "@novaclaw/core/session/schema"

const databasePath = process.argv[2]
const sessionID = process.argv[3]
if (!databasePath || !sessionID) throw new Error("usage: session-component-worker <database> <session>")

const Marker = SessionComponentRegistry.toolDefinition("fixture", {
  name: "marker",
  description: "Cross-process marker",
  cardinality: "singleton",
  lifetime: "entity",
  version: 1,
  codec: Schema.Struct({ text: Schema.NonEmptyString }),
})
const database = Database.layerFromPath(databasePath)
const registry = SessionComponentRegistry.layer.pipe(Layer.provide(database))

await Effect.runPromise(
  Effect.gen(function* () {
    const components = yield* SessionComponentRegistry.Service
    yield* components.registerTool(Marker)
    yield* components.put({
      sessionID: SessionSchema.ID.make(sessionID),
      kind: Marker.kind,
      value: { text: "written by the disposable worker" },
    })
  }).pipe(Effect.provide(Layer.merge(database, registry)), Effect.scoped),
)
