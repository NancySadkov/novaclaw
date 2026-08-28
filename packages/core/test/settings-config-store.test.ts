import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { Config } from "@novaclaw/core/config"
import { SettingsConfigSeed } from "@novaclaw/core/settings-config-seed"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { CredentialCipher } from "@novaclaw/core/credential-cipher"
import { Database } from "@novaclaw/core/database/database"
import { RuntimeSettingTable } from "@novaclaw/core/settings-config/sql"
import { eq } from "drizzle-orm"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { FSUtil } from "@novaclaw/core/fs-util"
import { Global } from "@novaclaw/core/global"
import { Location } from "@novaclaw/core/location"
import { Policy } from "@novaclaw/core/policy"
import { AbsolutePath } from "@novaclaw/core/schema"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// Config→SQLite step 6 gates: settings round-trip, the latest()-wins jsonc seed, and the
// synthetic-document overlay that makes every Config.latest() reader store-backed.

/** The envelope field the cipher writes, and a value shaped like one that opens under no key. */
const ENVELOPE_FIELD = "$novaclawEncrypted"
const UNOPENABLE = "nc1:AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBBBBBBBB:CCCCCCCCCCCCCCCCCCCCCCCCCC"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, SettingsConfigStore.node, FSUtil.node, CredentialCipher.node])),
)

describe("SettingsConfigStore", () => {
  it.effect("round-trips values, replaces on set, removes, and reports emptiness", () =>
    Effect.gen(function* () {
      const store = yield* SettingsConfigStore.Service
      expect(yield* store.isEmpty()).toBe(true)

      yield* store.set("username", "store-user")
      yield* store.set("snapshots", false)
      yield* store.set("quality", { enabled: true, cadence: 3 })
      expect(yield* store.isEmpty()).toBe(false)
      expect(yield* store.all()).toEqual({
        username: "store-user",
        snapshots: false,
        quality: { enabled: true, cadence: 3 },
      })

      yield* store.set("username", "edited")
      expect((yield* store.all()).username).toBe("edited")

      yield* store.remove("username")
      yield* store.remove("snapshots")
      yield* store.remove("quality")
      expect(yield* store.isEmpty()).toBe(true)
    }),
  )

  /**
   * 🔴 The unwind of app-managed encryption (`todo/code-review.md`, NC-REL-030).
   *
   * This test asserted the opposite until 2026-08-28: that secrets were stored encrypted. Decision
   * §5 of `decisions-v0.2.0.md` — recorded six days AFTER the cipher landed with a one-line commit
   * and no rationale — says secrets stay plaintext under OS account protection, because no keyring
   * exists in every run mode NovaClaw ships and a partial one strands headless, CLI and
   * backup/restore paths. What shipped was a key FILE beside the database: none of the security, all
   * of the stranding.
   */
  it.effect("stores secrets as plaintext, and DRAINS existing ciphertext on read", () =>
    Effect.gen(function* () {
      const store = yield* SettingsConfigStore.Service
      const { db } = yield* Database.Service
      yield* store.set("server", { port: 4096, password: "incoming-secret" })

      const raw = JSON.stringify(yield* db.select().from(RuntimeSettingTable).all())
      expect(raw).not.toContain("$novaclawEncrypted")
      expect(raw).toContain("incoming-secret")
      expect(yield* store.all()).toMatchObject({ server: { port: 4096, password: "incoming-secret" } })

      // ⚠️ The drain, which is the half that makes stopping safe. An instance that has been running
      // has envelopes on disk; if the read had simply stopped decrypting they would be unreadable
      // forever. A successful open is written back as plaintext while the key is still present.
      const envelope = CredentialCipher.encryptJson(
        yield* CredentialCipher.Service,
        "older-encrypted-secret",
        "novaclaw:runtime-setting:server.password",
      )
      yield* db
        .update(RuntimeSettingTable)
        .set({ value: { port: 4097, password: envelope } })
        .where(eq(RuntimeSettingTable.key, "server"))
        .run()

      expect((yield* store.all()).server).toEqual({ port: 4097, password: "older-encrypted-secret" })
      const drained = JSON.stringify(
        yield* db.select().from(RuntimeSettingTable).where(eq(RuntimeSettingTable.key, "server")).get(),
      )
      expect(drained).not.toContain("$novaclawEncrypted")
      expect(drained).toContain("older-encrypted-secret")
    }),
  )

  /**
   * 🔴 NC-REL-030 — an unreadable secret must not take the instance with it.
   *
   * `reveal` failed and `all()` turned that into a defect with `Effect.orDie`, while the layer
   * graph was still being BUILT (`all()` is called eagerly at the end of the layer). So a secret
   * encrypted under a key that is no longer there meant the HTTP server, the HTML UI, the
   * config-removal route and the Recovery surface could not come into existence — with SQLite
   * perfectly healthy. Losing one file bricked the instance and removed the means to repair it.
   *
   * The ciphertext here is well-formed but authenticates under no key this instance holds, which is
   * exactly the state a restored `credential.key` (or a missing one, replaced by a fresh random)
   * leaves behind.
   *
   * A/B: put `Effect.orDie` back on `reveal` in `all()` and this dies instead of returning.
   */
  it.effect("🔴 survives a secret that cannot be decrypted, and refuses it rather than dropping it", () =>
    Effect.gen(function* () {
      const store = yield* SettingsConfigStore.Service
      const { db } = yield* Database.Service
      // ⚠️ Written straight to the row, because `set` no longer encrypts. The state under test is an
      // instance that HAS been running: envelopes on disk, and a key that no longer opens them.
      yield* store.set("server", { port: 4096, password: "placeholder" })
      yield* db
        .update(RuntimeSettingTable)
        .set({ value: { port: 4096, password: { [ENVELOPE_FIELD]: UNOPENABLE } } })
        .where(eq(RuntimeSettingTable.key, "server"))
        .run()

      const all = yield* store.all()
      const server = all.server as { port: number; password: unknown }
      // It came back at all — that is the fix. Before this, the read was a defect.
      expect(server.port).toBe(4096)

      // ⚠️ And it FAILS CLOSED. The obvious "degrade gracefully" move is to omit the value, and it
      // is a security hole: an instance that HAD a password would boot without one. It is present,
      // a string so every consumer keeps its type, and equal to neither the real password nor the
      // ciphertext it replaced.
      expect(typeof server.password).toBe("string")
      expect(server.password).not.toBe("placeholder")
      expect(server.password).not.toBe("")
      expect(server.password).not.toBe(undefined)
      expect(String(server.password).length).toBeGreaterThanOrEqual(32)
    }),
  )

  /**
   * 🔴 The repair must still be POSSIBLE after booting in the damaged state.
   *
   * `all()` writes back when it opens a legacy plaintext value, and that same write with a damaged
   * value would encrypt the random stand-in under the current key and store it OVER the ciphertext
   * — destroying the only copy of the real secret, which is the thing restoring `credential.key`
   * would otherwise recover. The destructive step must not happen before the record that makes it
   * recoverable exists.
   */
  it.effect("🔴 never writes the stand-in back over the ciphertext", () =>
    Effect.gen(function* () {
      const store = yield* SettingsConfigStore.Service
      const { db } = yield* Database.Service
      yield* store.set("server", { port: 4096, password: "placeholder" })
      yield* db
        .update(RuntimeSettingTable)
        .set({ value: { port: 4096, password: { [ENVELOPE_FIELD]: UNOPENABLE } } })
        .where(eq(RuntimeSettingTable.key, "server"))
        .run()

      yield* store.all()
      yield* store.all()

      const after = yield* db.select().from(RuntimeSettingTable).where(eq(RuntimeSettingTable.key, "server")).get()
      const kept = (after?.value as { password: Record<string, string> }).password
      expect(kept[ENVELOPE_FIELD]).toBe(UNOPENABLE)
      // The stand-in is regenerated per read, so if it were ever persisted the two reads above
      // would already disagree with what is on disk. It is not there at all.
      expect(JSON.stringify(after?.value)).not.toContain("placeholder")
    }),
  )

  it.effect("jsonc seed reads the CONFIG DIR only — a cwd config is ignored — and is idempotent", () =>
    Effect.gen(function* () {
      const store = yield* SettingsConfigStore.Service
      const dir = yield* Effect.promise(() => tmpdir())
      yield* Effect.addFinalizer(() => Effect.promise(() => dir[Symbol.asyncDispose]()))
      const globalDir = path.join(dir.path, "global")
      // NEGATIVE CONTROL. Seeding used to read the launch directory too, so whichever process
      // booted first silently defined instance-wide settings forever (opencode legacy, removed
      // 2026-07-27). This file must never be read: if someone re-adds the leg, `username` flips
      // to "cwd-user" and this test fails.
      const cwdDir = path.join(dir.path, "some-random-cwd")
      yield* Effect.promise(async () => {
        await fs.mkdir(globalDir, { recursive: true })
        await fs.mkdir(cwdDir, { recursive: true })
        await fs.writeFile(
          path.join(globalDir, "novaclaw.jsonc"),
          JSON.stringify({ username: "global-user", snapshots: false, agents: { build: { description: "x" } } }),
        )
        await fs.writeFile(path.join(cwdDir, "novaclaw.jsonc"), JSON.stringify({ username: "cwd-user" }))
      })

      yield* SettingsConfigSeed.seedFromDirectory(globalDir)
      const all = yield* store.all()
      expect(all.username).toBe("global-user") // the config dir is the ONLY source
      expect(all.snapshots).toBe(false)
      expect(all.agents).toBeUndefined() // migrated subsystems never enter the settings store

      // A user edit after seeding must survive a re-seed (the isEmpty idempotence gate).
      yield* store.set("username", "user-edited")
      yield* SettingsConfigSeed.seedFromDirectory(globalDir)
      expect((yield* store.all()).username).toBe("user-edited")
    }),
  )

  it.effect("resilient seed: a malformed key is skipped + reported, valid siblings still apply", () =>
    Effect.gen(function* () {
      const store = yield* SettingsConfigStore.Service
      const dir = yield* Effect.promise(() => tmpdir())
      yield* Effect.addFinalizer(() => Effect.promise(() => dir[Symbol.asyncDispose]()))
      const globalDir = path.join(dir.path, "global")
      yield* Effect.promise(async () => {
        await fs.mkdir(globalDir, { recursive: true })
        // One bad key (`mcp` is a string, not an MCP config) among several valid ones — the
        // OpenCode footgun that used to discard the ENTIRE document.
        await fs.writeFile(
          path.join(globalDir, "novaclaw.jsonc"),
          JSON.stringify({ username: "seed-user", snapshots: false, shell: "bash", mcp: "not-a-valid-mcp-config" }),
        )
      })

      const skipped = yield* SettingsConfigSeed.seedFromDirectory(globalDir)

      // The valid keys were applied despite the malformed sibling (per-key, not all-or-nothing).
      const all = yield* store.all()
      expect(all.username).toBe("seed-user")
      expect(all.snapshots).toBe(false)
      expect(all.shell).toBe("bash")
      // The bad key did NOT land.
      expect(all.mcp).toBeUndefined()
      // ...and the user is told exactly which key was dropped, and from where (the notice payload).
      expect(skipped.map((s) => s.key)).toEqual(["mcp"])
      expect(skipped[0]?.source).toContain("novaclaw.jsonc")
      expect(skipped[0]?.reason.length).toBeGreaterThan(0)
    }),
  )

  it.effect("settingsInfoFromStore builds the synthetic document latest() resolves FIRST", () =>
    Effect.sync(() => {
      const { info, skipped } = SettingsConfigSeed.settingsInfoFromStore({
        username: "store-user",
        snapshots: false,
        ignored_unknown_key: 1,
      })
      expect(skipped).toEqual([]) // an all-valid snapshot takes the whole-document fast path
      expect(info?.username).toBe("store-user")
      const entries = [
        new Config.Document({ type: "document", info: new Config.Info({ username: "doc-user", shell: "bash" }) }),
        new Config.Document({ type: "document", info: info! }),
      ]
      expect(Config.latest(entries, "username")).toBe("store-user") // store beats the doc
      expect(Config.latest(entries, "snapshots")).toBe(false)
      expect(Config.latest(entries, "shell")).toBe("bash") // a key absent from the store falls through
    }),
  )
})

describe("Config layer settings overlay (8c: jsonc is not a runtime source)", () => {
  const memorySettings = (values: Record<string, unknown>) =>
    Layer.succeed(
      SettingsConfigStore.Service,
      SettingsConfigStore.Service.of({
        all: () => Effect.succeed({ ...values }),
        set: (key, value) =>
          Effect.sync(() => {
            values[key] = value
          }),
        remove: (key) =>
          Effect.sync(() => {
            delete values[key]
          }),
        unreadable: () => Effect.succeed([]),
        isEmpty: () => Effect.succeed(Object.keys(values).length === 0),
      }),
    )

  const layerFor = (directory: string, globalDirectory: string, values: Record<string, unknown>) =>
    AppNodeBuilder.build(LayerNode.group([Config.node, Policy.node]), [
      [
        Location.node,
        Layer.succeed(
          Location.Service,
          Location.Service.of(
            location({ directory: AbsolutePath.make(directory) }, { projectDirectory: AbsolutePath.make(directory) }),
          ),
        ),
      ],
      [Global.node, Global.layerWith({ config: globalDirectory })],
      [SettingsConfigStore.node, memorySettings(values)],
    ])

  it.effect("serves the store through the one synthetic document; jsonc files are never read", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      yield* Effect.addFinalizer(() => Effect.promise(() => tmp[Symbol.asyncDispose]()))
      const projectDir = path.join(tmp.path, "project")
      const globalDir = path.join(tmp.path, "global")
      yield* Effect.promise(async () => {
        await fs.mkdir(projectDir, { recursive: true })
        await fs.mkdir(globalDir, { recursive: true })
        // DECOY files: post-8c the runtime must never read them (import seeds + the Import
        // button are the only jsonc consumers).
        await fs.writeFile(
          path.join(projectDir, "novaclaw.jsonc"),
          JSON.stringify({ username: "file-user", shell: "file-shell" }),
        )
        await fs.writeFile(path.join(globalDir, "novaclaw.json"), JSON.stringify({ username: "global-file-user" }))
      })

      yield* Effect.gen(function* () {
        const config = yield* Config.Service
        const entries = yield* config.entries()

        // No file-backed documents exist — the one document is the synthetic (pathless) one.
        const documents = entries.filter((entry): entry is Config.Document => entry.type === "document")
        expect(documents).toHaveLength(1)
        expect(documents[0]?.path).toBeUndefined()

        expect(Config.latest(entries, "username")).toBe("store-user") // the decoy files never load
        expect(Config.latest(entries, "shell")).toBeUndefined()
        // The concat keys ride the same synthetic document (8c moved them with the file cut).
        expect(documents.flatMap((doc) => doc.info.permissions ?? [])).toEqual([
          { action: "bash", resource: "*", effect: "ask" },
        ])

        // Policies load from the store-backed document (the seed preserved rule precedence).
        const policy = yield* Policy.Service
        expect(yield* policy.evaluate("provider.use", "openai", "allow")).toBe("deny")
      }).pipe(
        Effect.provide(
          layerFor(projectDir, globalDir, {
            username: "store-user",
            permissions: [{ action: "bash", resource: "*", effect: "ask" }],
            experimental: { policies: [{ effect: "deny", action: "provider.use", resource: "openai" }] },
          }),
        ),
      )
    }),
  )

  it.effect("seedFromInfos folds concat keys: permissions concat in order, policies reverse-concat", () =>
    Effect.gen(function* () {
      const store = yield* SettingsConfigStore.Service
      const dir = yield* Effect.promise(() => tmpdir())
      yield* Effect.addFinalizer(() => Effect.promise(() => dir[Symbol.asyncDispose]()))
      const globalDir = path.join(dir.path, "global")
      // Two DOCUMENTS from one directory: the seed reads NAMES in order (config.json, novaclaw.json,
      // novaclaw.jsonc), so the general→specific fold is exercised without a second directory.
      yield* Effect.promise(async () => {
        await fs.mkdir(globalDir, { recursive: true })
        await fs.writeFile(
          path.join(globalDir, "config.json"),
          JSON.stringify({
            permissions: [{ action: "bash", resource: "*", effect: "ask" }],
            experimental: { policies: [{ effect: "deny", action: "provider.use", resource: "openai" }] },
          }),
        )
        await fs.writeFile(
          path.join(globalDir, "novaclaw.jsonc"),
          JSON.stringify({
            permissions: [{ action: "edit", resource: "*", effect: "allow" }],
            experimental: { policies: [{ effect: "allow", action: "provider.use", resource: "anthropic" }] },
          }),
        )
      })

      yield* SettingsConfigSeed.seedFromDirectory(globalDir)
      const all = yield* store.all()
      // permissions: document order (general first, specific last) — the agent plugin's flatMap.
      expect(all.permissions).toEqual([
        { action: "bash", resource: "*", effect: "ask" },
        { action: "edit", resource: "*", effect: "allow" },
      ])
      // policies: REVERSE order (a user-global rule overrides a repository rule).
      expect((all.experimental as { policies: unknown[] }).policies).toEqual([
        { effect: "allow", action: "provider.use", resource: "anthropic" },
        { effect: "deny", action: "provider.use", resource: "openai" },
      ])
    }),
  )

  it.effect("seedFromInfos folds instructions with concat + dedup (step 9)", () =>
    Effect.gen(function* () {
      const store = yield* SettingsConfigStore.Service
      const dir = yield* Effect.promise(() => tmpdir())
      yield* Effect.addFinalizer(() => Effect.promise(() => dir[Symbol.asyncDispose]()))
      const globalDir = path.join(dir.path, "global")
      // Two DOCUMENTS from one directory (NAMES order: config.json then novaclaw.jsonc).
      yield* Effect.promise(async () => {
        await fs.mkdir(globalDir, { recursive: true })
        await fs.writeFile(
          path.join(globalDir, "config.json"),
          JSON.stringify({ instructions: ["dup.md", "first-only.md"], disabled_providers: ["openai"] }),
        )
        await fs.writeFile(
          path.join(globalDir, "novaclaw.jsonc"),
          JSON.stringify({ instructions: ["dup.md", "second-only.md"], disabled_providers: ["google"] }),
        )
      })

      yield* SettingsConfigSeed.seedFromDirectory(globalDir)
      const all = yield* store.all()
      // instructions: the V1 config service's historical Set union — concat in document
      // order, first occurrence wins the position.
      expect(all.instructions).toEqual(["dup.md", "first-only.md", "second-only.md"])
      // disabled/enabled_providers: whole-value latest() — the more specific doc wins.
      expect(all.disabled_providers).toEqual(["google"])
    }),
  )
})
