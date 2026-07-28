import { $ } from "bun"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect, Context, Layer, Schema, Scope } from "effect"
import { sql } from "drizzle-orm"
import type * as PlatformError from "effect/PlatformError"
import { CrossSpawnSpawner } from "@novaclaw/core/cross-spawn-spawner"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Config as ConfigV2 } from "@novaclaw/core/config"
import { ConfigStoreWrite } from "@novaclaw/core/config-store-write"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { CatalogStore } from "@novaclaw/core/catalog-store"
import { CommandConfigStore } from "@novaclaw/core/command-config-store"
import { PluginConfigStore } from "@novaclaw/core/plugin-config-store"
import { ReferenceConfigStore } from "@novaclaw/core/reference-config-store"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { SkillConfigStore } from "@novaclaw/core/skill-config-store"
import { SettingsConfigSeed } from "@novaclaw/core/settings-config-seed"
import { Database } from "@novaclaw/core/database/database"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { memoMap } from "@novaclaw/core/effect/memo-map"
import { Config } from "@/config/config"
import { InstanceRef } from "../../src/effect/instance-ref"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import type { InstanceContext } from "../../src/project/instance-context"
import { InstanceRuntime } from "../../src/project/instance-runtime"
import { InstanceStore } from "../../src/project/instance-store"
import { TestLLMServer } from "../lib/llm-server"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
export const testInstanceStoreLayer = InstanceStore.defaultLayer.pipe(Layer.provide(noopBootstrap))

export async function provideTestInstance<R>(input: {
  directory: string
  init?: Effect.Effect<void>
  fn: (ctx: InstanceContext) => R
}) {
  const ctx = await InstanceRuntime.load({ directory: input.directory })
  try {
    if (input.init) await Effect.runPromise(input.init.pipe(Effect.provideService(InstanceRef, ctx)))
    return await input.fn(ctx)
  } finally {
    await InstanceRuntime.disposeInstance(ctx)
  }
}

export async function withTestInstance<R>(input: { directory: string; fn: (ctx: InstanceContext) => R }) {
  return input.fn(await InstanceRuntime.load({ directory: input.directory }))
}

export async function reloadTestInstance(input: { directory: string }) {
  return InstanceRuntime.reloadInstance(input)
}

export async function disposeAllInstances() {
  await InstanceRuntime.disposeAllInstances()
}

// Strip null bytes from paths (defensive fix for CI environment issues)
function sanitizePath(p: string): string {
  return p.replace(/\0/g, "")
}

function exists(dir: string) {
  return fs
    .stat(dir)
    .then(() => true)
    .catch(() => false)
}

function clean(dir: string) {
  return fs.rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  })
}

async function stop(dir: string) {
  if (!(await exists(dir))) return
  await $`git fsmonitor--daemon stop`.cwd(dir).quiet().nothrow()
}

// ─── the `config` fixture option ────────────────────────────────────────────────────────────────
//
// `config` used to be written as a `novaclaw.json` file into the tmpdir the test runs in, and the
// first-boot seed read the LAUNCH DIRECTORY, so it was picked up. `5212c03ae` deleted that leg —
// deliberately: seeding is `isEmpty`-gated and one-time, so whichever process booted first silently
// defined instance-wide settings forever, and "a config file at a project root" is an opencode-legacy
// pattern (config is instance-level; see AGENTS.md §Config). The file write survived the commit and
// became a no-op — the option looked like it worked while every value it carried was discarded.
//
// So BOTH flavours now write the document THROUGH THE CONFIG STORES, the same route the HTTP
// `PATCH /config` handler takes (`ConfigStoreWrite.apply`, which fans each top-level `Config.Info`
// key out to its owning SQLite store inside one transaction). `tmpdirScoped` (and therefore
// `it.instance`) provisions against the AMBIENT memo map; the async `tmpdir()` provisions against
// the SHARED one and has a second obligation on top — see the block above `TmpDirOptions`.
// Two consequences worth knowing:
//   · it is instance-WIDE, not per-directory — which is what config now means;
//   · an invalid config literal THROWS at decode instead of being silently dropped, which is the
//     point: a fixture that eats its own input is how this defect survived a commit.
//
// ⚠️ Writing it to the XDG config dir as a jsonc instead is NOT an option: `test/preload.ts` gives
// one XDG home per PID, shared by every test in the process, and the seed that would read it is
// `isEmpty`-gated and one-time — the first test to seed would win for the whole file.
const configStores = LayerNode.compile(
  LayerNode.group([
    Database.node,
    AgentConfigStore.node,
    CatalogStore.node,
    CommandConfigStore.node,
    PluginConfigStore.node,
    ReferenceConfigStore.node,
    SettingsConfigStore.node,
    SkillConfigStore.node,
  ]),
)

/** Decode the literal a test wrote and route it into the stores. Throws on an invalid literal. */
const applyConfig = (config: Partial<Config.Info>) =>
  ConfigStoreWrite.apply(Schema.decodeUnknownSync(ConfigV2.Info)(config))

/**
 * Effect flavour: build the store layers in the AMBIENT memo map.
 *
 * The layer objects here are the app's own `*.node` implementations, and a nested `Effect.provide`
 * resolves them through the memo map the surrounding `Effect.provide(testLayer)` already installed —
 * so this writes into the very `Database.Service` the Config service under test reads. That identity
 * is load-bearing rather than incidental: `test/preload.ts` sets `NOVACLAW_DB=":memory:"`, and every
 * *distinct* layer build of `:memory:` is a separate, private database (verified directly — a second
 * top-level build reports `isEmpty === true` after the first has written).
 */
const applyConfigScoped = (config: Partial<Config.Info>) =>
  applyConfig(config).pipe(Effect.provide(configStores))

/**
 * Async flavour: build the store layers AND the Config service in the SHARED memo map.
 *
 * `tmpdir()`'s `config` callers are the in-process HTTP-server suites (`test/server/**`: `formatter`
 * 23×, plus `username`/`instructions` in the compression suite and one `references`). Their handler
 * context is built by `HttpApiApp.webHandler` through the SHARED memo map
 * (`@novaclaw/core/effect/memo-map`), so provisioning has to reach THAT graph. Three properties of
 * the code below are load-bearing rather than incidental:
 *
 *  · IDENTITY — these are the app's own `*.node` implementations and Effect's memo map keys on layer
 *    identity, so building them through `memoMap` resolves the very `Database.Service` and
 *    `Config.Service` the server under test uses. (`test/preload.ts` sets `NOVACLAW_DB=":memory:"`,
 *    where every *distinct* layer build is a separate, private database.)
 *  · the scope is NEVER CLOSED — the first `tmpdir()` call precedes `Server.Default()`, so releasing
 *    it would finalize the very database the server is about to memoize.
 *  · the store write ALONE CHANGES NOTHING the server serves. `Config`'s global view is
 *    `Effect.cachedInvalidateWithTTL(…, Duration.infinity)` (`src/config/config.ts`) and nothing on
 *    the request path refreshes it, so without the `invalidate()` below the server keeps answering
 *    with whatever the FIRST config-carrying test in the process provisioned, however clean the
 *    store is. That is measured, not theorised: the test it breaks passes when run alone.
 */
const serverStores = LayerNode.compile(
  LayerNode.group([
    Database.node,
    AgentConfigStore.node,
    CatalogStore.node,
    CommandConfigStore.node,
    PluginConfigStore.node,
    ReferenceConfigStore.node,
    SettingsConfigStore.node,
    SkillConfigStore.node,
    Config.node,
  ]),
)

type ServerServices = Layer.Success<typeof serverStores>
let serverServices: Promise<Context.Context<ServerServices>> | undefined

/** Run one effect against the SERVER's memoized stores + Config service. */
function onServer<A, E>(effect: Effect.Effect<A, E, ServerServices>) {
  serverServices ??= Effect.runPromise(Layer.buildWithMemoMap(serverStores, memoMap, Scope.makeUnsafe()))
  return serverServices.then((context) => Effect.runPromise(effect.pipe(Effect.provide(context))))
}

/**
 * The stores are PROCESS-WIDE — they outlive every test, and `resetDatabase()` deliberately does not
 * clear the config ones (see `sweepDataPlane`: the settings seed runs from a startup node, so a
 * truncate would leave nothing to re-seed them, and this bookkeeping already owns the concern).
 * `ConfigStoreWrite.apply`
 * patch-MERGES (`settings.set(key, mergePatch(current[key], value))`), so a provision has to be
 * UNDO-then-apply or each test inherits its predecessor's document: the compression suite's bare
 * `{ formatter: false }` test would still be served the previous test's `username` and 50
 * `instructions`, putting the response over the 1024-byte threshold it asserts it is under.
 *
 * The undo runs on DISPOSE as well, so a test passing no `config` at all also starts clean. Like
 * `tmpdirScoped` this is instance-WIDE rather than per-directory — which is what config now means,
 * so two live `tmpdir({ config })` handles share one document (last write wins).
 */
const provisioned = { settings: new Set<string>(), references: new Set<string>() }

const SETTINGS_KEYS: ReadonlySet<string> = new Set(SettingsConfigSeed.SETTINGS_KEYS)

/**
 * Where each top-level key lands, so the undo can reach it again. A key with no route here THROWS
 * instead of being written: a write this fixture cannot take back does not fail the test that made
 * it, it fails an unrelated test in a later file — which is exactly how the defect above survived a
 * commit. Extend `clearProvisioned` first, then this.
 */
function routeConfig(config: Partial<Config.Info>) {
  const settings: string[] = []
  const references: string[] = []
  for (const key of Object.keys(config)) {
    if (key === "$schema") continue
    if (SETTINGS_KEYS.has(key)) settings.push(key)
    else if (key === "references") references.push(...Object.keys(config.references ?? {}))
    else
      throw new Error(
        `tmpdir({ config }): "${key}" routes to a store this fixture cannot undo between tests — ` +
          `teach clearProvisioned() to remove it before using it here.`,
      )
  }
  return { settings, references }
}

/**
 * Tables the sweep must NEVER delete from, each for a different reason.
 *
 * ⚠️ `migration` is the migration journal: deleting a row REPLAYS that migration on the next boot,
 * which for most means `CREATE TABLE` on an object that already exists → throw inside `applyOnly` →
 * `Effect.orDie` → boot death. (`DbRegistry` refuses writes to it for exactly this reason.)
 *
 * The config stores are excluded on a different ground: `SettingsConfigSeed` runs from
 * `config-seed-startup.ts`, a STARTUP node, not from the store layer — so a truncate here would wipe
 * seeded settings with nothing in the request path to re-seed them. Config isolation is already
 * owned, correctly, by `provisioned` + `clearProvisioned` below (undo-then-apply + `invalidate()`),
 * and two mechanisms racing for one concern is how the original defect survived. So the split is
 * deliberate and total: **this sweep owns the session/runtime data plane, `clearProvisioned` owns the
 * config plane.**
 */
const PRESERVED_TABLES: ReadonlySet<string> = new Set([
  "migration",
  "data_migration",
  // the config plane — see above
  "runtime_setting",
  "catalog_provider",
  "catalog_setting",
  "agent_config",
  "agent_setting",
  "command_config",
  "reference_config",
  "plugin_config",
  "skill_config",
  "instance_identity",
])

/** `sqlite_*` is SQLite's own bookkeeping; `kb_chunk_vec*` are a vec0 virtual table's shadow tables,
 *  which must be mutated through the virtual table or not at all. */
const PRESERVED_PREFIXES = ["sqlite_", "kb_chunk_vec"]

const isPreserved = (table: string) =>
  PRESERVED_TABLES.has(table) || PRESERVED_PREFIXES.some((prefix) => table.startsWith(prefix))

/**
 * Clear the session/runtime data plane in the database the server under test actually uses.
 *
 * The table list is read from `sqlite_master` AT RUNTIME rather than hardcoded. That is not
 * incidental: a hand-maintained list of 40-odd tables is precisely the mirror-that-drifts defect this
 * fixture already carries scars from — a table added later would silently stop being reset, and
 * nothing would fail. The denylist above is small, and `db.test.ts` asserts every name in it still
 * exists, so a rename fails loudly instead of quietly preserving nothing.
 *
 * Runs through `onServer()`, so it reaches the memoized `Database.Service` behind the shared memo map
 * — under `:memory:` every distinct layer build is a private database, so any other route would clear
 * a database no one is reading.
 */
export const sweepDataPlane = () =>
  onServer(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const rows = (yield* db
        .all(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
        .pipe(Effect.orDie)) as { name: string }[]

      const cleared: string[] = []
      const skipped: string[] = []
      for (const { name } of rows) {
        if (isPreserved(name)) continue
        // ⚠️ One undeletable table must NOT take the whole reset down — the same lesson
        // `DbRegistry.tables` learned the hard way: a dev DB can still carry `kb_chunk_vec`, a
        // sqlite-vec VIRTUAL table created lazily by the retired KB-V store and present in no
        // migration, and once the extension stops loading every statement against it throws
        // `no such module: vec0`. A reset that dies there would leave the database half-cleared and
        // the failure attributed to whichever test ran next.
        const ok = yield* db.run(sql`DELETE FROM ${sql.identifier(name)}`).pipe(
          Effect.as(true),
          Effect.catchCause(() => Effect.succeed(false)),
        )
        ;(ok ? cleared : skipped).push(name)
      }

      // The config plane is untouched above, so `provisioned` stays accurate by construction — but a
      // reset still means "no test's config is in force", which is what `clearProvisioned` expresses.
      yield* clearProvisioned
      yield* Config.use.invalidate()
      return { cleared, skipped }
    }),
  )

const clearProvisioned = Effect.gen(function* () {
  if (provisioned.settings.size > 0) {
    const settings = yield* SettingsConfigStore.Service
    for (const key of provisioned.settings) yield* settings.remove(key)
    provisioned.settings.clear()
  }
  if (provisioned.references.size > 0) {
    const references = yield* ReferenceConfigStore.Service
    for (const name of provisioned.references) yield* references.removeReference(name)
    provisioned.references.clear()
  }
})

/** Undo the previous provision, write this one, and make the server's Config service see it. */
async function provisionConfig(config: Partial<Config.Info>) {
  const routed = routeConfig(config)
  // Decode BEFORE anything is cleared, so an invalid literal throws without disturbing the stores.
  const write = applyConfig(config)
  await onServer(
    Effect.gen(function* () {
      yield* clearProvisioned
      yield* write
      yield* Config.use.invalidate()
    }),
  )
  for (const key of routed.settings) provisioned.settings.add(key)
  for (const name of routed.references) provisioned.references.add(name)
}

/** Take the document back out when the directory goes away. */
function releaseConfig() {
  if (provisioned.settings.size === 0 && provisioned.references.size === 0) return Promise.resolve()
  return onServer(
    Effect.gen(function* () {
      yield* clearProvisioned
      yield* Config.use.invalidate()
    }),
  )
}

type TmpDirOptions<T> = {
  git?: boolean
  config?: Partial<Config.Info>
  init?: (dir: string) => Promise<T>
  dispose?: (dir: string) => Promise<T>
}
export async function tmpdir<T>(options?: TmpDirOptions<T>) {
  const dirpath = sanitizePath(path.join(os.tmpdir(), "novaclaw-test-" + Math.random().toString(36).slice(2)))
  await fs.mkdir(dirpath, { recursive: true })
  if (options?.git) {
    await $`git init`.cwd(dirpath).quiet()
    await $`git config core.fsmonitor false`.cwd(dirpath).quiet()
    await $`git config commit.gpgsign false`.cwd(dirpath).quiet()
    await $`git config user.email "test@novaclaw.test"`.cwd(dirpath).quiet()
    await $`git config user.name "Test"`.cwd(dirpath).quiet()
    await $`git commit --allow-empty -m "root commit ${dirpath}"`.cwd(dirpath).quiet()
  }
  if (options?.config) await provisionConfig(options.config)
  const realpath = sanitizePath(await fs.realpath(dirpath))
  const extra = await options?.init?.(realpath)
  const result = {
    [Symbol.asyncDispose]: async () => {
      try {
        await options?.dispose?.(realpath)
      } finally {
        // Swallowed like its neighbours so a teardown fault never masks the test's own failure —
        // the undo at the head of the next `provisionConfig` is the backstop if this one loses.
        if (options?.config) await releaseConfig().catch(() => undefined)
        if (options?.git) await stop(realpath).catch(() => undefined)
        await clean(realpath).catch(() => undefined)
      }
    },
    path: realpath,
    extra: extra as T,
  }
  return result
}

/** Effectful scoped tmpdir. Cleaned up when the scope closes. Make sure these stay in sync */
export function tmpdirScoped<E = never, R = never>(options?: {
  git?: boolean
  config?: Partial<Config.Info> | (() => Partial<Config.Info>)
  init?: (directory: string) => Effect.Effect<void, E, R>
}) {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const dirpath = sanitizePath(path.join(os.tmpdir(), "novaclaw-test-" + Math.random().toString(36).slice(2)))
    yield* Effect.promise(() => fs.mkdir(dirpath, { recursive: true }))
    const dir = sanitizePath(yield* Effect.promise(() => fs.realpath(dirpath)))

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        if (options?.git) await stop(dir).catch(() => undefined)
        await clean(dir).catch(() => undefined)
      }),
    )

    const git = (...args: string[]) =>
      spawner.spawn(ChildProcess.make("git", args, { cwd: dir })).pipe(Effect.flatMap((handle) => handle.exitCode))

    if (options?.git) {
      yield* git("init")
      yield* git("config", "core.fsmonitor", "false")
      yield* git("config", "commit.gpgsign", "false")
      yield* git("config", "user.email", "test@novaclaw.test")
      yield* git("config", "user.name", "Test")
      yield* git("commit", "--allow-empty", "-m", `root commit ${dir}`)
    }

    if (options?.config) {
      const resolved = typeof options.config === "function" ? options.config() : options.config
      yield* applyConfigScoped(resolved)
    }

    if (options?.init) yield* options.init(dir)

    return dir
  })
}

export const provideInstance =
  (directory: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R | InstanceStore.Service> =>
    InstanceStore.Service.use((store) => store.provide({ directory }, self))

export const provideInstanceEffect =
  (directory: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R | InstanceStore.Service> =>
    InstanceStore.Service.use((store) => store.provide({ directory }, self))

export const reloadInstance = (input: InstanceStore.LoadInput) =>
  InstanceStore.Service.use((store) => store.reload(input))

export const disposeAllInstancesEffect = InstanceStore.Service.use((store) => store.disposeAll())

export function provideTmpdirInstance<A, E, R>(
  self: (path: string) => Effect.Effect<A, E, R>,
  options?: { git?: boolean; config?: Partial<Config.Info> | (() => Partial<Config.Info>) },
) {
  return Effect.gen(function* () {
    const path = yield* tmpdirScoped(options)
    return yield* self(path).pipe(provideInstance(path))
  }).pipe(Effect.provide(testInstanceStoreLayer))
}

export class TestInstance extends Context.Service<TestInstance, { readonly directory: string }>()("@test/Instance") {}

export const requireInstance = Effect.gen(function* () {
  const instance = yield* InstanceRef
  if (!instance) return yield* Effect.die(new Error("missing test instance"))
  return instance
})

export const withTmpdirInstance =
  <E2 = never, R2 = never>(options?: {
    git?: boolean
    config?: Partial<Config.Info> | (() => Partial<Config.Info>)
    init?: (directory: string) => Effect.Effect<void, E2, R2>
  }) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped(options)
      return yield* self.pipe(Effect.provideService(TestInstance, { directory }), provideInstanceEffect(directory))
    }).pipe(Effect.provide(testInstanceStoreLayer), Effect.provide(CrossSpawnSpawner.defaultLayer))

export function provideTmpdirServer<A, E, R>(
  self: (input: { dir: string; llm: TestLLMServer["Service"] }) => Effect.Effect<A, E, R>,
  options?: { git?: boolean; config?: (url: string) => Partial<Config.Info> },
): Effect.Effect<
  A,
  E | PlatformError.PlatformError,
  R | TestLLMServer | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  return Effect.gen(function* () {
    const llm = yield* TestLLMServer
    return yield* provideTmpdirInstance((dir) => self({ dir, llm }), {
      git: options?.git,
      config: options?.config?.(llm.url),
    })
  })
}
