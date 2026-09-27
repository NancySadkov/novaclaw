import { describe, expect, test } from "bun:test"
import { Effect, Exit, Scope } from "effect"
import { AgentV2 } from "@novaclaw/core/agent"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { Location } from "@novaclaw/core/location"
import { AgentPlugin } from "@novaclaw/core/plugin/agent"
import { AbsolutePath } from "@novaclaw/core/schema"
import { ColleagueTool } from "@novaclaw/core/tool/colleague"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { agentHost, host } from "./plugin/host"

const it = testEffect(AppNodeBuilder.build(AgentV2.node))

describe("AgentV2", () => {
  test("Chat and Human cannot inherit an autonomous operation mode", () => {
    expect(AgentV2.operationModeOf({ kind: "agent", operationMode: "unattended" })).toBe("unattended")
    expect(AgentV2.operationModeOf({ kind: "chat", operationMode: "unattended" })).toBe("interactive")
    expect(AgentV2.operationModeOf({ kind: "human", operationMode: "unattended" })).toBe("interactive")
    expect(AgentV2.operationModeOf({ kind: "agent" })).toBeUndefined()
  })
  it.effect("starts without agents", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service

      expect(yield* agent.all()).toEqual([])
      expect(yield* agent.get(AgentV2.ID.make("build"))).toBeUndefined()
    }),
  )

  it.effect("materializes replayable agent transforms", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("reviewer")
      yield* agent.transform((editor) =>
        editor.update(id, (info) => {
          info.description = "Reviews code"
          info.mode = "subagent"
        }),
      )

      expect(yield* agent.get(id)).toMatchObject({ id, description: "Reviews code", mode: "subagent" })
      expect((yield* agent.all()).map((info) => info.id)).toEqual([id])
    }),
  )

  it.effect("rebuilds state when a transform is replaced", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("reviewer")
      let description = "Old description"
      let hidden = true
      yield* agent.transform((editor) =>
        editor.update(id, (info) => {
          info.description = description
          info.hidden = hidden
        }),
      )
      description = "New description"
      hidden = false
      yield* agent.reload()

      expect(yield* agent.get(id)).toMatchObject({ description: "New description", hidden: false })
    }),
  )

  it.effect("removes a transform when its scope closes", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("scoped")
      const scope = yield* Scope.make()
      yield* agent.transform((editor) => editor.update(id, () => {})).pipe(Scope.provide(scope))
      expect(yield* agent.get(id)).toBeDefined()

      yield* Scope.close(scope, Exit.void)
      expect(yield* agent.get(id)).toBeUndefined()
    }),
  )

  it.effect("applies direct agent updates", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("build")

      yield* agent.transform((editor) =>
        editor.update(id, (info) => {
          info.mode = "primary"
          info.hidden = true
        }),
      )

      expect(yield* agent.get(id)).toMatchObject({ id, mode: "primary", hidden: true })
    }),
  )

  it.effect("creates agents with runtime defaults and supports direct removal", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("custom")

      yield* agent.transform((editor) => editor.update(id, () => {}))
      expect(yield* agent.get(id)).toEqual(AgentV2.Info.empty(id))

      yield* agent.transform((editor) => editor.remove(id))
      expect(yield* agent.get(id)).toBeUndefined()
    }),
  )

  it.effect("does not ambiently opt built-in agents into bash", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      yield* AgentPlugin.Plugin.effect(
        host({
          agent: agentHost(agent),
        }),
      ).pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
        ),
      )

      const agents = yield* agent.all()
      expect(agents.map((item) => String(item.id)).sort()).toEqual([
        "build",
        "compaction",
        "explore",
        "general",
        /**
         * The SERVICE agents (2026-08-28). The messenger console and the recipe cook used to create
         * sessions with NO agent at all — rows belonging to nobody, on no roster, reachable from
         * nowhere. They own that work now, so a chat a subsystem starts can be named and pointed at.
         *
         * ⚠️ Held to the SAME floor as every other built-in, which is what the loop below checks:
         * owning a subsystem's chats grants no ambient authority over what may be run.
         */
        "messenger",
        // Nova, the CEO (AGENTS.md — the structural metaphor). It joins the built-in roster and is
        // held to the same floor as every other built-in below: governing WHO exists grants no
        // ambient authority over what they may run.
        "nova",
        "plan",
        "recipe",
        // "researcher" left on 2026-09-07 (`8634e2481`) when the Research Officer moved out of this
        // plugin roster into the seeded officers (`agent-config-seed.ts`). Not asserted back in: an
        // instance with no seed row has no researcher, and a built-in roster must not read seed state.
        // "summary"/"title" left on 2026-09-21 (`ba3fce31f`) — two prompt strings that never spoke to
        // anyone, retired to internal machinery. Both removals are why the set is pinned by name.
      ])
      expect(agents.find((item) => item.id === AgentV2.NOVA_ID)?.avatar).toBeUndefined()
      for (const item of agents) {
        expect(item.permissions.some((rule) => rule.action === "bash" && rule.effect !== "deny")).toBe(false)
      }
    }),
  )

  /**
   * 🔴 **EVERY colleague the roster can print carries a job title** (owner, 2026-09-27: *"ensure the
   * colleague list tool beside their names also lists the job titles"*).
   *
   * `formatRoster` prints `id · name · title — description`, and it printed it faithfully — but `build`
   * and `plan` had neither a name nor a title, so their rows were an id twice followed by a sentence
   * where a job title belongs. A roster is a routing decision, and "which of these do I hand this to"
   * is unanswerable from `build · build · The default agent. Executes tools based on configured
   * permissions.`
   *
   * ⚠️ This asserts on the roster `colleague list` actually builds, through `addressable`, so a built-in
   * that is made addressable later cannot join it untitled. A description that merely restates the name
   * and title is the same defect wearing a hat: it pushes the title to the end of a repetition of what
   * is already on the row, so the title is present and unreadable — which is what the seeded officers
   * did (`daedalus · Daedalus · Engineer — Daedalus, Engineer.`).
   */
  it.effect("every addressable built-in is nameable, titled, and says something the title does not", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      yield* AgentPlugin.Plugin.effect(
        host({
          agent: agentHost(agent),
        }),
      ).pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
        ),
      )

      const roster = ColleagueTool.addressable(yield* agent.all(), AgentV2.NOVA_ID)
      expect(roster.length).toBeGreaterThan(0)
      for (const colleague of roster) {
        const id = String(colleague.id)
        expect(colleague.name?.trim(), `${id} has no display name`).toBeTruthy()
        expect(colleague.title?.trim(), `${id} has no job title`).toBeTruthy()
        // The name must differ from the id, or the row leads with the same two tokens.
        expect(colleague.name?.trim(), `${id} is displayed under its own id`).not.toBe(id)
        // …and the description must not be the name and title handed back.
        const restated = `${colleague.name}, ${colleague.title}.`
        expect(colleague.description?.trim(), `${id} restates its name and title`).not.toBe(restated)
      }
      // The two that had none, named, because they are the rows the owner was reading.
      expect(roster.find((item) => item.id === AgentV2.BUILD_ID)?.title).toBe("Task agent")
      expect(roster.find((item) => item.id === AgentV2.ID.make("plan"))?.title).toBe("Planning agent")
    }),
  )
})
