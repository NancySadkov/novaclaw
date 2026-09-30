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
        "compaction",
        "nova",
        "owner",
        // "build" and "plan" left on 2026-09-27 when the anonymous agents were RETIRED (owner: "get
        // completely rid of build and plan both as colleagues and as machinery - we have completely
        // retired the anonymous agents. So they are not just ghosts polluting NovaClaw"). They were
        // permission modes wearing an agent's shape, and permissionMode: "plan" - the live read-only
        // mode - was never one of them. Not asserted back in: a retirement that a test can undo is
        // not a retirement.
        // "researcher" left on 2026-09-07 (`8634e2481`) when the Research Officer moved out of this
        // plugin roster into the seeded officers (`agent-config-seed.ts`). Not asserted back in: an
        // instance with no seed row has no researcher, and a built-in roster must not read seed state.
        // "summary"/"title" left on 2026-09-21 (`ba3fce31f`) — two prompt strings that never spoke to
        // anyone, retired to internal machinery. Both removals are why the set is pinned by name.
      ])
      expect(agents.find((item) => item.id === AgentV2.NOVA_ID)?.avatar).toBeUndefined()
      expect(agents.find((item) => item.id === "compaction")?.service).toBe(true)
      expect(AgentV2.directReports(AgentV2.NOVA_ID, agents)).toEqual([])
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

      // ⚠️ **Asked as `plan`, not as `nova`, and the emptiness below is correct rather than a fault.**
      // This harness builds the AGENT PLUGIN alone. The shipped colleagues are CONFIG rows
      // (`agent-config-seed.ts`) precisely so retiring one sticks, so the plugin roster's only
      // colleague is Nova — and asked about herself, a catalogue is legitimately empty. Asking as a
      // posture instead leaves Nova, the service agents are `hidden`, and `general`/`explore` are
      // staff: so exactly one row, which is what makes the per-row assertions below mean something.
      const roster = ColleagueTool.addressable(yield* agent.all(), AgentV2.ID.make("plan"))
      expect(roster.map((item) => String(item.id)).sort()).toEqual([AgentV2.NOVA_ID, AgentV2.OWNER_ID])
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
    }),
  )

  /**
   * 🔴 **The two postures are NOT on the catalogue, and titling them is what made that necessary.**
   *
   * Owner, 2026-09-27: *"get completely rid of build and plan … they are not just ghosts polluting
   * NovaClaw"*, after a listing showed `build · build · The default agent…` again.
   *
   * ⭐ **THE SEQUENCE IS THE LESSON, and this test is here so it cannot recur.** The previous slice
   * gave `build` and `plan` a name and a job title. That was the right fix for the two rows the owner
   * could see — but it did not stop them being ADDRESSABLE, so they came back looking like colleagues.
   * **Titling a ghost is not the same as retiring it**: it makes the ghost legible, and legibility is
   * what makes it read as part of the org. The names and titles stay, because a posture still needs a
   * legible label wherever a session legitimately runs as one (the tab strip, a session header); what
   * is asserted here is that it never reaches `addressable`.
   */
  it.effect("🔴 the anonymous agents are RETIRED: not agents, not colleagues, not the default", () =>
    // THE SEQUENCE IS THE LESSON, and it is the whole reason this test is worded as absence.
    //
    // Release N-1 gave `build` and `plan` a name and a job title, because they were showing up in
    // `colleague list` as `build · build · The default agent...`. That fixed the row and left the
    // agent: the next message from the owner's instance listed them again, now titled, now looking
    // like colleagues. Titling a ghost is not retiring it - it makes the ghost legible, and
    // legibility is what makes it read as part of the org. They are now not agents AT ALL.
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

      const all = yield* agent.all()
      const ids = all.map((item) => String(item.id))
      for (const retired of [AgentV2.BUILD_ID, "plan"]) {
        expect(ids, `${retired} is still an agent`).not.toContain(retired)
        expect(AgentV2.POSTURE_IDS.has(retired), `${retired} left the retired-id vocabulary`).toBe(true)
        expect(AgentV2.isColleague({ id: retired, mode: "primary" }), `${retired} reads as a colleague`).toBe(false)
      }
      // The catalogue is not empty, or "we removed them" would read the same as "we broke the tool" -
      // the failure mode of a filter aggressive enough to empty it.
      expect(ColleagueTool.addressable(all, AgentV2.ID.make("plan")).map((item) => String(item.id))).toEqual([
        AgentV2.OWNER_ID,
        AgentV2.NOVA_ID,
      ])
      // And a chat belongs to a colleague, which is what makes the retirement structural rather than
      // cosmetic: nothing in the instance can mint a posture-owned root any more.
      expect(AgentV2.DEFAULT_COLLEAGUE_ID).not.toBe(AgentV2.BUILD_ID)
    }),
  )
})
