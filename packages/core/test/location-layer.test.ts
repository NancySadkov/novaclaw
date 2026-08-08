import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { DateTime, Effect, Equal, Hash, Schema } from "effect"
import { Tool } from "@novaclaw/core/tool/tool"
import { define } from "@novaclaw/plugin/v2/effect"
import { AgentV2 } from "@novaclaw/core/agent"
import { Catalog } from "@novaclaw/core/catalog"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { LocationServiceMap } from "@novaclaw/core/location-services"
import { Location } from "@novaclaw/core/location"
import { PluginV2 } from "@novaclaw/core/plugin"
import { ModelV2 } from "@novaclaw/core/model"
import { ProjectV2 } from "@novaclaw/core/project"
import { ProviderV2 } from "@novaclaw/core/provider"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionRunnerModel } from "@novaclaw/core/session/runner/model"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { FSUtil } from "../src/fs-util"
import { Credential } from "../src/credential"
import { Database } from "../src/database/database"
import { SettingsConfigStore } from "../src/settings-config-store"
import { EventV2 } from "../src/event"
import { Global } from "../src/global"
import { ModelsDev } from "../src/models-dev"
import { Npm } from "../src/npm"
import { Project } from "../src/project"
import { Reference } from "../src/reference"
import { ToolRegistry } from "../src/tool/registry"
import { ApplicationTools } from "../src/tool/application-tools"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      ApplicationTools.node,
      Database.node,
      EventV2.node,
      SettingsConfigStore.node,
      LocationServiceMap.node,
    ]),
  ),
)

const residentTools = [
  "application_context",
  "apply_patch",
  "bash",
  "define_tool",
  // Resident by design (batch plan 4.2): the manual's topic names ARE the prompt-visible index.
  "docs",
  "edit",
  "exit",
  "glob",
  "grep",
  "js",
  "question",
  "read",
  "skill",
  "spawn",
  "todowrite",
  "tool_call",
  "tool_manual",
  "tool_search",
  "wait",
  "webfetch",
  "websearch",
  "write",
].sort()

const deferredCoreTools = [
  "computer",
  "configure",
  "kb",
  // DEFERRED, and the ratchet below is why: a log reader is reached AFTER something failed, so its
  // schema has no claim on every turn's prefix (`todo/logging.md` 3g, `tool/log.ts`).
  "log",
  "messenger",
  "permission",
  "profile",
  "quality_provision",
  "read-hex",
  "recipe",
  "register-app",
  "resource_status",
  "revert",
  "session",
  "trash",
  "write-hex",
]

describe("LocationServiceMap", () => {
  it.live("reuses cached services for constructed and decoded location refs", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.scoped(
          Effect.gen(function* () {
            const locations = yield* LocationServiceMap.Service
            const directory = AbsolutePath.make(dir.path)
            const constructed = Location.Ref.make({ directory })
            const decoded = Schema.decodeUnknownSync(Location.Ref)({ directory })

            expect(constructed).toEqual({ directory, workspaceID: undefined })
            expect(decoded).toEqual(constructed)
            expect(Equal.equals(constructed, decoded)).toBe(true)
            expect(Hash.hash(constructed)).toBe(Hash.hash(decoded))
            expect(yield* locations.contextEffect(constructed)).toBe(yield* locations.contextEffect(decoded))
          }),
        ),
      ),
    ),
  )

  // Config→SQLite 8c: policies are INSTANCE-WIDE settings-store state (jsonc files are not a
  // runtime source), snapshotted per location at boot. A location booted while the store holds
  // the deny policy filters the provider; one booted after the policy is removed does not —
  // and each location's catalog transform state stays its own.
  it.live("isolates location state while sharing location policy with catalog", () =>
    Effect.acquireRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      (dirs) => Effect.promise(() => Promise.all(dirs.map((dir) => dir[Symbol.asyncDispose]())).then(() => undefined)),
    ).pipe(
      Effect.flatMap(([blocked, allowed]) =>
        Effect.gen(function* () {
          yield* (yield* ApplicationTools.Service).register({
            application_context: Tool.make({
              description: "Read application context",
              input: Schema.Struct({}),
              output: Schema.Struct({ ok: Schema.Boolean }),
              execute: () => Effect.succeed({ ok: true }),
            }),
          })
          const settings = yield* SettingsConfigStore.Service
          yield* settings.set("experimental", {
            policies: [{ effect: "deny", action: "provider.use", resource: "test" }],
          })

          const update = (directory: string) =>
            Effect.gen(function* () {
              yield* Reference.Service
              const catalog = yield* Catalog.Service
              yield* catalog.transform((editor) => editor.provider.update(ProviderV2.ID.make("test"), () => {}))
              const materialized = yield* (yield* ToolRegistry.Service).materialize()
              return {
                providers: yield* catalog.provider.all(),
                tools: materialized.definitions,
                deferred: materialized.deferred,
              }
            }).pipe(
              Effect.scoped,
              Effect.provide(
                LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(directory) })),
              ),
            )

          const blockedState = yield* update(blocked.path)
          expect(blockedState.providers.some((provider) => provider.id === ProviderV2.ID.make("test"))).toBe(false)
          expect(blockedState.tools.map((tool) => tool.name).sort()).toEqual(residentTools)
          expect(blockedState.deferred.map((source) => source.definition.name)).toEqual(deferredCoreTools)
          // 🔴 A RATCHET, not a limit — and the difference is the whole lesson of 2026-08-06.
          //
          // The hard ceiling here was 32,000. Measured that day, the resident set stood at **31,813
          // bytes — 99.4% of it** — and had for days, with nothing reporting the fact. A ceiling only
          // speaks at the boundary, and its first lesson to whoever trips it is "shave the new thing
          // until it fits": the `computer` tool crossed by 148 bytes, and trimming its prose would
          // have passed. The right answer was 2,400 bytes in the other direction — that tool was
          // never a per-turn cost worth paying, being UNCONFIGURED on most machines, so it moved
          // behind deferred disclosure and the set fell to 29,441.
          //
          // So the bound now sits just above the observed value instead of far above it. If you are
          // reading this because it went red, the question is NOT "how do I fit under it" — it is
          // **should this tool be resident at all?** A resident schema is paid on every turn of every
          // session forever; deferred costs one discovery round-trip in the sessions that need it.
          // Raise this number only with that question answered in the commit message.
          //
          // ⚠️ Not pinned to the exact byte, deliberately: an equality here would flake on any
          // platform whose tool prose differs, and a flaky ratchet gets deleted rather than obeyed.
          //
          // RAISED 2026-08-07, 30,000 → 32,500, for `docs` (batch plan 4.2) — and the question this
          // ratchet asks was answered before the number moved, not after. A/B measured on this box:
          // **29,441 without the tool, 31,820 with it — a 2,379-byte resident cost.**
          //
          // *Should it be resident at all?* Yes, and it is the one tool where deferral defeats the
          // feature rather than deferring it. The manual's index IS its topic names, so a deferred
          // `docs` carries no names, and a model that does not know the manual exists never searches
          // for it — which is exactly the hole the item was filed against (*we ship documentation the
          // user can read and the agent cannot*). What the 2,379 bytes buy is the other 18,266: the
          // pages themselves cost nothing until a session actually opens one, so the resident half is
          // **13% of the manual** and the rest is genuinely on demand. `docs.test.ts` pins that split
          // mechanically — a page body leaking into the description turns it red.
          const residentBytes = Buffer.byteLength(JSON.stringify(blockedState.tools))
          expect(residentBytes).toBeLessThan(32_500) // observed 31,820 on 2026-08-07 (97.9% of 32,500)
          // The second location boots AFTER the policy is gone — its boot snapshot allows the
          // provider, and the first location's catalog transform never leaked into it.
          yield* settings.remove("experimental")
          const allowedState = yield* update(allowed.path)
          expect(allowedState.providers.some((provider) => provider.id === ProviderV2.ID.make("test"))).toBe(true)
          expect(allowedState.tools.map((tool) => tool.name).sort()).toEqual(residentTools)
          expect(allowedState.deferred.map((source) => source.definition.name)).toEqual(deferredCoreTools)
        }),
      ),
    ),
  )

  it.live("rejects an unavailable selected model during location model resolution", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(dir.path, "novaclaw.json"),
              JSON.stringify({
                providers: {
                  unavailable: {
                    name: "Unavailable",
                    api: { type: "native", settings: {} },
                    models: { chat: { disabled: true } },
                  },
                },
              }),
            ),
          )
          const failure = yield* SessionRunnerModel.Service.use((models) =>
            models.resolve(
              SessionV2.Info.make({
                id: SessionV2.ID.make("ses_unavailable_model"),
                slug: "test",
                version: "test",
                title: "test",
                model: {
                  id: ModelV2.ID.make("chat"),
                  providerID: ProviderV2.ID.make("unavailable"),
                },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
                location,
              }),
            ),
          ).pipe(Effect.provide(LocationServiceMap.Service.get(location)), Effect.flip)

          expect(failure).toMatchObject({
            _tag: "SessionRunnerModel.ModelUnavailableError",
            providerID: "unavailable",
            modelID: "chat",
          })
        }),
      ),
    ),
  )

  it.live("installs public plugins into a location", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const plugins = yield* PluginV2.Service
          const reviewer = define({
            id: "reviewer",
            effect: (ctx) =>
              ctx.agent
                .transform((agent) => {
                  agent.update("reviewer", (item) => {
                    item.description = "Reviews code"
                    item.mode = "subagent"
                  })
                })
                .pipe(Effect.asVoid),
          })
          yield* plugins.add(PluginV2.ID.make(reviewer.id), reviewer.effect)

          expect(yield* (yield* AgentV2.Service).get(AgentV2.ID.make("reviewer"))).toMatchObject({
            description: "Reviews code",
            mode: "subagent",
          })
        }).pipe(
          Effect.scoped,
          Effect.provide(LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(dir.path) }))),
        ),
      ),
    ),
  )
})
