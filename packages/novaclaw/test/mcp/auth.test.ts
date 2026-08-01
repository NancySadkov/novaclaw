import { expect, test } from "bun:test"
import { setTimeout as sleep } from "node:timers/promises"
import { Effect, Layer } from "effect"
import { FSUtil } from "@novaclaw/core/fs-util"
import { EffectFlock } from "@novaclaw/core/util/effect-flock"
import { CredentialCipher } from "@novaclaw/core/credential-cipher"
import { McpAuth } from "../../src/mcp/auth"

const testCipher = Layer.succeed(CredentialCipher.Service)(CredentialCipher.make(Buffer.alloc(32, 9)))

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
    Effect.provide(
      McpAuth.layer.pipe(Layer.provide(EffectFlock.defaultLayer), Layer.provide(layer), Layer.provide(testCipher)),
    ),
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
      expect(file.raw()).toContain("$novaclawEncrypted")
      expect(file.raw()).not.toContain("access-token")
      expect(file.raw()).not.toContain("client-id")
    }),
  )
})

test("migrates a legacy plaintext MCP auth file on read", async () => {
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
      expect(file.raw()).toContain("$novaclawEncrypted")
      expect(file.raw()).not.toContain("plaintext-access-token")
    }),
  )
})
