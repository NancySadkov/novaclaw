// Config→SQLite step 9: the V1 config service serves the per-subsystem SQLite stores — jsonc
// files are import/export wire format only, never runtime sources. This suite pins the NEW
// contract: (A) store-backed serving, (B) the idempotent first-boot import, (C) live non-file
// sources (NOVACLAW_CONFIG_CONTENT, remote well-known, account, managed MDM), (D) the D2
// filesystem walks (markdown agents/commands, plugin dirs), and (E) the pure helpers. The
// retired file-loading behaviors (project/global jsonc precedence, jsonc patching via
// update/updateGlobal, the $schema stub write) died with step 9 and their tests with them.
import { test, expect, describe, afterEach, beforeEach, spyOn } from "bun:test"
import { Config as ConfigV2 } from "@novaclaw/core/config"
import { ConfigPermission } from "@novaclaw/core/config/permission"
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect"
import { NamedError } from "@novaclaw/core/util/error"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Config } from "@/config/config"
import { ConfigManaged } from "@/config/managed"
import { ConfigParse } from "../../src/config/parse"
import { EffectFlock } from "@novaclaw/core/util/effect-flock"

import { InstanceRef } from "../../src/effect/instance-ref"
import type { InstanceContext } from "../../src/project/instance-context"
import { Auth } from "../../src/auth"
import { Account } from "../../src/account/account"
import { AccessToken, AccountID, OrgID } from "../../src/account/schema"
import { FSUtil } from "@novaclaw/core/fs-util"
import { Env } from "../../src/env"
import {
  provideTmpdirInstance,
  TestInstance,
  tmpdir,
  tmpdirScoped,
  provideInstanceEffect,
  testInstanceStoreLayer,
} from "../fixture/fixture"
import { CrossSpawnSpawner } from "@novaclaw/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"
import path from "path"
import fs from "fs/promises"
import os from "os"
import { pathToFileURL } from "url"
import { Global } from "@novaclaw/core/global"
import { Filesystem } from "@/util/filesystem"
import { ConfigPlugin } from "@/config/plugin"
import { ConfigPluginSpec } from "@novaclaw/core/config/plugin-spec"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { Database } from "@novaclaw/core/database/database"
import { ConfigStoreWrite } from "@novaclaw/core/config-store-write"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { CatalogStore } from "@novaclaw/core/catalog-store"
import { CommandConfigStore } from "@novaclaw/core/command-config-store"
import { PluginConfigStore } from "@novaclaw/core/plugin-config-store"
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
import { PluginConfigTable } from "@novaclaw/core/plugin-config/sql"

/** Infra layer that provides FileSystem, Path, ChildProcessSpawner for test fixtures */
const infra = CrossSpawnSpawner.defaultLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
)

const testFlock = EffectFlock.defaultLayer

const unexpectedHttp = HttpClient.make((request) =>
  Effect.die(`unexpected http request: ${request.method} ${request.url}`),
)

const json = (request: Parameters<typeof HttpClientResponse.fromWeb>[0], body: unknown, status = 200) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  )

const wellKnownAuth = (url: string) =>
  Layer.mock(Auth.Service)({
    all: () =>
      Effect.succeed({
        [url]: new Auth.WellKnown({ type: "wellknown", key: "TEST_TOKEN", token: "test-token" }),
      }),
  })

function remoteConfigClient(input: {
  wellKnown: unknown
  remote?: unknown
  remoteHtml?: string
  seen: { wellKnown?: string; remote?: string; authorization?: string }
}) {
  return HttpClient.make((request) => {
    if (request.url.includes(".well-known/novaclaw")) {
      input.seen.wellKnown = request.url
      return Effect.succeed(json(request, input.wellKnown))
    }
    if (request.url.includes("config.example.com") && (input.remote !== undefined || input.remoteHtml !== undefined)) {
      input.seen.remote = request.url
      input.seen.authorization = request.headers.authorization
      if (input.remoteHtml !== undefined) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(input.remoteHtml, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
          ),
        )
      }
      return Effect.succeed(json(request, input.remote))
    }
    return Effect.succeed(json(request, {}, 404))
  })
}

const configLayer = (
  options: {
    auth?: Layer.Layer<Auth.Service>
    account?: Layer.Layer<Account.Service>
    client?: HttpClient.HttpClient
  } = {},
) =>
  Config.layer.pipe(
    Layer.provide(testFlock),
    Layer.provide(Env.defaultLayer),
    Layer.provide(options.auth ?? AuthTest.empty),
    Layer.provide(options.account ?? AccountTest.empty),
    Layer.provideMerge(infra),
    Layer.provide(NpmTest.noop),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, options.client ?? unexpectedHttp)),
    Layer.provideMerge(FSUtil.defaultLayer),
    Layer.provide(AgentConfigStore.defaultLayer),
    Layer.provide(CatalogStore.defaultLayer),
    Layer.provide(CommandConfigStore.defaultLayer),
    Layer.provide(PluginConfigStore.defaultLayer),
    Layer.provide(ReferenceConfigStore.defaultLayer),
    Layer.provide(SettingsConfigStore.defaultLayer),
    Layer.provide(SkillConfigStore.defaultLayer),
  )

const layer = configLayer()

const it = testEffect(layer)
const configIt = (options?: Parameters<typeof configLayer>[0]) => testEffect(configLayer(options))

const schemaConfig = (config: object) => ({ $schema: "https://novaclaw.app/config.json", ...config })

const provideCurrentInstance = <A, E, R>(effect: Effect.Effect<A, E, R>, ctx: InstanceContext) =>
  effect.pipe(Effect.provideService(InstanceRef, ctx))

// Direct store access for tests: same sqlite file as the config layer's stores (the XDG-isolated
// per-process database), so writes made here are what the service serves after invalidate().
const storeAccess = Layer.mergeAll(
  AgentConfigStore.defaultLayer,
  CatalogStore.defaultLayer,
  CommandConfigStore.defaultLayer,
  PluginConfigStore.defaultLayer,
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
      PluginConfigTable,
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
const originalConsoleToken = process.env.NOVACLAW_CONSOLE_TOKEN

beforeEach(async () => {
  await clear(true)
})

afterEach(async () => {
  await fs.rm(managedConfigDir, { force: true, recursive: true }).catch(() => {})
  if (originalTestToken === undefined) delete process.env.TEST_TOKEN
  else process.env.TEST_TOKEN = originalTestToken
  if (originalConsoleToken === undefined) delete process.env.NOVACLAW_CONSOLE_TOKEN
  else process.env.NOVACLAW_CONSOLE_TOKEN = originalConsoleToken
  await clear(true)
})

const writeManagedSettingsEffect = (settings: object, filename?: string) =>
  FSUtil.use.writeWithDirs(path.join(managedConfigDir, filename ?? "novaclaw.json"), JSON.stringify(settings))

const writeConfigEffect = (dir: string, config: object, name = "novaclaw.json") =>
  FSUtil.use.writeWithDirs(path.join(dir, name), JSON.stringify(config))

const withGlobalConfigDir = <A, E, R>(dir: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const previous = Global.Path.config
      ;(Global.Path as { config: string }).config = dir
      yield* clearEffect(true)
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.gen(function* () {
        ;(Global.Path as { config: string }).config = previous
        yield* clearEffect(true)
      }),
  )

const withGlobalConfig = <A, E, R>(
  input: { config?: object; name?: string },
  fn: (input: { dir: string }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    if (input.config) yield* writeConfigEffect(dir, schemaConfig(input.config), input.name)
    return yield* withGlobalConfigDir(dir, fn({ dir }))
  })

const wellKnown = (input: {
  authUrl?: string
  config?: unknown
  remoteConfig?: { url: string; headers?: Record<string, string> }
  remote?: unknown
  remoteHtml?: string
  wellKnown?: unknown
}) => {
  const seen: { wellKnown?: string; remote?: string; authorization?: string } = {}
  const client = remoteConfigClient({
    seen,
    wellKnown: input.wellKnown ?? {
      ...(input.config !== undefined ? { config: input.config } : {}),
      ...(input.remoteConfig !== undefined ? { remote_config: input.remoteConfig } : {}),
    },
    remote: input.remote,
    remoteHtml: input.remoteHtml,
  })
  return {
    seen,
    it: configIt({ auth: wellKnownAuth(input.authUrl ?? "https://example.com"), client }),
  }
}

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
    // Step 9: instructions + disabled/enabled_providers joined SETTINGS_KEYS — the router
    // consumes them (no legacy jsonc fallback remains) and the service serves them back.
    // The HTTP route hands the router a DECODED Config.Info instance — mirror that here.
    const consumed = yield* withStores(
      ConfigStoreWrite.apply(
        Schema.decodeUnknownSync(ConfigV2.Info)({
          instructions: ["docs/rules.md"],
          disabled_providers: ["openai"],
          enabled_providers: ["teststore"],
          shell: "routed-shell",
        }),
      ),
    )
    expect(consumed.has("instructions")).toBe(true)
    expect(consumed.has("disabled_providers")).toBe(true)
    expect(consumed.has("enabled_providers")).toBe(true)
    yield* Config.use.invalidate()

    const config = yield* Config.use.get()
    expect(config.instructions).toEqual(["docs/rules.md"])
    expect(config.disabled_providers).toEqual(["openai"])
    expect(config.enabled_providers).toEqual(["teststore"])
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
  withGlobalConfig({ config: { instructions: ["dup.md", "global-only.md"] } }, ({ dir }) =>
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
    yield* writeConfigEffect(test.directory, schemaConfig({ model: "project/model", username: "project-user" }))
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

const accountTokenIt = configIt({
  account: Layer.mock(Account.Service)({
    active: () =>
      Effect.succeed(
        Option.some({
          id: AccountID.make("account-1"),
          email: "user@example.com",
          url: "https://control.example.com",
          active_org_id: OrgID.make("org-1"),
        }),
      ),
    activeOrg: () =>
      Effect.succeed(
        Option.some({
          account: {
            id: AccountID.make("account-1"),
            email: "user@example.com",
            url: "https://control.example.com",
            active_org_id: OrgID.make("org-1"),
          },
          org: {
            id: OrgID.make("org-1"),
            name: "Example Org",
          },
        }),
      ),
    config: () =>
      Effect.succeed(
        Option.some({
          providers: { novaclaw: { request: { body: { apiKey: "{env:NOVACLAW_CONSOLE_TOKEN}" } } } },
        }),
      ),
    token: () => Effect.succeed(Option.some(AccessToken.make("st_test_token"))),
  }),
})

accountTokenIt.instance("resolves env templates in account config with account token", () =>
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(config.providers?.["novaclaw"]?.request?.body?.apiKey).toBe("st_test_token")
  }),
)

// ————— Remote well-known config (a live non-file source) —————

const storeOverridesRemote = wellKnown({
  config: {
    mcp: { servers: { jira: { type: "remote", url: "https://jira.example.com/mcp", disabled: true } } },
  },
})

storeOverridesRemote.it.instance("store settings override remote well-known config", () =>
  Effect.gen(function* () {
    // Merge order: remote well-known sources first, then the store document — instance-wide
    // store truth beats fleet-suggested defaults (the pre-step-9 project-file slot).
    yield* withStores(
      Effect.gen(function* () {
        const settings = yield* SettingsConfigStore.Service
        yield* settings.set("mcp", {
          servers: { jira: { type: "remote", url: "https://jira.example.com/mcp", disabled: false } },
        })
      }),
    )
    yield* Config.use.invalidate()
    const config = yield* Config.use.get()
    expect(storeOverridesRemote.seen.wellKnown).toBe("https://example.com/.well-known/novaclaw")
    expect(config.mcp?.servers?.jira?.disabled).toBe(false)
  }),
)

const trailingSlashWellKnown = wellKnown({
  authUrl: "https://example.com/",
  config: {
    mcp: { servers: { slack: { type: "remote", url: "https://slack.example.com/mcp", disabled: false } } },
  },
})

trailingSlashWellKnown.it.instance("wellknown URL with trailing slash is normalized", () =>
  Effect.gen(function* () {
    yield* Config.use.get()
    expect(trailingSlashWellKnown.seen.wellKnown).toBe("https://example.com/.well-known/novaclaw")
  }),
)

test("remote well-known config can use FetchHttpClient layer", async () => {
  let fetchedUrl: string | undefined
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      fetchedUrl = request.url
      return new Response(
        JSON.stringify({
          config: {
            mcp: { servers: { jira: { type: "remote", url: "https://jira.example.com/mcp", disabled: false } } },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    },
  })

  try {
    await provideTmpdirInstance(
      () =>
        Config.Service.use((svc) =>
          Effect.gen(function* () {
            const config = yield* svc.get()
            expect(fetchedUrl).toBe(`${server.url.origin}/.well-known/novaclaw`)
            expect(config.mcp?.servers?.jira?.disabled).toBe(false)
          }),
        ),
      { git: true },
    ).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          Config.layer.pipe(
            Layer.provide(testFlock),
            Layer.provide(FSUtil.defaultLayer),
            Layer.provide(Env.defaultLayer),
            Layer.provide(wellKnownAuth(server.url.origin)),
            Layer.provide(AccountTest.empty),
            Layer.provideMerge(infra),
            Layer.provide(NpmTest.noop),
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(AgentConfigStore.defaultLayer),
            Layer.provide(CatalogStore.defaultLayer),
            Layer.provide(CommandConfigStore.defaultLayer),
            Layer.provide(PluginConfigStore.defaultLayer),
            Layer.provide(ReferenceConfigStore.defaultLayer),
            Layer.provide(SettingsConfigStore.defaultLayer),
            Layer.provide(SkillConfigStore.defaultLayer),
          ),
          testInstanceStoreLayer,
        ),
      ),
      Effect.runPromise,
    )
  } finally {
    await server.stop(true)
  }
})

const templatedHeaderWellKnown = wellKnown({
  remoteConfig: {
    url: "https://config.example.com/novaclaw.json",
    headers: { Authorization: "Bearer {env:TEST_TOKEN}" },
  },
  remote: {
    mcp: { servers: { confluence: { type: "remote", url: "https://confluence.example.com/mcp", disabled: false } } },
  },
})

templatedHeaderWellKnown.it.instance("wellknown remote_config supports templated env vars in headers", () =>
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(templatedHeaderWellKnown.seen.wellKnown).toBe("https://example.com/.well-known/novaclaw")
    expect(templatedHeaderWellKnown.seen.remote).toBe("https://config.example.com/novaclaw.json")
    expect(templatedHeaderWellKnown.seen.authorization).toBe("Bearer test-token")
    expect(config.mcp?.servers?.confluence?.disabled).toBe(false)
  }),
)

const remotePrecedenceWellKnown = wellKnown({
  config: {
    mcp: { servers: { confluence: { type: "remote", url: "https://confluence.example.com/mcp", disabled: true } } },
  },
  remoteConfig: { url: "https://config.example.com/{env:TEST_TOKEN}/novaclaw.json" },
  remote: {
    config: {
      mcp: { servers: { confluence: { type: "remote", url: "https://confluence.example.com/mcp", disabled: false } } },
    },
  },
})

remotePrecedenceWellKnown.it.instance("wellknown remote_config url tokens and nested config override embedded config", () =>
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(remotePrecedenceWellKnown.seen.remote).toBe("https://config.example.com/test-token/novaclaw.json")
    expect(config.mcp?.servers?.confluence?.disabled).toBe(false)
  }),
)

const envIsolationWellKnown = wellKnown({
  remoteConfig: {
    url: "https://config.example.com/novaclaw.json",
    headers: { Authorization: "Bearer {env:TEST_TOKEN}" },
  },
  remote: {
    mcp: { servers: { confluence: { type: "remote", url: "https://confluence.example.com/mcp", disabled: false } } },
  },
})

envIsolationWellKnown.it.instance(
  "wellknown token env substitution does not mutate process env",
  () =>
    Effect.gen(function* () {
      process.env.TEST_TOKEN = "preexisting-token"
      yield* Config.use.get()
      expect(envIsolationWellKnown.seen.authorization).toBe("Bearer test-token")
      expect(process.env.TEST_TOKEN).toBe("preexisting-token")
    }),
  { git: true },
)

const nullConfigWellKnown = wellKnown({
  wellKnown: {
    config: null,
    remote_config: { url: "https://config.example.com/novaclaw.json" },
  },
  remote: {
    mcp: { servers: { confluence: { type: "remote", url: "https://confluence.example.com/mcp", disabled: false } } },
  },
})

nullConfigWellKnown.it.instance("wellknown config null is treated as absent", () =>
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(nullConfigWellKnown.seen.remote).toBe("https://config.example.com/novaclaw.json")
    expect(config.mcp?.servers?.confluence?.disabled).toBe(false)
  }),
)

const invalidRemoteWellKnown = wellKnown({
  remoteConfig: { url: "https://config.example.com/novaclaw.json" },
  remote: "not an object",
})

invalidRemoteWellKnown.it.instance("wellknown remote_config rejects non-object config responses", () =>
  Effect.gen(function* () {
    const exit = yield* Config.use.get().pipe(Effect.exit)
    expect(invalidRemoteWellKnown.seen.remote).toBe("https://config.example.com/novaclaw.json")
    expect(Exit.isFailure(exit)).toBe(true)
  }),
)

const loginPageWellKnown = wellKnown({
  remoteConfig: { url: "https://config.example.com/novaclaw.json" },
  remoteHtml: "<!DOCTYPE html><html><head><title>Sign in</title></head><body>Login required</body></html>",
})

loginPageWellKnown.it.instance(
  "wellknown remote_config surfaces an actionable auth error when the gateway returns an HTML login page",
  () =>
    Effect.gen(function* () {
      const exit = yield* Config.use.get().pipe(Effect.exit)
      expect(loginPageWellKnown.seen.remote).toBe("https://config.example.com/novaclaw.json")
      expect(Exit.isFailure(exit)).toBe(true)
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      expect(NamedError.hasName(error, "ConfigRemoteAuthError")).toBe(true)
      expect((error as { data?: { url?: string } }).data?.url).toBe("https://example.com")
    }),
)

// ————— Managed (MDM) settings — an admin-pushed FILE source that stays live —————

it.instance("managed settings override store settings", () =>
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
    expect(config.default_agent).toBe("managed-agent")
    expect(config.username).toBe("testuser")
  }),
)

it.instance("managed settings override store provider filters", () =>
  Effect.gen(function* () {
    yield* withStores(
      Effect.gen(function* () {
        const settings = yield* SettingsConfigStore.Service
        yield* settings.set("autoupdate", true)
        yield* settings.set("disabled_providers", [])
      }),
    )
    yield* Config.use.invalidate()
    yield* writeManagedSettingsEffect({
      $schema: "https://novaclaw.app/config.json",
      autoupdate: false,
      disabled_providers: ["openai"],
    })

    const config = yield* Config.use.get()
    expect(config.autoupdate).toBe(false)
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

// ————— D. D2 filesystem resources (markdown agents/commands, plugin dirs) —————

it.instance("loads markdown agents from .novaclaw/agent", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".novaclaw", "agent", "test.md"),
      `---
model: test/model
---
Test agent prompt`,
    )

    const config = yield* Config.use.get()
    expect(config.agents?.["test"]).toEqual(
      expect.objectContaining({
        model: "test/model",
        system: "Test agent prompt",
      }),
    )
  }),
)

it.instance("agent markdown permissions ruleset preserves author order", () =>
  Effect.gen(function* () {
    // Markdown agents author the canonical V2 ruleset (F1-config: no V1 dict shape remains);
    // rule order is precedence, so the parse must keep the author's order.
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".novaclaw", "agent", "ordered.md"),
      `---
permissions:
  - action: bash
    resource: "*"
    effect: allow
  - action: "*"
    resource: "*"
    effect: deny
  - action: edit
    resource: "*"
    effect: ask
---
Ordered permissions`,
    )

    const config = yield* Config.use.get()
    expect((config.agents?.["ordered"]?.permissions ?? []).map((rule) => rule.action)).toEqual(["bash", "*", "edit"])
  }),
)

it.instance("loads agents from .novaclaw/agents (plural)", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".novaclaw", "agents", "helper.md"),
      `---
model: test/model
mode: subagent
---
Helper agent prompt`,
    )

    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".novaclaw", "agents", "nested", "child.md"),
      `---
model: test/model
mode: subagent
---
Nested agent prompt`,
    )

    const config = yield* Config.use.get()

    expect(config.agents?.["helper"]).toMatchObject({
      model: "test/model",
      mode: "subagent",
      system: "Helper agent prompt",
    })

    expect(config.agents?.["nested/child"]).toMatchObject({
      model: "test/model",
      mode: "subagent",
      system: "Nested agent prompt",
    })
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
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".novaclaw", "agent", "helper.md"),
      `---
model: test/model
mode: subagent
---
Helper subagent prompt`,
    )

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

it.instance("merges store plugins with auto-discovered dir-walk plugins, origins aligned", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* withStores(
      Effect.gen(function* () {
        const plugins = yield* PluginConfigStore.Service
        yield* plugins.setPlugin({ package: "store-plugin@1.0.0", options: { source: "store" } })
      }),
    )
    yield* Config.use.invalidate()
    yield* FSUtil.use.writeWithDirs(path.join(test.directory, ".novaclaw", "plugin", "my-plugin.js"), "export default {}")

    const config = yield* Config.use.get()
    const names = (config.plugins ?? []).map((p) => (typeof p === "string" ? p : p.package))
    expect(names).toContain("store-plugin@1.0.0")
    expect(names.some((p) => p.startsWith("file://") && p.includes("my-plugin"))).toBe(true)
    // plugin_origins stays in the V1 Spec shape; the persisted `plugins` are its V2-entry
    // projection — aligned by identity. Store-borne plugins carry the instance-wide scope.
    const origins = config.plugin_origins ?? []
    expect(origins.map((item) => ConfigPlugin.pluginSpecifier(item.spec))).toEqual(names)
    expect(origins.find((item) => ConfigPlugin.pluginSpecifier(item.spec) === "store-plugin@1.0.0")?.scope).toBe(
      "global",
    )
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

  it.instance("NOVACLAW_CONFIG_DIR resources still load when flag is set", () =>
    Effect.gen(function* () {
      const configDir = yield* tmpdirScoped()
      yield* FSUtil.use.writeWithDirs(
        path.join(configDir, "agent", "dirwalk.md"),
        `---
model: test/model
---
Config-dir agent prompt`,
      )
      yield* withProcessEnvs(
        { NOVACLAW_DISABLE_PROJECT_CONFIG: "true", NOVACLAW_CONFIG_DIR: configDir },
        Effect.gen(function* () {
          const config = yield* Config.use.get()
          expect(config.agents?.["dirwalk"]).toMatchObject({ model: "test/model" })
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

describe("resolvePluginSpec", () => {
  test("keeps package specs unchanged", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "novaclaw.json")
    expect(await ConfigPlugin.resolvePluginSpec("oh-my-novaclaw@2.4.3", file)).toBe("oh-my-novaclaw@2.4.3")
    expect(await ConfigPlugin.resolvePluginSpec("@scope/pkg", file)).toBe("@scope/pkg")
  })

  test("resolves windows-style relative plugin directory specs", async () => {
    if (process.platform !== "win32") return

    await using tmp = await tmpdir({
      init: async (dir) => {
        const plugin = path.join(dir, "plugin")
        await fs.mkdir(plugin, { recursive: true })
        await Filesystem.write(path.join(plugin, "index.ts"), "export default {}")
      },
    })

    const file = path.join(tmp.path, "novaclaw.json")
    const hit = await ConfigPlugin.resolvePluginSpec(".\\plugin", file)
    expect(ConfigPlugin.pluginSpecifier(hit)).toBe(pathToFileURL(path.join(tmp.path, "plugin", "index.ts")).href)
  })

  test("resolves relative file plugin paths to file urls", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "plugin.ts"), "export default {}")
      },
    })

    const file = path.join(tmp.path, "novaclaw.json")
    const hit = await ConfigPlugin.resolvePluginSpec("./plugin.ts", file)
    expect(ConfigPlugin.pluginSpecifier(hit)).toBe(pathToFileURL(path.join(tmp.path, "plugin.ts")).href)
  })

  test("resolves plugin directory paths to directory urls", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const plugin = path.join(dir, "plugin")
        await fs.mkdir(plugin, { recursive: true })
        await Filesystem.writeJson(path.join(plugin, "package.json"), {
          name: "demo-plugin",
          type: "module",
          main: "./index.ts",
        })
        await Filesystem.write(path.join(plugin, "index.ts"), "export default {}")
      },
    })

    const file = path.join(tmp.path, "novaclaw.json")
    const hit = await ConfigPlugin.resolvePluginSpec("./plugin", file)
    expect(ConfigPlugin.pluginSpecifier(hit)).toBe(pathToFileURL(path.join(tmp.path, "plugin")).href)
  })

  test("resolves plugin directories without package.json to index.ts", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const plugin = path.join(dir, "plugin")
        await fs.mkdir(plugin, { recursive: true })
        await Filesystem.write(path.join(plugin, "index.ts"), "export default {}")
      },
    })

    const file = path.join(tmp.path, "novaclaw.json")
    const hit = await ConfigPlugin.resolvePluginSpec("./plugin", file)
    expect(ConfigPlugin.pluginSpecifier(hit)).toBe(pathToFileURL(path.join(tmp.path, "plugin", "index.ts")).href)
  })
})

describe("deduplicatePluginOrigins", () => {
  const dedupe = (plugins: ConfigPluginSpec.Spec[]) =>
    ConfigPlugin.deduplicatePluginOrigins(
      plugins.map((spec) => ({
        spec,
        source: "",
        scope: "global" as const,
      })),
    ).map((item) => item.spec)

  test("removes duplicates keeping higher priority (later entries)", () => {
    const plugins = ["global-plugin@1.0.0", "shared-plugin@1.0.0", "local-plugin@2.0.0", "shared-plugin@2.0.0"]

    const result = dedupe(plugins)

    expect(result).toContain("global-plugin@1.0.0")
    expect(result).toContain("local-plugin@2.0.0")
    expect(result).toContain("shared-plugin@2.0.0")
    expect(result).not.toContain("shared-plugin@1.0.0")
    expect(result.length).toBe(3)
  })

  test("keeps path plugins separate from package plugins", () => {
    const plugins = ["oh-my-novaclaw@2.4.3", "file:///project/.novaclaw/plugin/oh-my-novaclaw.js"]

    const result = dedupe(plugins)

    expect(result).toEqual(plugins)
  })

  test("deduplicates direct path plugins by exact spec", () => {
    const plugins = ["file:///project/.novaclaw/plugin/demo.ts", "file:///project/.novaclaw/plugin/demo.ts"]

    const result = dedupe(plugins)

    expect(result).toEqual(["file:///project/.novaclaw/plugin/demo.ts"])
  })

  test("preserves order of remaining plugins", () => {
    const plugins = ["a-plugin@1.0.0", "b-plugin@1.0.0", "c-plugin@1.0.0"]

    const result = dedupe(plugins)

    expect(result).toEqual(["a-plugin@1.0.0", "b-plugin@1.0.0", "c-plugin@1.0.0"])
  })
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
          autoupdate: true,
        }),
      ),
      "test:mobileconfig",
    ),
    "test:mobileconfig",
  )
  expect(config.server?.hostname).toBe("127.0.0.1")
  expect(config.server?.mdns).toBe(false)
  expect(config.autoupdate).toBe(true)
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

test("parseManagedPlist parses enabled_providers", async () => {
  const config = ConfigParse.schema(
    ConfigV2.Info,
    ConfigParse.jsonc(
      await ConfigManaged.parseManagedPlist(
        JSON.stringify({
          $schema: "https://novaclaw.app/config.json",
          enabled_providers: ["anthropic", "google"],
        }),
      ),
      "test:mobileconfig",
    ),
    "test:mobileconfig",
  )
  expect(config.enabled_providers).toEqual(["anthropic", "google"])
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
