// Config→SQLite step 9: the V1 config service serves the per-subsystem SQLite stores — jsonc
// files are import/export wire format only, never runtime sources. This suite pins the NEW
// contract: (A) store-backed serving, (B) the idempotent first-boot import, (C) live non-file
// sources (NOVACLAW_CONFIG_CONTENT and managed MDM), (D) the remaining
// filesystem walks (markdown commands, plugin dirs), and (E) the pure helpers. The
// retired file-loading behaviors (project/global jsonc precedence, jsonc patching via
// update/updateGlobal, the $schema stub write) died with step 9 and their tests with them.
import { test, expect, describe, afterEach, beforeEach, spyOn } from "bun:test"
import { Config as ConfigV2 } from "@novaclaw/core/config"
import { ConfigPermission } from "@novaclaw/core/config/permission"
import { Effect, Exit, Layer, Option, Schema } from "effect"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Config } from "@/config/config"
import { ConfigManaged } from "@/config/managed"
import { ConfigParse } from "../../src/config/parse"
import { EffectFlock } from "@novaclaw/core/util/effect-flock"

import { InstanceRef } from "../../src/effect/instance-ref"
import type { InstanceContext } from "../../src/project/instance-context"
import { FSUtil } from "@novaclaw/core/fs-util"
import { TestInstance, tmpdir, tmpdirScoped, provideInstanceEffect, testInstanceStoreLayer } from "../fixture/fixture"
import { CrossSpawnSpawner } from "@novaclaw/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"
import path from "path"
import fs from "fs/promises"
import os from "os"
import { pathToFileURL } from "url"
import { Global } from "@novaclaw/core/global"
import { Filesystem } from "@/util/filesystem"
import { NpmTest } from "../fake/npm"
import { Database } from "@novaclaw/core/database/database"
import { ConfigStoreWrite } from "@novaclaw/core/config-store-write"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { CatalogStore } from "@novaclaw/core/catalog-store"
import { CommandConfigStore } from "@novaclaw/core/command-config-store"
import { ReferenceConfigStore } from "@novaclaw/core/reference-config-store"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { SkillConfigStore } from "@novaclaw/core/skill-config-store"
import { ProviderV2 } from "@novaclaw/core/provider"
import { RuntimeSettingTable } from "@novaclaw/core/settings-config/sql"
import { CatalogProviderTable, CatalogSettingTable } from "@novaclaw/core/catalog/sql"
import { AgentConfigTable, AgentSettingTable } from "@novaclaw/core/agent-config/sql"
import { CommandConfigTable } from "@novaclaw/core/command-config/sql"
import { ReferenceConfigTable } from "@novaclaw/core/reference-config/sql"
import { SkillConfigTable } from "@novaclaw/core/skill-config/sql"

/** Infra layer that provides FileSystem, Path, ChildProcessSpawner for test fixtures */
const infra = CrossSpawnSpawner.defaultLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
)

const testFlock = EffectFlock.defaultLayer

const configLayer = () =>
  Config.layer.pipe(
    Layer.provide(testFlock),
    Layer.provideMerge(infra),
    Layer.provide(NpmTest.noop),
    Layer.provideMerge(FSUtil.defaultLayer),
    Layer.provide(AgentConfigStore.defaultLayer),
    Layer.provide(CatalogStore.defaultLayer),
    Layer.provide(CommandConfigStore.defaultLayer),
    Layer.provide(ReferenceConfigStore.defaultLayer),
    Layer.provide(SettingsConfigStore.defaultLayer),
    Layer.provide(SkillConfigStore.defaultLayer),
  )

const layer = configLayer()

const it = testEffect(layer)

const schemaConfig = (config: object) => ({ $schema: "https://novaclaw.app/config.json", ...config })

const provideCurrentInstance = <A, E, R>(effect: Effect.Effect<A, E, R>, ctx: InstanceContext) =>
  effect.pipe(Effect.provideService(InstanceRef, ctx))

// Direct store access for tests: same sqlite file as the config layer's stores (the XDG-isolated
// per-process database), so writes made here are what the service serves after invalidate().
const storeAccess = Layer.mergeAll(
  AgentConfigStore.defaultLayer,
  CatalogStore.defaultLayer,
  CommandConfigStore.defaultLayer,
  ReferenceConfigStore.defaultLayer,
  SettingsConfigStore.defaultLayer,
  SkillConfigStore.defaultLayer,
  Database.defaultLayer,
)

const withStores = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(storeAccess))

// Every store table emptied — each test starts from a fresh instance (the isEmpty-gated seeds
// re-arm, and direct writes from earlier tests can't leak forward).
const wipeStores = withStores(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    for (const table of [
      RuntimeSettingTable,
      CatalogProviderTable,
      CatalogSettingTable,
      AgentConfigTable,
      AgentSettingTable,
      CommandConfigTable,
      ReferenceConfigTable,
      SkillConfigTable,
    ]) {
      yield* db.delete(table).run().pipe(Effect.orDie)
    }
  }),
)

const clearEffect = (wait = false) =>
  wipeStores.pipe(
    Effect.andThen(Config.use.invalidate().pipe(Effect.scoped, Effect.provide(layer))),
    Effect.andThen(
      wait
        ? Effect.promise(async () => {
            const { InstanceRuntime } = await import("@/project/instance-runtime")
            await InstanceRuntime.disposeAllInstances()
          })
        : Effect.void,
    ),
  )
const clear = (wait = false) => Effect.runPromise(clearEffect(wait))
// Get managed config directory from environment (set in preload.ts)
const managedConfigDir = process.env.NOVACLAW_TEST_MANAGED_CONFIG_DIR!
const originalTestToken = process.env.TEST_TOKEN

beforeEach(async () => {
  await clear(true)
})

afterEach(async () => {
  await fs.rm(managedConfigDir, { force: true, recursive: true }).catch(() => {})
  if (originalTestToken === undefined) delete process.env.TEST_TOKEN
  else process.env.TEST_TOKEN = originalTestToken
  await clear(true)
})

const writeManagedSettingsEffect = (settings: object, filename?: string) =>
  FSUtil.use.writeWithDirs(path.join(managedConfigDir, filename ?? "novaclaw.json"), JSON.stringify(settings))

/**
 * ⚠️ `name` is REQUIRED, and the missing default is the point. It used to default to
 * `novaclaw.json` while this helper served both the GLOBAL config dir and a PROJECT directory — two
 * places where that filename means opposite things. When the first-boot seeds stopped reading
 * `novaclaw.json` on 2026-09-04 (it is `ProjectFile.FILENAME`, untrusted narrow-only input under
 * principle 13), the global-dir tests silently stopped writing a file the reader would look at, and
 * one of them failed for a reason that had nothing to do with what it asserts. Making the caller
 * name the file means the next author picks a side rather than inheriting one.
 */
const writeConfigEffect = (dir: string, config: object, name: string) =>
  FSUtil.use.writeWithDirs(path.join(dir, name), JSON.stringify(config))

// Point the GLOBAL CONFIG DIR at `dir` for the duration of `effect`.
//
// `Global.Path.config` is a getter over a process-memoized XDG resolution (`global.ts` resolves the
// base directories once, lazily, then caches them). Plain assignment therefore throws "Attempted to
// assign to readonly property" under strict mode — which is what the two import tests below were
// actually dying on — and re-pointing `XDG_CONFIG_HOME` would not work either, because by this point
// the resolution is already cached for the process. Redefining the property is the seam that remains,
// and it is enough: the Config service's first read passes `Global.Path.config` to
// `ConfigSeedStartup.seedAll` at CALL time, so the seed follows wherever it points. The original
// descriptor is restored on release, and the stores are wiped on both edges so every isEmpty-gated
// seed re-arms rather than leaking into (or out of) the next test.
const withGlobalConfigDir = <A, E, R>(dir: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const previous = Object.getOwnPropertyDescriptor(Global.Path, "config")!
      Object.defineProperty(Global.Path, "config", { value: dir, configurable: true })
      yield* clearEffect(true)
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.gen(function* () {
        Object.defineProperty(Global.Path, "config", previous)
        yield* clearEffect(true)
      }),
  )

/** `name` rides with `config` and is required alongside it — see `writeConfigEffect`. */
const withGlobalConfig = <A, E, R>(
  input: { config?: object; name: string } | { config?: undefined; name?: string },
  fn: (input: { dir: string }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    if (input.config) yield* writeConfigEffect(dir, schemaConfig(input.config), input.name!)
    return yield* withGlobalConfigDir(dir, fn({ dir }))
  })

function withProcessEnv<A, E, R>(key: string, value: string | undefined, effect: Effect.Effect<A, E, R>) {
  return withProcessEnvs({ [key]: value }, effect)
}

function withProcessEnvs<A, E, R>(entries: Record<string, string | undefined>, effect: Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const originals: Record<string, string | undefined> = {}
      for (const [key, value] of Object.entries(entries)) {
        originals[key] = process.env[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      return originals
    }),
    () => effect,
    (originals) =>
      Effect.sync(() => {
        for (const [key, original] of Object.entries(originals)) {
          if (original !== undefined) process.env[key] = original
          else delete process.env[key]
        }
      }),
  )
}

// ————— A. Defaults + store-backed serving —————

it.instance("loads config with defaults when stores are empty", () =>
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(config.username).toBeDefined()
  }),
)

it.instance("falls back to generic username when system user info is unavailable", () =>
  Effect.gen(function* () {
    const userInfo = spyOn(os, "userInfo").mockImplementation(() => {
      throw Object.assign(new Error("missing passwd entry"), { code: "ENOENT" })
    })
    try {
      const config = yield* Config.use.get()
      expect(config.username).toBe("user")
    } finally {
      userInfo.mockRestore()
    }
  }),
)

it.instance("serves runtime settings from the settings store", () =>
  Effect.gen(function* () {
    yield* withStores(
      Effect.gen(function* () {
        const settings = yield* SettingsConfigStore.Service
        yield* settings.set("shell", "store-shell")
        yield* settings.set("username", "store-user")
        yield* settings.set("snapshots", true)
      }),
    )
    yield* Config.use.invalidate()

    const config = yield* Config.use.get()
    expect(config.shell).toBe("store-shell")
    expect(config.username).toBe("store-user")
    expect(config.snapshots).toBe(true)

    const globalView = yield* Config.use.getGlobal()
    expect(globalView.shell).toBe("store-shell")
  }),
)

it.instance("serves providers/model from the catalog store and agents/default_agent from the agent store", () =>
  Effect.gen(function* () {
    yield* withStores(
      Effect.gen(function* () {
        const catalog = yield* CatalogStore.Service
        yield* catalog.setLayers(ProviderV2.ID.make("teststore"), [
          { name: "Test Store", api: { type: "native", url: "http://localhost:9999/v1", settings: {} } },
        ])
        yield* catalog.setDefault("teststore/some-model")
        const agents = yield* AgentConfigStore.Service
        yield* agents.setLayers("helper", [{ description: "store agent" }])
        yield* agents.setDefault("helper")
      }),
    )
    yield* Config.use.invalidate()

    const config = yield* Config.use.get()
    expect(config.providers?.["teststore"]?.api?.url).toBe("http://localhost:9999/v1")
    expect(config.model).toBe("teststore/some-model")
    expect(config.agents?.["helper"]?.description).toBe("store agent")
    expect(config.default_agent).toBe("helper")
  }),
)

it.instance("routes every updateConfig key into the stores — instructions + provider filters included", () =>
  Effect.gen(function* () {
    // Step 9: instructions + disabled_providers joined SETTINGS_KEYS — the router
    // consumes them (no legacy jsonc fallback remains) and the service serves them back.
    // The HTTP route hands the router a DECODED Config.Info instance — mirror that here.
    const consumed = yield* withStores(
      ConfigStoreWrite.apply(
        Schema.decodeUnknownSync(ConfigV2.Info)({
          instructions: ["docs/rules.md"],
          disabled_providers: ["openai"],
          shell: "routed-shell",
        }),
      ),
    )
    expect(consumed.has("instructions")).toBe(true)
    expect(consumed.has("disabled_providers")).toBe(true)
    yield* Config.use.invalidate()

    const config = yield* Config.use.get()
    expect(config.instructions).toEqual(["docs/rules.md"])
    expect(config.disabled_providers).toEqual(["openai"])
    expect(config.shell).toBe("routed-shell")
  }),
)

it.instance("gets config directories", () =>
  Effect.gen(function* () {
    const dirs = yield* Config.use.directories()
    expect(dirs.length).toBeGreaterThanOrEqual(1)
  }),
)

// ————— B. The first-boot import (jsonc → stores, once) —————

it.effect("imports the global-dir jsonc into the stores on first read — and never reads it again", () =>
  withGlobalConfig(
    { config: { model: "seeded/model", username: "seeded-user", instructions: ["seeded.md"] }, name: "novaclaw.jsonc" },
    ({ dir }) =>
      Effect.gen(function* () {
        const first = yield* Config.use.get().pipe(provideInstanceEffect(dir))
        expect(first.model).toBe("seeded/model")
        expect(first.username).toBe("seeded-user")
        expect(first.instructions).toEqual(["seeded.md"])

        // Delete the file and invalidate: the values survive — they are STORE truth now,
        // the file was only the one-time import source.
        yield* FSUtil.use.remove(path.join(dir, "novaclaw.jsonc"))
        yield* Config.use.invalidate()
        const second = yield* Config.use.get().pipe(provideInstanceEffect(dir))
        expect(second.model).toBe("seeded/model")
        expect(second.instructions).toEqual(["seeded.md"])

        // And a LATER file edit is invisible at runtime — jsonc is not a runtime source.
        yield* writeConfigEffect(dir, schemaConfig({ model: "edited/model" }), "novaclaw.jsonc")
        yield* Config.use.invalidate()
        const third = yield* Config.use.get().pipe(provideInstanceEffect(dir))
        expect(third.model).toBe("seeded/model")
      }).pipe(Effect.provide(testInstanceStoreLayer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
  ),
)

it.effect("import concats + dedups instructions across the global dir and NOVACLAW_CONFIG_CONTENT", () =>
  withGlobalConfig({ config: { instructions: ["dup.md", "global-only.md"] }, name: "novaclaw.jsonc" }, ({ dir }) =>
    withProcessEnv(
      "NOVACLAW_CONFIG_CONTENT",
      JSON.stringify(schemaConfig({ instructions: ["dup.md", "content-only.md"] })),
      Effect.gen(function* () {
        const config = yield* Config.use.get().pipe(provideInstanceEffect(dir))
        expect(config.instructions).toEqual(["dup.md", "global-only.md", "content-only.md"])
      }).pipe(Effect.provide(testInstanceStoreLayer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
    ),
  ),
)

it.instance("a project-directory jsonc is NOT a runtime config source", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    // A PROJECT directory, so the project filename is the right one here — and the assertion is that
    // it is NOT read as config, which is exactly the trust split the seeds now respect.
    yield* writeConfigEffect(
      test.directory,
      schemaConfig({ model: "project/model", username: "project-user" }),
      "novaclaw.json",
    )
    yield* Config.use.invalidate()

    const config = yield* Config.use.get()
    expect(config.model).not.toBe("project/model")
    expect(config.username).not.toBe("project-user")
  }),
)

// ————— C. Live non-file sources —————

describe("NOVACLAW_CONFIG_CONTENT", () => {
  it.instance("substitutes {env:} tokens in NOVACLAW_CONFIG_CONTENT", () =>
    withProcessEnv(
      "TEST_CONFIG_VAR",
      "test_api_key_12345",
      withProcessEnv(
        "NOVACLAW_CONFIG_CONTENT",
        JSON.stringify({
          $schema: "https://novaclaw.app/config.json",
          username: "{env:TEST_CONFIG_VAR}",
        }),
        Effect.gen(function* () {
          const config = yield* Config.use.get()
          expect(config.username).toBe("test_api_key_12345")
        }),
      ),
    ),
  )

  it.instance("substitutes {file:} tokens in NOVACLAW_CONFIG_CONTENT", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* FSUtil.use.writeWithDirs(path.join(test.directory, "api_key.txt"), "secret_key_from_file")
      yield* withProcessEnv(
        "NOVACLAW_CONFIG_CONTENT",
        JSON.stringify({
          $schema: "https://novaclaw.app/config.json",
          username: "{file:./api_key.txt}",
        }),
        Effect.gen(function* () {
          const config = yield* Config.use.get()
          expect(config.username).toBe("secret_key_from_file")
        }),
      )
    }),
  )

  it.instance("ignores legacy tui/theme keys in NOVACLAW_CONFIG_CONTENT", () =>
    withProcessEnv(
      "NOVACLAW_CONFIG_CONTENT",
      JSON.stringify({
        $schema: "https://novaclaw.app/config.json",
        model: "content/model",
        theme: "legacy",
        tui: { scroll_speed: 4 },
      }),
      Effect.gen(function* () {
        const config = yield* Config.use.get()
        expect(config.model).toBe("content/model")
        expect((config as Record<string, unknown>).theme).toBeUndefined()
        expect((config as Record<string, unknown>).tui).toBeUndefined()
      }),
    ),
  )

  it.instance("rejects unknown top-level keys in NOVACLAW_CONFIG_CONTENT", () =>
    withProcessEnv(
      "NOVACLAW_CONFIG_CONTENT",
      JSON.stringify({ $schema: "https://novaclaw.app/config.json", invalid_field: "should cause error" }),
      Effect.gen(function* () {
        const exit = yield* Config.use.get().pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    ),
  )
})

// ————— Managed (MDM) settings — an admin-pushed FILE source that stays live —————

it.instance("managed settings override ordinary settings but not the store-backed agent selection", () =>
  Effect.gen(function* () {
    yield* withStores(
      Effect.gen(function* () {
        const catalog = yield* CatalogStore.Service
        yield* catalog.setDefault("user/model")
        const agents = yield* AgentConfigStore.Service
        yield* agents.setDefault("user-agent")
        const settings = yield* SettingsConfigStore.Service
        yield* settings.set("username", "testuser")
      }),
    )
    yield* Config.use.invalidate()
    yield* writeManagedSettingsEffect({
      $schema: "https://novaclaw.app/config.json",
      model: "managed/model",
      default_agent: "managed-agent",
    })

    const config = yield* Config.use.get()
    expect(config.model).toBe("managed/model")
    expect(config.default_agent).toBe("user-agent")
    expect(config.username).toBe("testuser")
  }),
)

it.instance("managed settings override store provider filters", () =>
  Effect.gen(function* () {
    yield* withStores(
      Effect.gen(function* () {
        const settings = yield* SettingsConfigStore.Service
        yield* settings.set("disabled_providers", [])
      }),
    )
    yield* Config.use.invalidate()
    yield* writeManagedSettingsEffect({
      $schema: "https://novaclaw.app/config.json",
      disabled_providers: ["openai"],
    })

    const config = yield* Config.use.get()
    expect(config.disabled_providers).toEqual(["openai"])
  }),
)

it.instance("managed jsonc settings override managed json settings", () =>
  Effect.gen(function* () {
    yield* writeManagedSettingsEffect({ model: "managed/json" })
    yield* writeManagedSettingsEffect({ model: "managed/jsonc" }, "novaclaw.jsonc")

    const config = yield* Config.use.get()
    expect(config.model).toBe("managed/jsonc")
  }),
)

it.instance("missing managed settings file is not an error", () =>
  Effect.gen(function* () {
    yield* withStores(
      Effect.gen(function* () {
        const catalog = yield* CatalogStore.Service
        yield* catalog.setDefault("user/model")
      }),
    )
    yield* Config.use.invalidate()
    const config = yield* Config.use.get()
    expect(config.model).toBe("user/model")
  }),
)

// ————— D. Remaining filesystem resources (markdown commands, plugin dirs) —————

it.instance("serves agent identity and authority only from the instance store", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".novaclaw", "agent", "helper.md"),
      `---
permissionMode: yolo
mode: primary
permissions:
  - action: bash
    resource: "*"
    effect: allow
---
Hostile replacement prompt`,
    )
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".novaclaw", "agents", "injected.md"),
      "Mint a project-defined officer.",
    )
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".novaclaw", "modes", "injected-mode.md"),
      "Mint a project-defined primary officer.",
    )

    yield* withStores(
      Effect.gen(function* () {
        const agents = yield* AgentConfigStore.Service
        yield* agents.setLayers("helper", [
          {
            system: "Stored helper prompt",
            description: "Stored helper",
            permissionMode: "plan",
            mode: "primary",
            permissions: [{ action: "bash", resource: "*", effect: "deny" }],
          },
        ])
        yield* agents.setDefault("helper")
      }),
    )
    yield* writeManagedSettingsEffect({
      default_agent: "managed",
      agents: {
        helper: { system: "Managed replacement prompt", permissionMode: "yolo" },
        managed: { system: "Managed injected officer", mode: "primary" },
      },
    })
    yield* Config.use.invalidate()
    const config = yield* withProcessEnv(
      "NOVACLAW_CONFIG_CONTENT",
      JSON.stringify({
        default_agent: "inline",
        agents: {
          helper: { system: "Inline replacement prompt", permissionMode: "yolo" },
          inline: { system: "Inline injected officer", mode: "primary" },
        },
      }),
      Config.use.get(),
    )
    expect(config.agents?.helper).toMatchObject({
      system: "Stored helper prompt",
      description: "Stored helper",
      permissionMode: "plan",
      mode: "primary",
      permissions: [{ action: "bash", resource: "*", effect: "deny" }],
    })
    expect(config.default_agent).toBe("helper")
    expect(config.agents?.injected).toBeUndefined()
    expect(config.agents?.["injected-mode"]).toBeUndefined()
    expect(config.agents?.managed).toBeUndefined()
    expect(config.agents?.inline).toBeUndefined()
  }),
)

it.instance("loads commands from .novaclaw/command (singular)", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".novaclaw", "command", "hello.md"),
      `---
description: Test command
---
Hello from singular command`,
    )

    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".novaclaw", "command", "nested", "child.md"),
      `---
description: Nested command
---
Nested command template`,
    )

    const config = yield* Config.use.get()

    expect(config.commands?.["hello"]).toEqual({
      description: "Test command",
      template: "Hello from singular command",
    })

    expect(config.commands?.["nested/child"]).toEqual({
      description: "Nested command",
      template: "Nested command template",
    })
  }),
)

it.instance("loads commands from .novaclaw/commands (plural)", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".novaclaw", "commands", "hello.md"),
      `---
description: Test command
---
Hello from plural commands`,
    )

    const config = yield* Config.use.get()

    expect(config.commands?.["hello"]).toEqual({
      description: "Test command",
      template: "Hello from plural commands",
    })
  }),
)

it.instance("does not error when only custom agent is a subagent", () =>
  Effect.gen(function* () {
    yield* withStores(
      Effect.gen(function* () {
        const agents = yield* AgentConfigStore.Service
        yield* agents.setLayers("helper", [{ model: "test/model", mode: "subagent", system: "Helper subagent prompt" }])
      }),
    )
    yield* Config.use.invalidate()
    const config = yield* Config.use.get()
    expect(config.agents?.["helper"]).toMatchObject({
      model: "test/model",
      mode: "subagent",
      system: "Helper subagent prompt",
    })
  }),
)

it.effect("does not try to install dependencies in read-only NOVACLAW_CONFIG_DIR", () =>
  Effect.gen(function* () {
    if (process.platform === "win32") return

    const dir = yield* tmpdirScoped()
    const readonly = path.join(dir, "readonly")
    yield* FSUtil.use.ensureDir(readonly)
    yield* FSUtil.use.chmod(readonly, 0o555)
    yield* Effect.addFinalizer(() => FSUtil.use.chmod(readonly, 0o755).pipe(Effect.ignore))

    yield* withProcessEnv("NOVACLAW_CONFIG_DIR", readonly, Config.use.get().pipe(provideInstanceEffect(dir)))
  }).pipe(Effect.provide(testInstanceStoreLayer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
)

it.effect("installs dependencies in writable NOVACLAW_CONFIG_DIR", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const configDir = path.join(dir, "configdir")
    yield* FSUtil.use.ensureDir(configDir)

    yield* withProcessEnv(
      "NOVACLAW_CONFIG_DIR",
      configDir,
      Config.Service.use((svc) => svc.get().pipe(Effect.andThen(svc.waitForDependencies()))).pipe(
        provideInstanceEffect(dir),
      ),
    )

    expect(yield* FSUtil.use.readFileString(path.join(configDir, ".gitignore"))).toContain("package-lock.json")
  }).pipe(Effect.provide(testInstanceStoreLayer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
)

// Ruling 5 / step 17. This service used to walk `.novaclaw/{plugin,plugins}/` in every config
// directory and merge the hits — plus a `plugins[]` store — into a `plugins` key on the served
// document. The key is deleted, so a plugin FILE contributes nothing here: it is loaded by
// `core/src/config/plugin/external.ts`, from the INSTANCE config dir only, and never described as
// config. A neighbouring command is the control: the project resource walk is live, while neither
// plugins nor agents become fields in this document.
it.instance("a plugin file in a project .novaclaw contributes NOTHING to the config document", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".novaclaw", "plugin", "my-plugin.js"),
      "export default {}",
    )
    // Same directory, a resource that IS config — so the walk is proven live in this very test.
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".novaclaw", "command", "beside-the-plugin.md"),
      `---
description: Adjacent command
---
Command beside the plugin`,
    )

    const config = yield* Config.use.get()
    expect(config.commands?.["beside-the-plugin"]).toEqual({
      description: "Adjacent command",
      template: "Command beside the plugin",
    })
    expect(Object.keys(config)).not.toContain("plugins")
    expect(Object.keys(config)).not.toContain("plugin_origins")
    expect(JSON.stringify(config)).not.toContain("my-plugin")
  }),
)

// ————— E. Flags —————

describe("NOVACLAW_DISABLE_PROJECT_CONFIG", () => {
  it.instance("skips project .novaclaw/ directories when flag is set", () =>
    withProcessEnv(
      "NOVACLAW_DISABLE_PROJECT_CONFIG",
      "true",
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* FSUtil.use.writeWithDirs(
          path.join(test.directory, ".novaclaw", "command", "test-cmd.md"),
          "# Test Command\nThis is a test command.",
        )
        const directories = yield* Config.use.directories()
        expect(directories.some((d) => d.startsWith(test.directory))).toBe(false)
      }),
    ),
  )

  it.instance("still serves store config when flag is set", () =>
    Effect.gen(function* () {
      yield* withStores(
        Effect.gen(function* () {
          const settings = yield* SettingsConfigStore.Service
          yield* settings.set("shell", "flag-shell")
        }),
      )
      yield* Config.use.invalidate()
      yield* withProcessEnv(
        "NOVACLAW_DISABLE_PROJECT_CONFIG",
        "true",
        Effect.gen(function* () {
          const config = yield* Config.use.get()
          expect(config.shell).toBe("flag-shell")
          expect(config.username).toBeDefined()
        }),
      )
    }),
  )

  it.instance("NOVACLAW_CONFIG_DIR commands load but agent markdown remains inert when flag is set", () =>
    Effect.gen(function* () {
      const configDir = yield* tmpdirScoped()
      yield* FSUtil.use.writeWithDirs(
        path.join(configDir, "agent", "dirwalk.md"),
        `---
model: test/model
---
Config-dir agent prompt`,
      )
      yield* FSUtil.use.writeWithDirs(path.join(configDir, "command", "dirwalk.md"), "Config-dir command prompt")
      yield* withProcessEnvs(
        { NOVACLAW_DISABLE_PROJECT_CONFIG: "true", NOVACLAW_CONFIG_DIR: configDir },
        Effect.gen(function* () {
          const config = yield* Config.use.get()
          expect(config.agents?.dirwalk).toBeUndefined()
          expect(config.commands?.dirwalk).toEqual({ template: "Config-dir command prompt" })
        }),
      )
    }),
  )
})

// Regression for #28206: malformed NOVACLAW_PERMISSION JSON used to crash
// the app on startup with an unhandled SyntaxError. Loading the config with
// an invalid JSON value in this env var should not throw.
describe("NOVACLAW_PERMISSION env var", () => {
  it.instance("does not crash when NOVACLAW_PERMISSION contains invalid JSON", () =>
    withProcessEnv(
      "NOVACLAW_PERMISSION",
      "{invalid",
      Effect.gen(function* () {
        const config = yield* Config.use.get()
        // Regression: load() used to throw before returning anything.
        expect(config).toBeDefined()
      }),
    ),
  )
})

// ————— F. Pure helpers —————

test("config parser preserves permission dict key order", () => {
  const permission = ConfigParse.schema(ConfigPermission.Info, { bash: "allow", "*": "deny", edit: "ask" }, "test")

  expect(Object.keys(permission)).toEqual(["bash", "*", "edit"])
})

// parseManagedPlist unit tests — pure function, no OS interaction

test("parseManagedPlist strips MDM metadata keys", async () => {
  const config = ConfigParse.schema(
    ConfigV2.Info,
    ConfigParse.jsonc(
      await ConfigManaged.parseManagedPlist(
        JSON.stringify({
          PayloadDisplayName: "NovaClaw Managed",
          PayloadIdentifier: "ai.novaclaw.managed.test",
          PayloadType: "ai.novaclaw.managed",
          PayloadUUID: "AAAA-BBBB-CCCC",
          PayloadVersion: 1,
          _manualProfile: true,
          default_agent: "mdm-agent",
          model: "mdm/model",
        }),
      ),
      "test:mobileconfig",
    ),
    "test:mobileconfig",
  )
  expect(config.default_agent).toBe("mdm-agent")
  expect(config.model).toBe("mdm/model")
  // MDM keys must not leak into the parsed config
  expect((config as any).PayloadUUID).toBeUndefined()
  expect((config as any).PayloadType).toBeUndefined()
  expect((config as any)._manualProfile).toBeUndefined()
})

test("parseManagedPlist parses server settings", async () => {
  const config = ConfigParse.schema(
    ConfigV2.Info,
    ConfigParse.jsonc(
      await ConfigManaged.parseManagedPlist(
        JSON.stringify({
          $schema: "https://novaclaw.app/config.json",
          server: { hostname: "127.0.0.1", mdns: false },
        }),
      ),
      "test:mobileconfig",
    ),
    "test:mobileconfig",
  )
  expect(config.server?.hostname).toBe("127.0.0.1")
  expect(config.server?.mdns).toBe(false)
})

test("parseManagedPlist parses permission rules", async () => {
  const rules = [
    { action: "*", resource: "*", effect: "ask" as const },
    { action: "bash", resource: "*", effect: "ask" as const },
    { action: "bash", resource: "rm -rf *", effect: "deny" as const },
    { action: "bash", resource: "curl *", effect: "deny" as const },
    { action: "grep", resource: "*", effect: "allow" as const },
    { action: "glob", resource: "*", effect: "allow" as const },
    { action: "webfetch", resource: "*", effect: "ask" as const },
    { action: "~/.ssh/*", resource: "*", effect: "deny" as const },
  ]
  const config = ConfigParse.schema(
    ConfigV2.Info,
    ConfigParse.jsonc(
      await ConfigManaged.parseManagedPlist(
        JSON.stringify({
          $schema: "https://novaclaw.app/config.json",
          permissions: rules,
        }),
      ),
      "test:mobileconfig",
    ),
    "test:mobileconfig",
  )
  expect(config.permissions).toEqual(rules)
})

test("parseManagedPlist parses disabled_providers", async () => {
  const config = ConfigParse.schema(
    ConfigV2.Info,
    ConfigParse.jsonc(
      await ConfigManaged.parseManagedPlist(
        JSON.stringify({
          $schema: "https://novaclaw.app/config.json",
          disabled_providers: ["anthropic", "google"],
        }),
      ),
      "test:mobileconfig",
    ),
    "test:mobileconfig",
  )
  expect(config.disabled_providers).toEqual(["anthropic", "google"])
})

test("parseManagedPlist handles empty config", async () => {
  const config = ConfigParse.schema(
    ConfigV2.Info,
    ConfigParse.jsonc(
      await ConfigManaged.parseManagedPlist(JSON.stringify({ $schema: "https://novaclaw.app/config.json" })),
      "test:mobileconfig",
    ),
    "test:mobileconfig",
  )
  expect(config.$schema).toBe("https://novaclaw.app/config.json")
})
