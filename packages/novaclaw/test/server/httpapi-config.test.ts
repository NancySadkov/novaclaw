import { afterEach, describe, expect } from "bun:test"
import { Server } from "../../src/server/server"
import { Effect } from "effect"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"

function app() {
  return Server.Default().app
}

const tmpdirEffect = (options: Parameters<typeof tmpdir>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("config HttpApi", () => {
  it.live(
    "serves config update through the default server app",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ config: { formatter: false } })

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
              "x-novaclaw-directory": tmp.path,
            },
            body: JSON.stringify({ username: "patched-user", formatter: false }),
          }),
        ),
      )

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        username: "patched-user",
        formatter: false,
      })
      // PATCH applies through the live graph. It deliberately does NOT dispose the instance;
      // httpapi-config-no-teardown.test.ts pins that lifecycle contract directly.
      const persisted = yield* Effect.promise(() =>
        Promise.resolve(app().request("/config", { headers: { "x-novaclaw-directory": tmp.path } })),
      )
      expect(persisted.status).toBe(200)
      expect(yield* Effect.promise(() => persisted.json())).toMatchObject({
        username: "patched-user",
        formatter: false,
      })
    }),
  )

  it.live(
    "serves config with active provider model status",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({
        config: {
          formatter: false,
          providers: {
            omniroute: {
              models: {
                "gpt-4o": {},
              },
            },
          },
        },
      })

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            headers: {
              "x-novaclaw-directory": tmp.path,
            },
          }),
        ),
      )

      expect(response.status).toBe(200)
      // A V2 model with no explicit status carries no `disabled`; assert the provider + model
      // survive the config round-trip under the V2 `providers` key.
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        providers: {
          omniroute: {
            models: {
              "gpt-4o": {},
            },
          },
        },
      })
    }),
  )
})
