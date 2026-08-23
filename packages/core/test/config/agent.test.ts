import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Schema } from "effect"
import { AgentV2 } from "@novaclaw/core/agent"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import type { ConfigAgent } from "@novaclaw/core/config/agent"
import { Config } from "@novaclaw/core/config"
import { ConfigAgentPlugin } from "@novaclaw/core/config/plugin/agent"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { FSUtil } from "@novaclaw/core/fs-util"
import { PermissionV2 } from "@novaclaw/core/permission"
import { AbsolutePath } from "@novaclaw/core/schema"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { agentHost, host } from "../plugin/host"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([AgentV2.node, FSUtil.node])))

// Config→SQLite steps 2 + 8c: the plugin reads config-borne agents from the instance-wide
// store (pre-populated here — the import seeds fill it at boot; documents only carry the
// global `permissions` ruleset, which in production is the settings store's synthetic doc).
const memoryStore = () => {
  const layers = new Map<string, ConfigAgent.Info[]>()
  let defaultAgent: string | undefined
  return AgentConfigStore.Service.of({
    agents: () => Effect.sync(() => Object.fromEntries(layers)),
    setLayers: (name, next) =>
      Effect.sync(() => {
        layers.set(name, [...next])
      }),
    removeAgent: (name) =>
      Effect.sync(() => {
        layers.delete(name)
      }),
    getDefault: () => Effect.sync(() => defaultAgent),
    setDefault: (name) =>
      Effect.sync(() => {
        defaultAgent = name
      }),
    clearDefault: () =>
      Effect.sync(() => {
        defaultAgent = undefined
      }),
    setDefaultIfEmpty: (name) =>
      Effect.sync(() => {
        defaultAgent ??= name
      }),
    isEmpty: () => Effect.sync(() => layers.size === 0),
  })
}
const decode = Schema.decodeUnknownSync(Config.Info)

describe("ConfigAgentPlugin.Plugin", () => {
  it.effect("applies all global permissions before agent-specific permissions", () =>
    Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      const build = AgentV2.ID.make("build")
      yield* agents.transform((editor) =>
        editor.update(build, (agent) => {
          agent.mode = "primary"
          agent.permissions.push({ action: "bash", resource: "*", effect: "allow" })
        }),
      )

      const first = decode({
        agents: {
          build: {
            permissions: [{ action: "bash", resource: "git *", effect: "allow" }],
          },
          reviewer: {
            model: "openrouter/openai/gpt-5",
            description: "Review changes",
            mode: "subagent",
            permissions: [
              { action: "edit", resource: "*", effect: "deny" },
              { action: "read", resource: "*", effect: "deny" },
            ],
          },
          removed: { description: "Removed later" },
        },
      }).agents!
      const second = decode({
        agents: {
          reviewer: { variant: "high", hidden: true },
          removed: { disabled: true },
          late: {
            permissions: [{ action: "edit", resource: "*", effect: "allow" }],
          },
        },
      }).agents!
      const store = memoryStore()
      yield* store.setLayers("build", [first.build])
      yield* store.setLayers("reviewer", [first.reviewer, second.reviewer])
      yield* store.setLayers("removed", [first.removed, second.removed])
      yield* store.setLayers("late", [second.late])

      const config = Config.Service.of({
        entries: () =>
          Effect.succeed([
            new Config.Document({
              type: "document",
              info: decode({
                permissions: [
                  { action: "bash", resource: "*", effect: "ask" },
                  { action: "read", resource: "*", effect: "allow" },
                ],
              }),
            }),
          ]),
      })

      yield* ConfigAgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })).pipe(
        Effect.provideService(Config.Service, config),
        Effect.provideService(AgentConfigStore.Service, store),
      )

      const buildAgent = yield* agents.get(build)
      if (!buildAgent) throw new Error("expected configured build agent")
      expect(buildAgent.permissions).toEqual([
        { action: "bash", resource: "*", effect: "allow" },
        { action: "bash", resource: "*", effect: "ask" },
        { action: "read", resource: "*", effect: "allow" },
        { action: "bash", resource: "git *", effect: "allow" },
      ])
      expect(PermissionV2.evaluate("bash", "git status", buildAgent.permissions).effect).toBe("allow")
      expect(PermissionV2.evaluate("bash", "bun test", buildAgent.permissions).effect).toBe("ask")

      const reviewer = yield* agents.get(AgentV2.ID.make("reviewer"))
      if (!reviewer) throw new Error("expected configured reviewer agent")
      expect(reviewer).toMatchObject({
        description: "Review changes",
        mode: "subagent",
        hidden: true,
        model: { providerID: "openrouter", id: "openai/gpt-5", variant: "high" },
      })
      // ⚠️ A config-borne agent now opens with the shared FLOOR (`plugin/agent.ts` → `floor`), added
      // 2026-08-21 because a hired colleague started from `permissions: []` and could not read a file
      // while the shipped mode still granted it `bash`. So these assert the ORDER — floor, then the
      // document's globals, then the agent's own rules, last wins — rather than a literal list that
      // would have to be re-copied every time the floor changes.
      const tail = (rules: PermissionV2.Ruleset, n: number) => rules.slice(-n)
      expect(tail(reviewer.permissions, 4)).toEqual([
        { action: "bash", resource: "*", effect: "ask" },
        { action: "read", resource: "*", effect: "allow" },
        { action: "edit", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "deny" },
      ])
      // The floor is BENEATH them: it allows `read`, and the agent's own deny still wins.
      expect(reviewer.permissions[0]).toEqual({ action: "read", resource: "*", effect: "allow" })
      expect(PermissionV2.evaluate("read", "README.md", reviewer.permissions).effect).toBe("deny")
      expect(tail((yield* agents.get(AgentV2.ID.make("late")))!.permissions, 3)).toEqual([
        { action: "bash", resource: "*", effect: "ask" },
        { action: "read", resource: "*", effect: "allow" },
        { action: "edit", resource: "*", effect: "allow" },
      ])
      // ⚠️ PAUSED, not removed (2026-08-23). `disabled: true` used to `draft.remove` the agent, which
      // was a retirement bypassing every guarantee of `agent/retire.ts` — and retirement is
      // confirm-gated, which a config write can never be. It stays on the roster; `permission.ts`
      // denies it everything.
      expect(yield* agents.get(AgentV2.ID.make("removed"))).toMatchObject({ paused: true })
    }),
  )

  it.effect("maps configured agent fields and preserves an unspecified model variant", () =>
    Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      const store = memoryStore()
      yield* store.setLayers("reviewer", [
        decode({
          agents: {
            reviewer: {
              model: "anthropic/claude-sonnet",
              system: "Review carefully.",
              description: "Reviews changes",
              mode: "subagent",
              hidden: true,
              color: "warning",
              steps: 12,
              request: {
                headers: { first: "one", shared: "first" },
                body: { enabled: true, profile: "review", effort: "medium" },
              },
            },
          },
        }).agents!.reviewer,
        decode({
          agents: {
            reviewer: {
              request: {
                headers: { shared: "last", second: "two" },
                body: { retries: 2, effort: "high" },
              },
            },
          },
        }).agents!.reviewer,
      ])

      yield* ConfigAgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })).pipe(
        Effect.provideService(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) })),
        Effect.provideService(AgentConfigStore.Service, store),
      )

      const reviewer = yield* agents.get(AgentV2.ID.make("reviewer"))
      if (!reviewer) throw new Error("expected configured reviewer agent")
      expect(reviewer).toMatchObject({
        system: "Review carefully.",
        description: "Reviews changes",
        mode: "subagent",
        hidden: true,
        color: "warning",
        steps: 12,
        model: { providerID: "anthropic", id: "claude-sonnet", variant: undefined },
      })
      expect(reviewer.request).toEqual({
        headers: { first: "one", shared: "last", second: "two" },
        body: { enabled: true, profile: "review", retries: 2, effort: "high" },
      })
    }),
  )

  /**
   * 🔴 A RETIRED ID RETURNS, so a returning colleague must not be born PAUSED.
   *
   * Officer names come from a fixed pool, so `OfficerName.pick` can hand a new hire the id a retired
   * colleague used. This programme's standing constraint is that **anything newly keyed on an agent
   * id is cleared at retirement** — and `paused` (2026-08-23) is newly keyed on one. It is cleared by
   * construction, because retiring drops the whole `agents.<id>` config fragment
   * (`config-store-write.ts` → `AgentConfigStore.removeAgent` → `agents.remove(name)`), but nothing
   * asserted it. The constraint exists precisely because new state gets added and forgotten, and the
   * failure would be silent: a fresh hire that quietly cannot act, with no control showing why.
   */
  it.effect("a returning id is NOT born paused — the disabled fragment goes with the agent", () =>
    Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      const id = AgentV2.ID.make("theron")
      yield* agents.transform((editor) => editor.update(id, () => {}))

      const store = memoryStore()
      const apply = () =>
        ConfigAgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })).pipe(
          Effect.provideService(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) })),
          Effect.provideService(AgentConfigStore.Service, store),
        )

      yield* store.setLayers("theron", [decode({ agents: { theron: { disabled: true } } }).agents!.theron])
      yield* apply()
      expect(yield* agents.get(id)).toMatchObject({ paused: true })

      // Retirement removes the stored fragment; the pool then hands the id to somebody new.
      yield* store.setLayers("theron", [])
      yield* agents.transform((editor) => editor.update(id, () => {}))
      yield* apply()

      const returned = yield* agents.get(id)
      expect(returned?.paused).not.toBe(true)
    }),
  )

  it.effect("PAUSES a built-in agent disabled by configuration, rather than removing it", () =>
    Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      const build = AgentV2.ID.make("build")
      yield* agents.transform((editor) => editor.update(build, () => {}))

      const store = memoryStore()
      yield* store.setLayers("build", [decode({ agents: { build: { disabled: true } } }).agents!.build])

      yield* ConfigAgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })).pipe(
        Effect.provideService(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) })),
        Effect.provideService(AgentConfigStore.Service, store),
      )

      // 🔴 Still there, and that is the fix: removal left the colleague's chat live but DOORLESS
      // (the roster row is the only way in) and freed its id for `OfficerName.pick` to redraw,
      // handing the next hire its cabinet at `agent:<id>`.
      expect(yield* agents.get(build)).toMatchObject({ paused: true })
    }),
  )

  it.live("loads file-based agents from config directories", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "agents", "team"), { recursive: true })
            await fs.mkdir(path.join(tmp.path, "modes"), { recursive: true })
            await fs.writeFile(
              path.join(tmp.path, "agents", "reviewer.md"),
              `---
model: openrouter/openai/gpt-5
description: Markdown description
request:
  body:
    temperature: 0.5
permissions:
  - action: edit
    resource: "*"
    effect: deny
---
Review carefully.`,
            )
            await fs.writeFile(path.join(tmp.path, "agents", "team", "helper.md"), "Help the team.")
            await fs.writeFile(
              path.join(tmp.path, "agents", "native.md"),
              `---
request:
  headers:
    x-agent: native
  body:
    effort: high
permissions:
  - action: edit
    resource: "*"
    effect: deny
---
Use native v2 fields.`,
            )
            await fs.writeFile(path.join(tmp.path, "agents", "disabled.md"), "---\ndisabled: true\n---\nDisabled")
            await fs.writeFile(path.join(tmp.path, "modes", "plan.md"), "Make a plan.")
          })
          const agents = yield* AgentV2.Service
          const config = Config.Service.of({
            entries: () =>
              Effect.succeed([
                new Config.Document({
                  type: "document",
                  info: decode({ agents: { reviewer: { description: "JSON description" } } }),
                }),
                new Config.Directory({ type: "directory", path: AbsolutePath.make(tmp.path) }),
              ]),
          })

          yield* ConfigAgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })).pipe(
            Effect.provideService(Config.Service, config),
            Effect.provideService(AgentConfigStore.Service, memoryStore()),
          )

          expect(yield* agents.get(AgentV2.ID.make("reviewer"))).toMatchObject({
            model: { providerID: "openrouter", id: "openai/gpt-5" },
            system: "Review carefully.",
            description: "Markdown description",
            request: { body: { temperature: 0.5 } },
          })
          // The file's own rule is the LAST word, on top of the shared floor (see the note above).
          expect((yield* agents.get(AgentV2.ID.make("reviewer")))!.permissions.at(-1)).toEqual({
            action: "edit",
            resource: "*",
            effect: "deny",
          })
          expect(yield* agents.get(AgentV2.ID.make("team/helper"))).toMatchObject({ system: "Help the team." })
          expect(yield* agents.get(AgentV2.ID.make("native"))).toMatchObject({
            system: "Use native v2 fields.",
            request: { headers: { "x-agent": "native" }, body: { effort: "high" } },
          })
          expect((yield* agents.get(AgentV2.ID.make("native")))!.permissions.at(-1)).toEqual({
            action: "edit",
            resource: "*",
            effect: "deny",
          })
          expect(yield* agents.get(AgentV2.ID.make("disabled"))).toBeUndefined()
          expect(yield* agents.get(AgentV2.ID.make("plan"))).toMatchObject({ system: "Make a plan.", mode: "primary" })
        }),
      ),
    ),
  )
})
