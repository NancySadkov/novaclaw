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
      // 🔴 Plaintext at 0o600 — the unwind of app-managed encryption; see auth/auth.test.ts.
      expect(file.raw()).not.toContain("$novaclawEncrypted")
      // ⚠️ And the values ARE in the file, which is the point rather than an oversight. Decision §5
      // says this out loud: secrets stay readable by anything running as this user, and the 0o600
      // mode is the protection. Asserting it keeps the change honest instead of quiet.
      expect(file.raw()).toContain("access-token")
      expect(file.raw()).toContain("client-id")
    }),
  )
})

/**
 * 🔴 The DRAIN — the half that makes it safe to stop encrypting.
 *
 * An instance that has completed an MCP OAuth flow has an ENCRYPTED `mcp-auth.json`. Had the read
 * simply stopped opening envelopes, that file would be unreadable the moment the key went missing.
 * An opened file is written back as plaintext while the key is still present.
 *
 * ⚠️ Written because the A/B caught its absence: removing the drain from `all()` left every mcp-auth
 * test green. The plaintext test above cannot see it — it never starts from ciphertext.
 *
 * A/B: drop `if (current.drain) yield* write(...)` in `all()` and this fails.
 */
test("🔴 drains an existing encrypted MCP auth file to plaintext on read", async () => {
  const cipher = CredentialCipher.make(Buffer.alloc(32, 9))
  const file = authFile(
    CredentialCipher.encryptJson(
      cipher,
      { posthog: { tokens: { accessToken: "was-encrypted" }, serverUrl: "https://mcp.posthog.com/mcp" } },
      "novaclaw:mcp-auth.json",
    ),
  )

  await Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* authService(file.layer)
      expect((yield* auth.get("posthog"))?.tokens?.accessToken).toBe("was-encrypted")
      expect(file.raw()).not.toContain("$novaclawEncrypted")
      expect(file.raw()).toContain("was-encrypted")
    }),
  )
})

/**
 * 🔴 A file that will NOT open must survive being read (NC-REL-030, third site).
 *
 * Two properties, and the second is the dangerous one:
 *   • the read does not crash — `all()` and `mutate()` wrap it in `orDie`, so a document encrypted
 *     under a key that is gone was a crash on every MCP auth read. It degrades to "no stored auth",
 *     which is fail-closed and self-repairing: the next OAuth flow writes a fresh document.
 *   • the file is NOT rewritten. Draining an empty document over ciphertext would destroy the only
 *     copy of tokens that restoring the key would still open — the migration destroying the thing
 *     it is migrating.
 *
 * ⚠️ Written because the A/B caught its absence: flipping the damaged path to `drain: true` left
 * every other test in this file green.
 */
test("🔴 an unopenable MCP auth file neither crashes the read nor gets overwritten", async () => {
  const unopenable = { $novaclawEncrypted: "nc1:AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBBBBBBBB:CCCCCCCCCCCCCCCCCCCCCCCCCC" }
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
  expect(file.raw()).toContain("$novaclawEncrypted")
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
      // 🔴 Plaintext at 0o600 — the unwind of app-managed encryption; see auth/auth.test.ts.
      expect(file.raw()).not.toContain("$novaclawEncrypted")
      expect(file.raw()).toContain("plaintext-access-token")
    }),
  )
})
