import { Effect, Layer } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { SessionAutoGrant } from "@novaclaw/core/session/auto-grant"

const databasePath = process.argv[2]
const sessionID = process.argv[3]
if (!databasePath || !sessionID) throw new Error("usage: session-auto-grant-worker <database> <session>")

const database = Database.layerFromPath(databasePath)
const environment = Layer.merge(database, SessionAutoGrant.layer.pipe(Layer.provide(database)))

await Effect.runPromise(
  Effect.gen(function* () {
    const grants = yield* SessionAutoGrant.Service
    yield* grants.set(sessionID, {
      mode: "plan",
      justification: "the worker is dropping mutation authority before analysis",
      at: Date.now(),
    })
  }).pipe(Effect.provide(environment), Effect.scoped),
)
