import { describe, expect, test } from "bun:test"
import { AgentV2 } from "../agent"
import { WorkerProfile } from "./worker-profile"

describe("anonymous worker profiles", () => {
  test("snapshots role and model choices without carrying authority or memory", () => {
    const profile = WorkerProfile.capture({
      ...AgentV2.Info.empty(AgentV2.ID.make("prototype")),
      system: "Find evidence.",
      model: { providerID: "local", id: "worker-4b" } as never,
      reasoningModel: { providerID: "local", id: "reasoner-32b" } as never,
      memory: "own",
      superior: AgentV2.ID.make("nova"),
      permissions: [{ action: "bash", effect: "allow", resource: "*" }],
    })

    expect(profile).toMatchObject({
      prototypeID: "prototype",
      model: "local/worker-4b",
      reasoningModel: "local/reasoner-32b",
    })
    expect(profile).not.toHaveProperty("memory")
    expect(profile).not.toHaveProperty("permissions")
    expect(profile).not.toHaveProperty("superior")
    expect(WorkerProfile.config(profile)).not.toHaveProperty("id")
  })

  test("only reads a versioned snapshot from a child session", () => {
    const stored = WorkerProfile.capture({
      ...AgentV2.Info.empty(AgentV2.ID.make("prototype")),
    })
    expect(WorkerProfile.read({ metadata: { [WorkerProfile.KEY]: stored } })).toBeUndefined()
    expect(WorkerProfile.read({ parentID: "parent", metadata: { [WorkerProfile.KEY]: stored } })).toMatchObject({
      prototypeID: "prototype",
    })
  })

  test("an absent prototype choice stays sparse so the spawning officer remains the base", () => {
    const stored = WorkerProfile.capture({
      ...AgentV2.Info.empty(AgentV2.ID.make("prototype")),
      strict: { enabled: true },
    })
    const recipe = WorkerProfile.config(stored)

    expect(recipe).not.toHaveProperty("model")
    expect(recipe).not.toHaveProperty("reasoningModel")
    expect({ model: "local/officer-4b", permissionMode: "ask", ...recipe }).toMatchObject({
      model: "local/officer-4b",
      permissionMode: "ask",
      strict: { enabled: true },
    })
  })
})
