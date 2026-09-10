import { describe, expect, test } from "bun:test"
import path from "node:path"
import { ConfigAgent } from "@novaclaw/core/config/agent"
import { Scratch } from "@novaclaw/core/scratch"
import { cloneAgent, clonedFields, NOT_CLONED, NovaCloneRefusal, planClone } from "./agent-clone"
import type { AgentLike } from "./contacts"

const source: AgentLike = {
  id: "theron",
  system: "Own the books. Never move money without approval.",
  name: "Theron",
  title: "Bookkeeper",
  personality: "Blunt. Shows the arithmetic.",
  avatar: "📒",
  memory: "own",
  mode: "primary",
  hidden: false,
}

describe("what a clone inherits", () => {
  test("Nova cannot be cloned through planning or persistence", async () => {
    const nova: AgentLike = { ...source, id: "nova", name: "Nova" }
    expect(() => planClone({ source: nova, taken: [], random: () => 0 })).toThrow(NovaCloneRefusal)
    let wrote = false
    await expect(
      cloneAgent({
        source: nova,
        roster: [nova],
        random: () => 0,
        updateConfig: async () => {
          wrote = true
        },
      }),
    ).rejects.toThrow("deploy a separate NovaClaw instance")
    expect(wrote).toBe(false)
  })

  test("every surface writes the same planned clone patch", async () => {
    const writes: unknown[] = []
    const clone = await cloneAgent({
      source,
      roster: [source, { id: "alexios", name: "Alexios", mode: "primary", hidden: false }],
      random: () => 0,
      updateConfig: async (patch) => {
        writes.push(patch)
      },
    })
    expect(writes).toEqual([{ agents: { [clone.id]: clone.fragment } }])
    expect(clone.id).not.toBe("alexios")
  })

  test("the BRIEF — job, personality, face, memory setting", () => {
    const clone = planClone({ source, taken: [], random: () => 0 })
    expect(clone.fragment).toMatchObject({
      // The standing BRIEF is the substance of the copy: a clone with the job title and none of the
      // instructions is a colleague that looks the same and behaves differently. Measured live on
      // 2026-08-21 — the first clone carried no `system` because the loader never read it.
      system: "Own the books. Never move money without approval.",
      title: "Bookkeeper",
      personality: "Blunt. Shows the arithmetic.",
      avatar: "📒",
      memory: "own",
      mode: "primary",
    })
  })

  test("NOT the identity — a fresh id and a fresh name from the pool", () => {
    // A copy that kept the id would share the original's memory scope and its chat: a second Theron
    // that remembers work it never did. The id is the whole separation.
    const clone = planClone({ source, taken: [], random: () => 0 })
    expect(clone.id).not.toBe("theron")
    expect(clone.name).not.toBe("Theron")
    expect(clone.fragment["name"]).toBe(clone.name)
  })

  test("the name avoids every name already in the roster, ids and display names alike", () => {
    // Two colleagues shown as the same name are indistinguishable in a hand-off line even when their
    // ids differ, which is the confusion the pool exists to prevent.
    const first = planClone({ source, taken: [], random: () => 0 })
    const second = planClone({ source, taken: [first.id, first.name], random: () => 0 })
    expect(second.id).not.toBe(first.id)
  })

  test("an absent field stays absent rather than becoming an empty string", () => {
    // "No title" and "a blank title" are different facts, and the roster renders them differently.
    // ⚠️ Genuinely bare: a source carrying `hidden: false` is carrying a VALUE, and the clone takes it
    // — which is the point of the derived set. Only what the source does not have stays away.
    const bare = { id: "kallias", mode: "primary" } as unknown as AgentLike
    const clone = planClone({ source: bare, taken: [], random: () => 0 })
    expect(Object.keys(clone.fragment).sort()).toEqual(["mode", "name"])
  })

  test("a clone of a colleague is a colleague, never staff", () => {
    // Without an explicit mode the fragment would take the store's default, and a roster entry that
    // silently became a sub-agent would vanish from the list the user just cloned it in.
    const bare: AgentLike = { id: "kallias", mode: "primary", hidden: false }
    expect(planClone({ source: bare, taken: [], random: () => 0 }).fragment["mode"]).toBe("primary")
  })

  test("a throwaway's memory setting is inherited too", () => {
    const joe: AgentLike = { id: "crashtest-joe", memory: "none", mode: "primary", hidden: false }
    expect(planClone({ source: joe, taken: [], random: () => 0 }).fragment["memory"]).toBe("none")
  })

  test("the BEHAVIOUR fields come too — model, archiving, step budget", () => {
    // 🔴 Measured 2026-08-21: the carried set was a hand-written array that had drifted from the
    // schema, and a clone silently dropped all four of these. A colleague tuned to a capable model
    // cloned into one running the default; a colleague told NOT to archive its chats cloned into one
    // that does. Neither is visible to the user until the copy behaves differently from the original.
    // ⚠️ The API SHAPE, which is what the roster actually holds — an object with the variant nested.
    // The first version of this test used the config's string and passed while the live path wrote an
    // object into a string field; a fixture that is not the real shape tests the fixture.
    const tuned = {
      ...source,
      model: { providerID: "spark-holo", id: "holo3.1", variant: "high" },
      archiveChats: false,
      color: "#ff0000",
      steps: 12,
      description: "Keeps the books.",
    } as unknown as AgentLike
    expect(planClone({ source: tuned, taken: [], random: () => 0 }).fragment).toMatchObject({
      model: "spark-holo/holo3.1",
      variant: "high",
      archiveChats: false,
      color: "#ff0000",
      steps: 12,
      description: "Keeps the books.",
    })
  })

  test("the CONFIG BAG wins over the rendered view — it is the whole brief", () => {
    // 🔴 Measured 2026-08-21, after the clone's own field list was already fixed: the ROSTER LOADER is
    // a second hand-written projection, and it did not carry `steps`, so a clone still lost the step
    // budget. Two hand-kept lists in series go stale twice and blame the wrong file. `config` is
    // derived from the schema at the loader, and the clone reads it in preference to the view object.
    const viewOnly = { ...source, title: "Rendered title" } as unknown as AgentLike
    const withBag = {
      ...viewOnly,
      config: { title: "Real title", steps: 12, system: "You keep the books.", mode: "primary" },
    } as unknown as AgentLike
    expect(planClone({ source: withBag, taken: [], random: () => 0 }).fragment).toMatchObject({
      title: "Real title",
      steps: 12,
    })
    // …and with no bag it still works, so a caller that has only the view is not broken.
    expect(planClone({ source: viewOnly, taken: [], random: () => 0 }).fragment["title"]).toBe("Rendered title")
  })

  test("false and 0 survive — a falsy value is a SETTING, not an absence", () => {
    // The old loop copied only non-empty strings, booleans and numbers, so this passed by accident.
    // Stated on purpose now: `archiveChats: false` is the whole point of the field.
    const off = { ...source, archiveChats: false, hidden: false } as unknown as AgentLike
    const fragment = planClone({ source: off, taken: [], random: () => 0 }).fragment
    expect(fragment["archiveChats"]).toBe(false)
    expect(fragment["hidden"]).toBe(false)
  })
})

// The ledger that keeps the two in step. A hand-kept subset of a schema that grows is a list that is
// wrong the first time somebody adds a field, and says nothing when it happens.
describe("every config field is carried or deliberately excluded", () => {
  test("no field of ConfigAgent.Info is unaccounted for", () => {
    const schema = Object.keys(ConfigAgent.Info.fields).sort()
    const accounted = [...clonedFields(), ...Object.keys(NOT_CLONED)].sort()
    expect(accounted).toEqual(schema)
  })

  test("each exclusion carries its REASON, not just its name", () => {
    // A deny-list of bare keys decays into "somebody must have had a reason"; the reason is the thing
    // a later reader needs in order to change it.
    for (const [field, why] of Object.entries(NOT_CLONED)) {
      expect({ field, hasReason: why.length > 12 }).toEqual({ field, hasReason: true })
    }
  })

  test("NEGATIVE CONTROL: the schema really does expose its keys", () => {
    // Without this the comparison above would pass forever on an empty set.
    expect(Object.keys(ConfigAgent.Info.fields).length).toBeGreaterThan(10)
    expect(clonedFields()).toContain("model")
  })
})

// 🔴 A clone inherits the brief and NONE of the identity. The roster hands back a RESOLVED record, so
// two fields arrive in the bag looking authored while being derived from the SOURCE: its avatar route
// and the materialized scratch grant inside `permissions`. Measured on a live instance 2026-09-10 —
// this is the writer that gave `geryon` Daedalus's portrait and `…/scratch/daedalus/*`, which read as
// "the agent cannot write its own folder" and, in the other direction, as one officer holding a write
// grant into another's private workspace.
describe("a clone carries no identity artifacts forward", () => {
  // Built from the REAL scratch root rather than a literal, so the strip is exercised on a path it
  // can actually recognize. A fixture under a made-up username passes by accident, not by design.
  const other = path.join(Scratch.forAgent("daedalus"), "*").replaceAll("\\", "/")
  const resolved = (id: string): AgentLike =>
    ({
      id,
      name: "Daedalus",
      title: "Engineer",
      mode: "primary",
      // The shape only the agent.list handler emits: a route rebuilt from the SOURCE's id, with the
      // portrait's content hash appended.
      avatar: "/api/agent/daedalus/avatar?v=65337e00",
      description: "Daedalus, Engineer.",
      directory: "C:\\Users\\nangl\\d\\code\\llm",
      permissions: [
        { action: "external_directory_read", resource: other, effect: "allow" },
        { action: "external_directory_write", resource: other, effect: "allow" },
        { action: "external_directory_write", resource: "*", effect: "ask" },
      ],
    }) as unknown as AgentLike

  test("a derived avatar route does not cross the identity boundary", () => {
    const clone = planClone({ source: resolved("daedalus"), taken: [], random: () => 0 })
    expect(clone.fragment["avatar"]).toBeUndefined()
    expect(JSON.stringify(clone.fragment)).not.toContain("daedalus/avatar")
  })

  test("an AUTHORED avatar still carries — the rule is derived, not absent", () => {
    const authored = { ...resolved("daedalus"), avatar: "📒" } as unknown as AgentLike
    expect(planClone({ source: authored, taken: [], random: () => 0 }).fragment["avatar"]).toBe("📒")
  })

  test("stripping the source's scratch grant is PAIRED with granting the clone's own", () => {
    const clone = planClone({ source: resolved("daedalus"), taken: [], random: () => 0 })
    const text = JSON.stringify(clone.fragment["permissions"])
    // Both halves, or the fix is a refusal wearing a security patch.
    expect(text).not.toContain("scratch/daedalus")
    expect(text).toContain(`scratch/${clone.id}`)
  })

  test("the source's CHECKOUT does not cross — a clone starts in its own scratch", () => {
    const clone = planClone({ source: resolved("daedalus"), taken: [], random: () => 0 })
    expect(clone.fragment["directory"]).toBeUndefined()
    expect(JSON.stringify(clone.fragment)).not.toContain("code\\llm")
    // Dropping it is not a downgrade, and that claim is not load-bearing on this test: with no
    // `directory`, `AgentWorkspace.folderFor` resolves the colleague to `Scratch.forAgent(id)`, which
    // `packages/core/test/agent-workspace.test.ts` already pins. The clone is productive on turn one.
  })

  test("NEGATIVE CONTROL: the source really carried a directory, so the exclusion is not vacuous", () => {
    expect((resolved("daedalus") as unknown as { directory?: string }).directory).toBeTruthy()
    // And it is excluded by NAME with a stated reason, not by the field quietly missing from the schema.
    expect(NOT_CLONED.directory).toMatch(/\S/)
  })

  test("NEGATIVE CONTROL: the source really carried a scratch grant, so the strip is not vacuous", () => {
    const carried = (resolved("daedalus") as unknown as { permissions: { resource: string }[] }).permissions
    expect(carried.some((rule) => rule.resource.endsWith("scratch/daedalus/*"))).toBe(true)
    // And the clone's id is a real drawn name, or `scratch/${clone.id}` would assert nothing.
    expect(planClone({ source: resolved("daedalus"), taken: [], random: () => 0 }).id.length).toBeGreaterThan(2)
  })
})
