import { describe, expect, test } from "bun:test"
import { Agent } from "@/agent/agent"
import { AgentV2 } from "@novaclaw/core/agent"
import { ModelV2 } from "@novaclaw/core/model"
import { ProviderV2 } from "@novaclaw/core/provider"

// F1 reconciliation: the `/agent` list + CLI now read the authoritative V2 store
// (AgentV2 — a superset that includes PLUGIN-registered + markdown agents that the
// old novaclaw Agent.Service never saw) and project each onto the V1 wire shape via
// `Agent.fromV2`. These cover that projection — the new logic that makes a
// V2-only (e.g. plugin-contributed) agent visible in the legacy list.
describe("Agent.fromV2", () => {
  test("projects a plugin-registered V2 agent onto the V1 wire shape", () => {
    const v2: AgentV2.Info = {
      id: AgentV2.ID.make("reviewer"),
      mode: "subagent",
      hidden: false,
      description: "Reviews code",
      system: "You are a reviewer.",
      color: "accent",
      steps: 42,
      request: { headers: {}, body: { top_p: 0.9, temperature: 0.4, extra: "x" } },
      model: {
        id: ModelV2.ID.make("qwen3.6-35b"),
        providerID: ProviderV2.ID.make("dgx-spark"),
        variant: ModelV2.VariantID.make("high"),
      },
      permissions: [{ action: "bash", resource: "*", effect: "ask" }],
    }

    const v1 = Agent.fromV2(v2)

    expect(v1.name).toBe("reviewer")
    expect(v1.mode).toBe("subagent")
    expect(v1.native).toBeUndefined() // not a built-in
    expect(v1.hidden).toBe(false)
    expect(v1.description).toBe("Reviews code")
    expect(v1.prompt).toBe("You are a reviewer.")
    expect(v1.topP).toBe(0.9)
    expect(v1.temperature).toBe(0.4)
    expect(v1.color).toBe("accent")
    expect(v1.steps).toBe(42)
    expect(v1.options).toEqual({ top_p: 0.9, temperature: 0.4, extra: "x" })
    expect(`${v1.model?.modelID}`).toBe("qwen3.6-35b")
    expect(`${v1.model?.providerID}`).toBe("dgx-spark")
    expect(v1.variant).toBe("high")
    // V2 {action,resource,effect} → V1 {permission,pattern,action}
    expect(v1.permission).toEqual([{ permission: "bash", pattern: "*", action: "ask" }])
  })

  test("marks built-in ids native and tolerates a minimal agent", () => {
    const build = Agent.fromV2(AgentV2.Info.empty(AgentV2.ID.make("build")))
    expect(build.name).toBe("build")
    expect(build.native).toBe(true)
    expect(build.mode).toBe("all")
    expect(build.permission).toEqual([])
    expect(build.model).toBeUndefined()
    expect(build.prompt).toBeUndefined()
    expect(build.options).toEqual({})
  })
})
