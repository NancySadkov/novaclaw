import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Location } from "@novaclaw/core/location"
import { AgentV2 } from "@novaclaw/core/agent"
import { AgentPlugin } from "@novaclaw/core/plugin/agent"
import { ColleagueTool } from "@novaclaw/core/tool/colleague"
import { AbsolutePath } from "@novaclaw/core/schema"
import { location } from "./fixture/location"
import { agentHost, host } from "./plugin/host"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([AgentV2.node])))

/**
 * 🔴 **The catalogue, printed from the roster the instance ACTUALLY builds.**
 *
 * Owner, 2026-09-27, pasting a live `colleague list`:
 *
 *     build · build · The default agent. Executes tools based on configured permissions.
 *     plan · plan · Plan mode. Disallows all edit tools.
 *     xenia · Xenia · Companion — Xenia, Companion.
 *     geryon · Geryon · Engineer — Geryon, Engineer.
 *
 * Three defects, and this file exists so the STRINGS are asserted rather than the predicate: a
 * predicate test proves the filter is applied, and a listing is what a human reads.
 *
 * ⚠️ **Read as `plan`, because this harness builds the agent PLUGIN alone.** The shipped colleagues are
 * config rows (`agent-config-seed.ts`, so retiring one sticks), which is why the plugin roster's only
 * colleague is Nova. Asked as Nova the catalogue is legitimately empty and prints the "no colleagues"
 * line, which is correct and asserts nothing about the ghosts.
 */
describe("the catalogue as a model reads it", () => {
  it.effect("lists colleagues plainly, and lists no machinery", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      yield* AgentPlugin.Plugin.effect(host({ agent: agentHost(agent) })).pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
        ),
      )
      const roster = yield* agent.all()
      const listing = ColleagueTool.formatRoster(
        ColleagueTool.addressable(roster, AgentV2.ID.make("plan")),
        AgentV2.ID.make("plan"),
      )
      console.log(`CATALOGUE:\n${listing}`)

      expect(listing).toBe("nova - Chief Executive")
      // The three shapes the owner pasted, absent as SHAPES — not as ids, because the ids vary.
      expect(listing).not.toContain("The default agent")
      expect(listing).not.toContain("Plan mode")
      expect(listing).not.toContain("—")
      expect(listing).not.toContain(" · ")
    }),
  )

  it.effect("every agent the instance ships is classified, and the answer is visible", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      yield* AgentPlugin.Plugin.effect(host({ agent: agentHost(agent) })).pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
        ),
      )
      const rows = (yield* agent.all()).map((item) => {
        const id = String(item.id)
        const why = !AgentV2.POSTURE_IDS.has(id)
          ? item.hidden
            ? "hidden service agent"
            : item.mode === "subagent"
              ? "staff"
              : "COLLEAGUE"
          : "posture (not a colleague)"
        return `${id.padEnd(12)} ${why}`
      })
      console.log(`AGENTS:\n${rows.join("\n")}`)

      // Nova is the one the catalogue carries, and she is a colleague.
      expect(
        ColleagueTool.addressable(yield* agent.all(), AgentV2.ID.make("plan")).map((a) => String(a.id)),
      ).toEqual([AgentV2.NOVA_ID])
    }),
  )
})
