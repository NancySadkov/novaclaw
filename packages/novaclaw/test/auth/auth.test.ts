import { describe, expect } from "bun:test"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Effect } from "effect"
import path from "node:path"
import { FSUtil } from "@novaclaw/core/fs-util"
import { Global } from "@novaclaw/core/global"
import { Auth } from "../../src/auth"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Auth.node, FSUtil.node])))

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

      expect(raw).toContain("plaintext-api-key")
    }),
  )
})
