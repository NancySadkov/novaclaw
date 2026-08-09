import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Location } from "@novaclaw/core/location"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionWorkerLocation } from "./location"

test("worker event scope keeps the location layer's derived root and origin", async () => {
  const info = Location.Service.of({
    directory: AbsolutePath.make("C:\\instance\\scratch\\ses_test"),
    root: AbsolutePath.make("C:\\"),
    origin: "global",
  })

  const resolved = await Effect.runPromise(SessionWorkerLocation.resolve(Layer.succeed(Location.Service, info)))

  expect(resolved).toBe(info)
  expect(resolved).toMatchObject({ root: "C:\\", origin: "global" })
})
