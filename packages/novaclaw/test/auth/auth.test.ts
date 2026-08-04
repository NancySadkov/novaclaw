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
  it.instance("set normalizes trailing slashes in keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeDefined()
      expect(data["https://example.com/"]).toBeUndefined()
      const raw = JSON.stringify(yield* (yield* FSUtil.Service).readJson(path.join(Global.Path.data, "auth.json")))
      expect(raw).toContain("$novaclawEncrypted")
      expect(raw).not.toContain("abc")
    }),
  )

  it.instance("set cleans up pre-existing trailing-slash entry", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "old",
      })
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "new",
      })
      const data = yield* auth.all()
      const keys = Object.keys(data).filter((key) => key.includes("example.com"))
      expect(keys).toEqual(["https://example.com"])
      const entry = data["https://example.com"]!
      expect(entry.type).toBe("wellknown")
      if (entry.type === "wellknown") expect(entry.token).toBe("new")
    }),
  )

  it.instance("remove deletes both trailing-slash and normalized keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      yield* auth.remove("https://example.com/")
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeUndefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set and remove are no-ops on keys without trailing slashes", () =>
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

  it.instance("migrates a legacy plaintext auth file on read", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const auth = yield* Auth.Service
      const target = path.join(Global.Path.data, "auth.json")
      yield* fs.writeJson(target, { anthropic: { type: "api", key: "plaintext-api-key" } }, 0o600)

      expect((yield* auth.get("anthropic"))?.type).toBe("api")
      const raw = JSON.stringify(yield* fs.readJson(target))
      expect(raw).toContain("$novaclawEncrypted")
      expect(raw).not.toContain("plaintext-api-key")
    }),
  )
})
