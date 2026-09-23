import { describe, expect, test } from "bun:test"
import { ConfigAgent } from "@novaclaw/core/config/agent"
import { createStore } from "solid-js/store"
import { copiedFields, NOT_COPIED, planSettingsCopy } from "./agent-settings-copy"

const prototype = {
  model: "spark-holo/holo3.1",
  reasoningModel: "spark-holo/holo-think",
  variant: "thinking",
  permissionMode: "plan",
  strict: { enabled: true, attempts: 3, wallMinutes: 20 },
  introspection: { enabled: true, cadence: 5 },
  affective: { enabled: true, temperature: 0.4 },
  quality: true,
  contextBudget: false,
  surgicalEdits: true,
  reasoningBudget: 2048,
  maxToolTimeoutMs: 90_000,
  tools: { bash: false },
  adhocTools: [{ name: "mine", description: "Officer-only", manual: "run" }],
  nudges: [{ id: "n1", name: "Slow down", enabled: true, hook: { type: "tool-call", tool: "bash" }, text: "Breathe." }],
  needsTaxonomy: "smart",
  toolLabels: false,
  operationMode: "unattended",
  workerPrototype: "iris",
  maxWorkers: 10,
  spawnDepth: 2,
  runtimeHeartbeatMinutes: 30,
  // Identity and work — must NEVER cross.
  name: "Scout",
  title: "Talent Scout",
  system: "Find people. Never hire without a trial.",
  goal: "Staff the night shift.",
  directory: "/data/scouting",
  avatar: "🔭",
  superior: "nova",
  kind: "agent",
  shortChat: false,
  memory: "own",
  archiveChats: true,
  color: "accent",
  description: "Finds people",
}

describe("what a settings copy carries", () => {
  test("tuning rides along — model, harness detail, horizon, workers", () => {
    const copy = planSettingsCopy({ prototypeID: "scout", targetID: "theron", source: prototype })
    expect(copy.prototypeID).toBe("scout")
    expect(copy.fragment).toMatchObject({
      model: "spark-holo/holo3.1",
      permissionMode: "plan",
      strict: { enabled: true, attempts: 3, wallMinutes: 20 },
      introspection: { enabled: true, cadence: 5 },
      affective: { enabled: true, temperature: 0.4 },
      tools: { bash: false },
      operationMode: "unattended",
      maxWorkers: 10,
    })
  })

  test("NOT the identity or the work — the target stays itself", () => {
    const copy = planSettingsCopy({ prototypeID: "scout", targetID: "theron", source: prototype })
    for (const key of [
      "name",
      "title",
      "system",
      "goal",
      "directory",
      "avatar",
      "superior",
      "kind",
      "shortChat",
      "memory",
      "archiveChats",
      "color",
      "description",
    ])
      expect(copy.fragment[key], key).toBeUndefined()
  })

  test("private lists are flagged for confirm — replacing them destroys", () => {
    const copy = planSettingsCopy({ prototypeID: "scout", targetID: "theron", source: prototype })
    expect(copy.replacesLists).toEqual(["nudges", "adhocTools"])
    const scalars = planSettingsCopy({
      prototypeID: "scout",
      targetID: "theron",
      source: { model: "a/b", strict: { enabled: true } },
    })
    expect(scalars.replacesLists).toEqual([])
    expect(scalars.fragment).toMatchObject({ model: "a/b" })
  })

  test("absent on the prototype stays absent — it never clears the target", () => {
    const copy = planSettingsCopy({ prototypeID: "scout", targetID: "theron", source: { model: "a/b" } })
    expect(copy.fragment["strict"]).toBeUndefined()
    expect(copy.fragment["tools"]).toBeUndefined()
  })

  test("the fragment is a copy, not an alias — mutating it spares the source", () => {
    const [store] = createStore({ agents: { scout: prototype } })
    const copy = planSettingsCopy({ prototypeID: "scout", targetID: "theron", source: store.agents.scout })
    ;(copy.fragment["strict"] as { attempts: number }).attempts = 99
    expect((prototype.strict as { attempts: number }).attempts).toBe(3)
    expect(copy.fragment["nudges"]).toEqual(prototype.nudges)
  })
})

describe("every config field is tuning or deliberately excluded", () => {
  test("the schema minus NOT_COPIED is exactly the copied set", () => {
    const schema = Object.keys(ConfigAgent.Info.fields).sort()
    const accounted = [...copiedFields(), ...Object.keys(NOT_COPIED)].sort()
    expect(accounted).toEqual(schema)
  })

  test("each exclusion states its reason", () => {
    for (const [field, why] of Object.entries(NOT_COPIED)) {
      expect(typeof why, field).toBe("string")
      expect((why as string).length).toBeGreaterThan(10)
    }
    expect(Object.keys(ConfigAgent.Info.fields).length).toBeGreaterThan(10)
  })

  test("NEGATIVE CONTROL: the work really would have crossed without the exclusion", () => {
    // Without this the identity test above passes just as happily on a source that never
    // carried a job — the exclusion would be vacuous.
    expect(prototype.system).toMatch(/\S/)
    expect(prototype.directory).toMatch(/\S/)
    const copy = planSettingsCopy({ prototypeID: "scout", targetID: "theron", source: prototype })
    expect(copy.fragment["system"]).toBeUndefined()
    expect(copy.fragment["directory"]).toBeUndefined()
  })
})
