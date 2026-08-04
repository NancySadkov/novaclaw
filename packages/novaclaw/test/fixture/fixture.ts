import { $ } from "bun"
import { execFile } from "child_process"
import * as fs from "fs/promises"
import fsSync from "fs"
import os from "os"
import path from "path"
import { promisify } from "util"

import { Effect, Context, Layer, Schema, Scope } from "effect"
import { sql } from "drizzle-orm"
import type * as PlatformError from "effect/PlatformError"
import { CrossSpawnSpawner } from "@novaclaw/core/cross-spawn-spawner"
import type { ChildProcessSpawner } from "effect/unstable/process"
import { Config as ConfigV2 } from "@novaclaw/core/config"
import { ConfigStoreWrite } from "@novaclaw/core/config-store-write"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { CatalogSeed } from "@novaclaw/core/catalog-seed"
import { CatalogStore } from "@novaclaw/core/catalog-store"
import { CommandConfigStore } from "@novaclaw/core/command-config-store"
import { PluginConfigStore } from "@novaclaw/core/plugin-config-store"
import { ReferenceConfigStore } from "@novaclaw/core/reference-config-store"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { SkillConfigStore } from "@novaclaw/core/skill-config-store"
import { SettingsConfigSeed } from "@novaclaw/core/settings-config-seed"
import { ProviderV2 } from "@novaclaw/core/provider"
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

// ─── the git fixture: ONE implementation, built once per process and COPIED per call ────────────
//
// ⚠️ **`git: true` used to spawn eight git processes per CALL**, written out twice — once with
// `bun $` in `tmpdir()` and once through `ChildProcessSpawner` in `tmpdirScoped()`, under a comment
// asking the next person to keep them in sync.
//
// Measured 2026-07-28 on this box (loaded, four agents) over
// `httpapi-workspace` + `httpapi-workspace-routing` + `httpapi-instance-context` — 23 `git: true`
// call sites. `GIT_TRACE` (which counts EVERY git process, including the ones git starts itself)
// says the whole run went **405 → 235** git processes; the fixture's own share went **184 → 31**:
//
//     init 23 → 1 · config 92 → 6 · commit 23 → 23 · maintenance 23 → 0 · fsmonitor--daemon 23 → 0
//
// In wall clock, phase timers put the old ritual at **10.4 s of setup + 1.7 s of teardown inside a
// 38.2 s run** (~32% of those three files), and an INTERLEAVED A/B — old, new, old, new, five
// rounds, because this box swings ±30% between identical runs — measured a median **32.0 s → 25.8 s**
// for the same 26 tests and the same 3 (pinned) failures. Component costs: `fs.cp` of the finished
// 20-file template **56 ms**, against **360–386 ms** for the six-process ritual.
//
// So the ritual is paid ONCE per process into a template directory, and every call gets an
// `fs.cp` copy of it. The two entry points now share this one function, which is what makes
// "keep these in sync" stop being a claim about code somewhere else (todo.md ruling 1).
//
// ⚠️ What this does NOT fix, so nobody re-derives it: the 235 that remain are almost entirely the
// APP — `rev-parse` 111, `remote` 43, `rev-list` 37 — i.e. `Project.resolve` re-discovering a
// repository per request. `InstanceStore` memoizes by resolved directory, but every test uses a
// fresh random tmpdir, so that cache never hits. That is a src-side lever, not a fixture one.
//
// ⚠️ **The template deliberately stops SHORT of the root commit, and that is the one place this
// fixture must not copy `packages/core/test/fixture/git.ts`.** `Project.resolve`
// (`core/src/project.ts:96`) identifies a repository with no remote by its **root-commit SHA**
// (`Git.history.rootCommits` → `rev-list --max-parents=0 HEAD`). Hoisting the commit into the
// template would give every fixture directory in the process ONE project id — reuse of an
// identity, not reuse of scenery. So each copy makes its own root commit, whose message carries
// the directory path, which is exactly what the old ritual did for a reason nothing in the tree
// stated. (`test/effect/instance-state.test.ts:22` re-amends that commit with the same message,
// which reads like someone hitting this once already.)
//
// ⚠️ Be honest about the evidence: hoisting the commit into the template was TRIED on 2026-07-28
// over six suites (`httpapi-workspace`, `httpapi-workspace-routing`, `httpapi-instance-context`,
// `httpapi-instance`, `project-copy`, `worktree-endpoint-repro`) and **no test changed state** —
// so no suite today is known to depend on it. The uniqueness is kept on the source-code reading
// above rather than on a red test, and `fixture.test.ts` pins it directly so the property is
// mechanically checked instead of merely intended. It costs ONE git process per call.
//
// A hand-rolled `git init` anywhere under `packages/novaclaw/test/` is caught by
// `git-fixture-ledger.test.ts`, a shrink-only ratchet.

const execFileAsync = promisify(execFile)

/** One git process. `execFile` rather than `bun $`: no shell to parse, and measurably cheaper. */
const gitExec = async (cwd: string, ...args: string[]) => {
  await execFileAsync("git", args, { cwd })
}

/** Where the template lives for the lifetime of this test process. Named by PID — see `templateRoot()`. */
const TEMPLATE_PREFIX = "novaclaw-test-git-template-"
let templateHome: string | undefined
let gitTemplate: Promise<string> | undefined

function templateRoot(): string {
  if (templateHome !== undefined) return templateHome
  // ⚠️ **`bun test` does NOT run `process.on("exit")` handlers** (bun 1.3.14, measured 2026-07-28
  // in `packages/core/test/fixture/git.ts`: 15 template roots had piled up in %TEMP% before it was
  // caught). So teardown cannot be an exit hook. The root is named by PID and every run reaps the
  // roots whose owner is gone — which bounds %TEMP% at one directory per LIVE test process and
  // heals whatever an earlier crash left behind (AGENTS.md pitfall #8).
  reapAbandonedTemplateRoots()
  const root = path.join(os.tmpdir(), `${TEMPLATE_PREFIX}${process.pid}`)
  fsSync.rmSync(root, { recursive: true, force: true })
  fsSync.mkdirSync(root, { recursive: true })
  templateHome = root
  // Best-effort fast path: a no-op under `bun test`, correct everywhere else.
  process.on("exit", () => {
    try {
      fsSync.rmSync(root, { recursive: true, force: true })
    } catch {
      // A teardown failure must never turn a green suite red — the reap above is the real mechanism.
    }
  })
  return root
}

/**
 * Delete template roots whose owning process is gone.
 *
 * Keyed on PID, never on age: `script/test.ts` runs units in their own processes, and an age-based
 * sweep would eventually delete a CONCURRENT run's template out from under it — trading a leaked
 * directory for a flaky suite. `process.kill(pid, 0)` is the liveness probe (no throw for a live
 * pid, `ESRCH` for a dead one). A recycled PID just means one stale root survives a run longer.
 */
function reapAbandonedTemplateRoots() {
  let entries: string[]
  try {
    entries = fsSync.readdirSync(os.tmpdir())
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.startsWith(TEMPLATE_PREFIX)) continue
    const pid = Number(entry.slice(TEMPLATE_PREFIX.length))
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue
    try {
      process.kill(pid, 0)
      continue // still running — not ours to delete
    } catch (error) {
      // ESRCH means gone. EPERM means alive under another account: leave it alone.
      if ((error as { code?: string } | undefined)?.code === "EPERM") continue
    }
    try {
      fsSync.rmSync(path.join(os.tmpdir(), entry), { recursive: true, force: true })
    } catch {
      // Another process may be reaping the same root; losing the race is fine.
    }
  }
}

/**
 * `git init` + the identity/determinism config — seven git processes, paid ONCE per process.
 *
 * Deliberately stops SHORT of the root commit: see the identity note above. The promise itself is
 * memoized, so concurrent first callers share one build rather than racing to write the same tree.
 *
 * Exported for `fixture.test.ts` only — the memo and the missing root commit are the two properties
 * that make this fixture both fast and safe, and neither is observable from the outside otherwise.
 */
export function gitTemplateDir() {
  gitTemplate ??= (async () => {
    const directory = path.join(templateRoot(), "repo")
    await fs.mkdir(directory, { recursive: true })
    await gitExec(directory, "init")
    await gitExec(directory, "config", "core.fsmonitor", "false")
    await gitExec(directory, "config", "commit.gpgsign", "false")
    // ⚠️ Measured with `GIT_TRACE` on 2026-07-28: every `git commit` in a fresh repo spawned a
    // SECOND process, `git maintenance run --auto` — 23 of them across the three suites profiled
    // above, i.e. the per-copy identity commit cost two processes rather than one. Housekeeping a
    // repository that lives for one test and is then deleted is pure waste. (`gc.auto` is set too:
    // it is the pre-2.30 spelling, and a fixture should not depend on the reader's git version.)
    await gitExec(directory, "config", "maintenance.auto", "false")
    await gitExec(directory, "config", "gc.auto", "0")
    await gitExec(directory, "config", "user.email", "test@novaclaw.test")
    await gitExec(directory, "config", "user.name", "Test")
    return directory
  })()
  return gitTemplate
}

/**
 * **THE git provisioning path.** Both `tmpdir()` and `tmpdirScoped()` call this and nothing else.
 *
 * ⚠️ `preserveTimestamps` is not cosmetic — `.git/index` caches each file's mtime and size, so a
 * plain copy makes git treat the whole worktree as stat-dirty and re-hash it.
 */
async function provisionGit(dir: string) {
  await fs.cp(await gitTemplateDir(), dir, { recursive: true, preserveTimestamps: true })
  // The ONE per-call git process, and the one that gives this repository its own identity.
  await gitExec(dir, "commit", "--allow-empty", "-m", `root commit ${dir}`)
}

/**
 * The teardown counterpart — and it is now a no-op by construction, which is the point.
 *
 * ⚠️ It used to be an unconditional `git fsmonitor--daemon stop` per disposal: 23 processes and
 * **1.7 s** across the three files measured above. It could never have found a daemon. Git starts
 * one only where `core.fsmonitor` is truthy, the template sets it to `false` and every copy
 * inherits that (`fixture.test.ts` asserts it), and a `stop` run at the tmpdir ROOT resolves to the
 * fixture's own repository — never to some nested repo a test created. So the call was addressing
 * exactly the repository that provably cannot have a daemon.
 *
 * Kept as a guarded call rather than deleted, because the premise is about THIS machine's git
 * config: if a developer's global/system config turns fsmonitor on, a repo created by the code
 * under test (not by this fixture) could still start one. The probe is one git process per test
 * PROCESS instead of one per disposal.
 */
let fsmonitorEnabledGlobally: Promise<boolean> | undefined
function fsmonitorCouldRun() {
  fsmonitorEnabledGlobally ??= execFileAsync("git", ["config", "--get", "core.fsmonitor"], { cwd: os.tmpdir() })
    .then(({ stdout }) => stdout.trim() !== "" && stdout.trim() !== "false")
    .catch(() => false) // exit 1 = unset, which is git's default and means "no daemon"
  return fsmonitorEnabledGlobally
}

async function stop(dir: string) {
  if (!(await fsmonitorCouldRun())) return
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
const applyConfigScoped = (config: Partial<Config.Info>) => applyConfig(config).pipe(Effect.provide(configStores))

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
 * What one provisioned document put where, so the undo can reach it again.
 *
 * Every field pairs with exactly one arm of `clearProvisioned`, and `provisioned` below is derived
 * from this type — so a new destination cannot be added to the router without the ledger growing a
 * slot for it. That linkage is the point: the failure this whole mechanism guards against is a
 * write recorded on one side and forgotten on the other (todo.md ruling 1 — an invariant whose
 * violation compiles green ships with a mechanical check or it does not exist).
 */
type Routed = {
  /** `SettingsConfigStore` keys (`SETTINGS_KEYS`). */
  settings: string[]
  /** `ReferenceConfigStore` alias names. */
  references: string[]
  /** `CatalogStore` provider ids — from `providers`, and from what `models` expands into. */
  providers: string[]
  /** `AgentConfigStore` agent names. */
  agents: string[]
  /** `CommandConfigStore` command names. */
  commands: string[]
  /**
   * The two SINGLETON default refs, each a single row its store deletes with `clearDefault()`:
   * `model` (CatalogStore) and `default_agent` (AgentConfigStore).
   */
  defaults: ("model" | "default_agent")[]
}

/**
 * The stores are PROCESS-WIDE — they outlive every test, and `resetDatabase()` deliberately does not
 * clear the config ones (see `sweepDataPlane`: the settings seed runs from a startup node, so a
 * truncate would leave nothing to re-seed them, and this bookkeeping already owns the concern).
 * `ConfigStoreWrite.apply` never overwrites, it MERGES — settings keys patch-merge
 * (`settings.set(key, mergePatch(current[key], value))`) and the layered stores fold the incoming
 * fragment onto the stored layers (`collapseLayers`) — so a provision has to be UNDO-then-apply or
 * each test inherits its predecessor's document: the compression suite's bare `{ formatter: false }`
 * test would still be served the previous test's `username` and 50 `instructions`, putting the
 * response over the 1024-byte threshold it asserts it is under. For a provider the same shape is
 * worse than stale bytes — the previous test's `api.url` survives the fold, so a later test points
 * at an endpoint it never configured.
 *
 * The undo runs on DISPOSE as well, so a test passing no `config` at all also starts clean. Like
 * `tmpdirScoped` this is instance-WIDE rather than per-directory — which is what config now means,
 * so two live `tmpdir({ config })` handles share one document (last write wins).
 */
const provisioned: { [K in keyof Routed]: Set<Routed[K][number]> } = {
  settings: new Set(),
  references: new Set(),
  providers: new Set(),
  agents: new Set(),
  commands: new Set(),
  defaults: new Set(),
}

const anythingProvisioned = () => Object.values(provisioned).some((entries) => entries.size > 0)

const SETTINGS_KEYS: ReadonlySet<string> = new Set(SettingsConfigSeed.SETTINGS_KEYS)

/**
 * The keys this fixture REFUSES to provision, each with the reason, because a generic "teach
 * clearProvisioned() to remove it" would be false advice for both of them.
 *
 * Neither is missing a remove op — `SkillConfigStore.removeSource` and
 * `PluginConfigStore.removePlugin` both exist, and `ConfigStoreWrite` calls them. They are
 * ARRAY-shaped keys, and the documented `updateConfig` contract is that arrays replace WHOLESALE,
 * which `config-store-write.ts` implements by emptying the store and re-inserting the patch's items.
 * So the undo is not "remove what this test added" — that leaves the store missing whatever the
 * write wiped, which is the same cross-test leak one step removed — it is "put the previous list
 * back", and that needs a snapshot this fixture deliberately does not take.
 */
const REFUSED: Record<string, string> = {
  skills:
    `"skills" is an array key: a write REPLACES the whole skill-source list (config-store-write.ts ` +
    `empties the store and re-inserts), so undoing it needs the PREVIOUS list restored rather than ` +
    `the new entries removed — this fixture takes no such snapshot. Provision skills through the ` +
    `store in your own test, or use test/fixture/skills/.`,
  plugins:
    `"plugins" is an array key: a write REPLACES the whole plugin list (config-store-write.ts ` +
    `empties the store and re-inserts), so undoing it needs the PREVIOUS list restored rather than ` +
    `the new entries removed — this fixture takes no such snapshot. Provision plugins through ` +
    `PluginConfigStore.setPlugin in your own test (see test/config/config.test.ts).`,
}

/**
 * The provider ids a flat `models` map expands into.
 *
 * `models` is the models-primary AUTHORING shape: `ConfigStoreWrite` runs it through
 * `CatalogSeed.expandFlatModels` and writes the DERIVED provider groups (keyed by endpoint host)
 * into `catalog_provider`, so the undo is `removeProvider` on exactly those derived ids. This calls
 * the same expansion rather than re-deriving an id from the url — a second copy of
 * `providerIdForUrl` here would be the mirror-that-drifts defect this fixture already carries scars
 * from, and it would drift silently (a wrong id removes nothing and reports nothing).
 */
function expandedProviderIDs(models: Partial<Config.Info>["models"]): string[] {
  if (models === undefined) return []
  const expanded = CatalogSeed.expandFlatModels({ models }) as { providers?: Record<string, unknown> }
  return Object.keys(expanded.providers ?? {})
}

/**
 * Where each top-level key lands, so the undo can reach it again. A key with no route here THROWS
 * instead of being written: a write this fixture cannot take back does not fail the test that made
 * it, it fails an unrelated test in a later file — which is exactly how the defect above survived a
 * commit. Extend `clearProvisioned` first, then this.
 *
 * Exported for `clear-provisioned.test.ts` only. It is pure, and the ratchet that asserts every
 * `Config.Info` key is either routed or explicitly refused has to enumerate ~44 keys — through
 * `tmpdir()` that would be 44 temp directories, half of them leaked by the throw under test.
 */
export function routeConfig(config: Partial<Config.Info>): Routed {
  const routed: Routed = { settings: [], references: [], providers: [], agents: [], commands: [], defaults: [] }
  for (const key of Object.keys(config)) {
    if (key === "$schema") continue
    if (SETTINGS_KEYS.has(key)) {
      routed.settings.push(key)
      continue
    }
    // Each arm mirrors one block of `ConfigStoreWrite.applyToStores`, which is what decides where a
    // key actually lands. `models` writes providers but NOT the default — only `model` does that
    // (the expansion merely rewrites the ref it is given), so the two stay separate arms here too.
    if (key === "providers") routed.providers.push(...Object.keys(config.providers ?? {}))
    else if (key === "models") routed.providers.push(...expandedProviderIDs(config.models))
    else if (key === "agents") routed.agents.push(...Object.keys(config.agents ?? {}))
    else if (key === "commands") routed.commands.push(...Object.keys(config.commands ?? {}))
    else if (key === "references") routed.references.push(...Object.keys(config.references ?? {}))
    else if (key === "model") routed.defaults.push("model")
    else if (key === "default_agent") routed.defaults.push("default_agent")
    else
      throw new Error(
        `tmpdir({ config }): "${key}" cannot be undone between tests, so this fixture will not write it. ` +
          (REFUSED[key] ??
            `It routes to a store clearProvisioned() does not reach — teach clearProvisioned() to ` +
              `remove it, add its arm to routeConfig(), and add it to the Routed type.`),
      )
  }
  return routed
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

/**
 * Take every provisioned key back out of the store it landed in.
 *
 * ⚠️ Each arm deletes the ROW, not "the value this fixture contributed" — `settings.remove(key)`,
 * `removeProvider(id)`, `clearDefault()` and friends are all whole-row deletes, and none of the
 * stores keeps a per-writer history to subtract from. So provisioning a key whose row was SEEDED
 * before the test drops the seeded value too. That is pre-existing, deliberate and safe here:
 * `test/preload.ts` gives each test process its own empty XDG config dir, so the seeds
 * (`SettingsConfigSeed`/`CatalogSeed`, both `isEmpty`-gated and file-driven) have nothing to write,
 * and `PRESERVED_TABLES` keeps the sweep out of the config plane precisely so this bookkeeping is
 * the only thing that ever touches it. It is stated rather than assumed because the day a fixture
 * seeds a real document, "undo" and "delete" stop being the same operation.
 */
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
  if (provisioned.providers.size > 0) {
    const catalog = yield* CatalogStore.Service
    for (const id of provisioned.providers) yield* catalog.removeProvider(ProviderV2.ID.make(id))
    provisioned.providers.clear()
  }
  if (provisioned.agents.size > 0) {
    const agents = yield* AgentConfigStore.Service
    for (const name of provisioned.agents) yield* agents.removeAgent(name)
    provisioned.agents.clear()
  }
  if (provisioned.commands.size > 0) {
    const commands = yield* CommandConfigStore.Service
    for (const name of provisioned.commands) yield* commands.removeCommand(name)
    provisioned.commands.clear()
  }
  if (provisioned.defaults.size > 0) {
    // Both are single rows in their own store's settings table, and both `clearDefault()`s delete
    // the ROW rather than writing an empty string — an empty default is still a value, and it would
    // block the store's own `setDefaultIfEmpty` from ever seeding again (agent-config-store.ts).
    if (provisioned.defaults.has("model")) yield* (yield* CatalogStore.Service).clearDefault()
    if (provisioned.defaults.has("default_agent")) yield* (yield* AgentConfigStore.Service).clearDefault()
    provisioned.defaults.clear()
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
  // Keyed off `Routed` rather than written out arm by arm: a new destination then lands in the
  // ledger for free, and cannot be routed-but-not-recorded (which is a silent leak, not a red test).
  for (const [destination, entries] of Object.entries(routed))
    for (const entry of entries) (provisioned[destination as keyof Routed] as Set<string>).add(entry)
}

/** Take the document back out when the directory goes away. */
function releaseConfig() {
  if (!anythingProvisioned()) return Promise.resolve()
  return onServer(
    Effect.gen(function* () {
      yield* clearProvisioned
      yield* Config.use.invalidate()
    }),
  )
}

/**
 * Read the config plane straight out of the stores the server under test actually uses.
 *
 * Exported for `clear-provisioned.test.ts` only. `provisioned`/`clearProvisioned` are process-wide
 * bookkeeping whose whole job is to be invisible to a test, so the only honest way to check that an
 * undo REACHED SQLite — rather than merely emptying the in-memory ledger — is to read the same
 * memoized stores back through `onServer`. Reading any other way would build a second `:memory:`
 * database and answer about a store nobody wrote to.
 */
export const readConfigStores = () =>
  onServer(
    Effect.gen(function* () {
      const catalog = yield* CatalogStore.Service
      const agents = yield* AgentConfigStore.Service
      const commands = yield* CommandConfigStore.Service
      const references = yield* ReferenceConfigStore.Service
      const settings = yield* SettingsConfigStore.Service
      return {
        providers: Object.keys(yield* catalog.providers()),
        model: yield* catalog.getDefault(),
        agents: Object.keys(yield* agents.agents()),
        default_agent: yield* agents.getDefault(),
        commands: Object.keys(yield* commands.commands()),
        references: Object.keys(yield* references.references()),
        settings: Object.keys(yield* settings.all()),
      }
    }),
  )

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
    await provisionGit(dirpath)
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

/**
 * Effectful scoped tmpdir. Cleaned up when the scope closes.
 *
 * The git leg is `provisionGit` — the SAME function `tmpdir()` calls, rather than a second copy of
 * the ritual kept honest by a comment. (It used to be a second copy, through `ChildProcessSpawner`
 * instead of `bun $`, under the instruction "Make sure these stay in sync". That is the defect class
 * ruling 1 names: a normative claim about code in another file.)
 */
export function tmpdirScoped<E = never, R = never>(options?: {
  git?: boolean
  config?: Partial<Config.Info> | (() => Partial<Config.Info>)
  init?: (directory: string) => Effect.Effect<void, E, R>
}) {
  return Effect.gen(function* () {
    const dirpath = sanitizePath(path.join(os.tmpdir(), "novaclaw-test-" + Math.random().toString(36).slice(2)))
    yield* Effect.promise(() => fs.mkdir(dirpath, { recursive: true }))
    const dir = sanitizePath(yield* Effect.promise(() => fs.realpath(dirpath)))

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        if (options?.git) await stop(dir).catch(() => undefined)
        await clean(dir).catch(() => undefined)
      }),
    )

    if (options?.git) {
      yield* Effect.promise(() => provisionGit(dir))
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
