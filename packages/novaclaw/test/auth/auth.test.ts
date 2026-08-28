import { CredentialCipher } from "@novaclaw/core/credential-cipher"
import { describe, expect } from "bun:test"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Effect } from "effect"
import path from "node:path"
import { FSUtil } from "@novaclaw/core/fs-util"
import { Global } from "@novaclaw/core/global"
import { Auth } from "../../src/auth"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Auth.node, FSUtil.node, CredentialCipher.node])))

describe("Auth", () => {
  it.instance("ignores legacy remote-authority credentials", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const auth = yield* Auth.Service
      const target = path.join(Global.Path.data, "auth.json")
      yield* fs.writeJson(
        target,
        {
          "https://example.com": { type: "wellknown", key: "TOKEN", token: "remote-token" },
          anthropic: { type: "api", key: "local-key" },
        },
        0o600,
      )

      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeUndefined()
      expect(data.anthropic).toEqual(expect.objectContaining({ type: "api", key: "local-key" }))
      const raw = JSON.stringify(yield* fs.readJson(target))
      // 🔴 Plaintext at 0o600, deliberately — the unwind of app-managed encryption. This asserted
      // the opposite until 2026-08-28; decision §5 of `decisions-v0.2.0.md`, recorded after the
      // cipher landed unexplained, says secrets stay plaintext under OS account protection.
      expect(raw).not.toContain("$novaclawEncrypted")
      expect(raw).toContain("local-key")
    }),
  )

  it.instance("sets and removes a local provider credential by provider id", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("anthropic", {
        type: "api",
        key: "sk-test",
      })
      const data = yield* auth.all()
      expect(data["anthropic"]).toBeDefined()
      yield* auth.remove("anthropic")
      const after = yield* auth.all()
      expect(after["anthropic"]).toBeUndefined()
    }),
  )

  it.instance("leaves an already-plaintext auth file alone", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const auth = yield* Auth.Service
      const target = path.join(Global.Path.data, "auth.json")
      yield* fs.writeJson(target, { anthropic: { type: "api", key: "plaintext-api-key" } }, 0o600)

      expect((yield* auth.get("anthropic"))?.type).toBe("api")
      const raw = JSON.stringify(yield* fs.readJson(target))
      expect(raw).not.toContain("$novaclawEncrypted")
      expect(raw).toContain("plaintext-api-key")
    }),
  )

  /**
   * 🔴 The DRAIN — the half that makes it safe to stop encrypting.
   *
   * An instance that has logged in to a provider has an ENCRYPTED `auth.json` on disk. Had the read
   * simply stopped opening envelopes, that file would be unreadable the moment the key went missing
   * and every provider login would be lost. An opened file is written back as plaintext, so the
   * ciphertext leaves while the key is still present.
   *
   * A/B: drop the `if (opened.encrypted) yield* write(...)` in `all()` and this fails.
   */
  it.instance("🔴 drains an existing encrypted auth file to plaintext on read", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const auth = yield* Auth.Service
      const target = path.join(Global.Path.data, "auth.json")
      // ⚠️ The instance's OWN cipher, not a fresh one. The drain only happens when the envelope
      // actually OPENS, so a test that encrypted under a different key would exercise the DAMAGED
      // path and pass for the wrong reason.
      const cipher = yield* CredentialCipher.Service
      yield* fs.writeJson(
        target,
        CredentialCipher.encryptJson(
          cipher,
          { anthropic: { type: "api", key: "was-encrypted" } },
          "novaclaw:auth.json",
        ),
        0o600,
      )

      expect((yield* auth.get("anthropic"))?.type).toBe("api")
      const raw = JSON.stringify(yield* fs.readJson(target))
      expect(raw).not.toContain("$novaclawEncrypted")
      expect(raw).toContain("was-encrypted")
    }),
  )
})
