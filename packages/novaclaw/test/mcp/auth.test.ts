import { expect, test } from "bun:test"
import { setTimeout as sleep } from "node:timers/promises"
import { Effect, Layer } from "effect"
import { FSUtil } from "@novaclaw/core/fs-util"
import { EffectFlock } from "@novaclaw/core/util/effect-flock"
import { McpAuth } from "../../src/mcp/auth"

function authFile(initial?: unknown) {
  let raw = initial === undefined ? "" : JSON.stringify(initial)
  let activeWrites = 0
  let sawOverlap = false

  const layer = Layer.effect(
    FSUtil.Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service

      return FSUtil.Service.of({
        ...fs,
        readJson: (file) =>
          file.endsWith("mcp-auth.json")
            ? Effect.try({
                try: () => {
                  if (!raw) throw new Error("mcp-auth.json missing")
                  return JSON.parse(raw)
                },
                catch: (cause) => new FSUtil.FileSystemError({ method: "readJson", cause }),
              })
            : fs.readJson(file),
        writeJson: (file, value, mode) =>
          file.endsWith("mcp-auth.json")
            ? Effect.promise(async () => {
                activeWrites++
                sawOverlap = sawOverlap || activeWrites > 1
                raw = ""
                await sleep(10)
                const next = JSON.stringify(value, null, 2)
                raw = sawOverlap ? `${next}\n}` : next
                activeWrites--
              })
            : fs.writeJson(file, value, mode),
      })
    }),
  ).pipe(Layer.provide(FSUtil.defaultLayer))

  return { layer, raw: () => raw }
}

function authService(layer: Layer.Layer<FSUtil.Service>) {
  return McpAuth.Service.use((auth) => Effect.succeed(auth)).pipe(
    Effect.provide(McpAuth.layer.pipe(Layer.provide(EffectFlock.defaultLayer), Layer.provide(layer))),
  )
}

test("serializes concurrent auth file updates across service instances", async () => {
  const file = authFile()

  await Effect.runPromise(
    Effect.gen(function* () {
      const first = yield* authService(file.layer)
      const second = yield* authService(file.layer)

      yield* Effect.all(
        [
          first.updateTokens("posthog", { accessToken: "access-token" }, "https://mcp.posthog.com/mcp"),
          second.updateClientInfo("posthog", { clientId: "client-id" }, "https://mcp.posthog.com/mcp"),
        ],
        { concurrency: "unbounded" },
      )

      const entry = yield* first.get("posthog")
      expect(entry?.tokens?.accessToken).toBe("access-token")
      expect(entry?.clientInfo?.clientId).toBe("client-id")
      expect(entry?.serverUrl).toBe("https://mcp.posthog.com/mcp")
      expect(() => JSON.parse(file.raw())).not.toThrow()

      // The stored format is plaintext; account-private filesystem permissions protect it.
      expect(file.raw()).toContain("access-token")
      expect(file.raw()).toContain("client-id")
    }),
  )
})

test("🔴 an unopenable MCP auth file neither crashes the read nor gets overwritten", async () => {
  const unopenable = { damaged: "invalid stored value" }
  const file = authFile(unopenable)
  const before = file.raw()

  await Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* authService(file.layer)
      // Fail closed: nothing is authenticated rather than something wrong being.
      expect(yield* auth.get("posthog")).toBeUndefined()
    }),
  )

  expect(file.raw()).toBe(before)
  expect(file.raw()).toContain("damaged")
})

test("leaves an already-plaintext MCP auth file alone", async () => {
  const file = authFile({
    posthog: {
      tokens: { accessToken: "plaintext-access-token" },
      serverUrl: "https://mcp.posthog.com/mcp",
    },
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* authService(file.layer)
      expect((yield* auth.get("posthog"))?.tokens?.accessToken).toBe("plaintext-access-token")

      expect(file.raw()).toContain("plaintext-access-token")
    }),
  )
})
