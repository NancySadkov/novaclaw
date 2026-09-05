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
import { ShortChat } from "@novaclaw/core/session/runner/short-chat"
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
  // Present HERE because this materialize runs with no agent, and the floor that denies `colleague`
  // is an AGENT ruleset (`plugin/agent.ts`) — every real session has one. A `build` session is
  // wholly denied and never sees the tool; Nova re-allows it and pays for it. This list is the
  // worst case, which is the right thing for a ratchet to measure.
  "colleague",
  // RESIDENT on purpose, and the ratchet's question was answered before it was added: a colleague
  // that must first DISCOVER it can delegate will not delegate. Deferred disclosure costs one
  // `tool_search` round-trip in the sessions that need a tool — but nothing prompts a model to go
  // looking for a capability it has no reason to suspect, and the whole corporate metaphor
  // (AGENTS.md) rests on officers reaching for each other unprompted.
  "define_tool",
  // Resident by design (batch plan 4.2): the manual's topic names ARE the prompt-visible index.
  "docs",
  "edit",
  "exit",
  "glob",
  "grep",
  "js",
  // ⚠️ `question` is NOT here any more — removed by `bf39088eb` ("a refusal is instant"), which took
  // ASK out as a permission outcome. This ledger kept listing it for days afterwards and went red
  // unnoticed, because the change was verified by its own changed-area suites: exactly the failure
  // `changed-area suites are not the TREE` names.
  "read",
  // RESIDENT, and the ratchet's question was answered before it was added: introspection is REACTIVE
  // — the user asks "why did you forget that?" and the colleague must be able to answer NOW. Deferred
  // disclosure works for tools a session reaches for after something happens (`log` after a failure);
  // a question about the agent itself gives the model no cue that a tool exists to answer it, and a
  // wrong guess about your own configuration reads to a user as a lie rather than as ignorance.
  "self",
  "skill",
  "spawn",
  "todowrite",
  "tool_call",
  "tool_manual",
  "tool_search",
  // Resident because Short Chat has no discovery horizon: this is its sole consent-bound escape.
  // The runner hides it from Full Agent, so only Chat pays its provider-prefix cost.
  "upgrade_chat",
  "wait",
  "webfetch",
  "websearch",
  "write",
].sort()

const deferredCoreTools = [
  // DEFERRED for the same reason as `log` and the raw DB surface: reading the P2P community is a
  // thing a user asks for occasionally, not a capability every turn's prefix should carry.
  "community",
  "computer",
  "configure",
  "kb",
  // DEFERRED, and the ratchet below is why: a log reader is reached AFTER something failed, so its
  // schema has no claim on every turn's prefix (`` 3g, `tool/log.ts`).
  "log",
  "messenger",
  "permission",
  "profile",
  "quality_provision",
  "read-hex",
  "recipe",
  "register-app",
  // DEFERRED: a raw database surface is reached after something failed, so it owes the prompt
  // nothing until tool_search discloses it. Same call as `log`, which it pairs with.
  "registry",
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
          //
          // RAISED 2026-08-19, 32,500 → 32,750, for `read`'s description — and the question was
          // answered by measurement before the number moved, as the 2026-08-07 raise did.
          //
          // *What do the bytes buy?* The tool being USABLE FOR IMAGES AT ALL. `read` opened with
          // "Read text or a supported image", which a model reads as "opens the file" — true of
          // every binary it cannot use. Measured 2026-08-19: asked to rename a folder of six PNGs,
          // Holo-3.1 called `read` **zero times** and said it could not see them. With the image
          // clause leading and unhedged, the same prompt on the same model called it **four times**,
          // and the corpus went from 1/6 to 5/6 correctly named
          // (`notes/reports/vision-on-disk-2026-08-19.md`). Codex closed the identical bug the same
          // way (openai/codex#23949): a hedged capability description reads as a prohibition.
          //
          // RAISED 2026-08-21, 32,750 → 33,000, for `colleague` — the hand-off tool the corporate
          // metaphor rests on. The ratchet's question was answered by A/B before the number moved:
          // **30,744 bytes with the tool deferred, 32,822 with it resident — a 2,078-byte cost.**
          //
          // *Why not deferred, then?* Because nothing prompts a model to search for a capability it
          // has no reason to suspect. Deferred disclosure works for tools a session reaches for after
          // something happens (`log` after a failure, `kb` when recall falls short); delegation has no
          // such trigger — an officer that must first DISCOVER it can ask a colleague simply will not.
          //
          // *Who pays?* Only agents allowed to use it. The compiled floor denies `colleague`, and a
          // wholly-denied tool is WITHDRAWN from the horizon rather than advertised and refused, so a
          // `build` session's prompt is unchanged and Nova's carries the 2,078 bytes that make it a
          // CEO. This measurement is the agentless worst case.
          //
          // RAISED 2026-08-21, 33,000 → 34,250, for `self` — the introspection tool the owner asked for
          // ("each agent should have introspection tool, which would allow it to see their
          // configuration"). A/B measured before the number moved: **32,822 without it, 34,065 with —
          // 1,243 bytes.**
          //
          // *Why not deferred?* Introspection is REACTIVE. `log` is reached after a failure and `kb`
          // when recall falls short — both are moments that cue a search. "Why did you forget that?"
          // cues nothing: the model has no reason to suspect a tool exists to answer a question about
          // ITSELF, and a wrong guess about your own configuration reads to a user as a lie rather
          // than as ignorance.
          //
          // *Who pays?* Working agents only. The machinery (title, summary, compaction) carries
          // `* → deny`, and `materialize` withdraws a wholly-denied tool; a short-chat session is
          // offered nothing but Upgrade. So the per-turn passes that run on every single turn are
          // unchanged.
          //
          // *Could it be cheaper?* It was trimmed twice first — 122 characters out of the new
          // wording, dropping the illustrative examples and the long MIME list — which took it from
          // 32,699 to 32,577. What remains is the clause that does the work. The ask for a
          // description lives in the tool RESULT (`IMAGE_NOTE`), not here, so it costs no resident
          // bytes at all.
          // *Should it be resident at all?* Yes, and it is the one tool where deferral defeats the
          // feature rather than deferring it. The manual's index IS its topic names, so a deferred
          // `docs` carries no names, and a model that does not know the manual exists never searches
          // for it — which is exactly the hole the item was filed against (*we ship documentation the
          // user can read and the agent cannot*). What the 2,379 bytes buy is the other 18,266: the
          // pages themselves cost nothing until a session actually opens one, so the resident half is
          // **13% of the manual** and the rest is genuinely on demand. `docs.test.ts` pins that split
          // mechanically — a page body leaking into the description turns it red.
          const fullAgentTools = blockedState.tools.filter((tool) => ShortChat.offered(undefined, tool.name))
          const residentBytes = Buffer.byteLength(JSON.stringify(fullAgentTools))
          //
          // ── Raised 2026-08-24 for `colleague` op "ask_group" (34,065 → 34,506) ──────────────────
          //
          // *Who pays?* Only sessions that may ADDRESS colleagues at all. `colleague` is denied by the
          // agent floor (`plugin/agent.ts`), so a `build` session never sees the tool and pays nothing;
          // Nova re-allows it and pays. This measurement runs with NO agent, so it is the worst case by
          // construction — which is what makes it the right thing for a ratchet to hold.
          //
          // *Could it be cheaper?* Trimmed first, as this budget demands: 62 bytes out of the two new
          // descriptions (34,568 → 34,506). What remains is the op itself, which is ~440 bytes of
          // schema no wording can remove. The cheaper alternative was considered and REJECTED: an
          // optional `also: string[]` on the existing `ask` op costs roughly a quarter as much,
          // because it reuses `message` and mints no second op literal — but it makes the
          // first-named colleague read as the primary recipient when delivery treats every
          // participant identically. A conference where one member looks senior is the same class of
          // misattribution the peer/parent distinction exists to prevent, and it is durable in the
          // receiver's transcript.
          //
          // *Should it be resident at all?* The `colleague` tool already is, and an op cannot be
          // deferred separately from the schema that declares it. The choice was a new op or a
          // cheaper ambiguous field, not resident or deferred.
          expect(residentBytes).toBeLessThan(34_700) // observed 34,506 on 2026-08-24 (99.4% of 34,700)
          const chatTools = blockedState.tools.filter((tool) => ShortChat.offered(true, tool.name))
          expect(chatTools.map((tool) => tool.name)).toEqual(["upgrade_chat"])
          expect(Buffer.byteLength(JSON.stringify(chatTools))).toBeLessThan(1_500)
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
                .declare([{ id: "reviewer", set: { description: "Reviews code", mode: "subagent" } }])
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
