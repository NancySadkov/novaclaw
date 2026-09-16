import { describe, expect, test } from "bun:test"
import { ContextTemplate } from "./context-template"
import { SystemAccounting } from "./runner/system-accounting"

/**
 * THE CONTEXT TEMPLATE IS THE SINGLE SOURCE, and these pin the properties the rest of the system
 * relies on instead of re-deriving.
 *
 * 🔴 Owner, 2026-09-16: *"Hardcoding this is both error prone, impedes maintenance and obscures
 * mechanism from the user and the agents… Context management is very important and its code needs to be
 * perfect architecturally. Since any tiny mistake can lead to loss of gigabytes of memory and slow down
 * to halt."*
 *
 * The mistake that costs gigabytes is the VOLATILITY column. A per-turn value frozen into the epoch
 * baseline serves stale text forever; a per-turn value that SHOULD be frozen is instead re-rendered
 * every turn, which throws away the server's prefix cache for the whole history behind it — measured
 * once at 0.3s → 12.9s to first token. So the volatile/frozen split is asserted, not documented.
 */

describe("ContextTemplate — one list, and the order is the table's", () => {
  test("every slot name is unique across EVERY channel", () => {
    const names = ContextTemplate.SLOTS.map((slot) => slot.name)
    expect(new Set(names).size).toBe(names.length)
  })

  test("slot names are kebab-free identifiers a log line and a UI can both use", () => {
    for (const slot of ContextTemplate.SLOTS) {
      expect(slot.name).toMatch(/^[a-z][a-zA-Z0-9]*$/)
      // A purpose is required: it is the whole answer to "obscures mechanism from the user and the
      // agents". An empty one is a slot nobody can read.
      expect(slot.purpose.length).toBeGreaterThan(20)
    }
  })

  test("the system channel is the block order, and `composedBlocks` drops only the empty ones", () => {
    const names = ContextTemplate.systemSlotNames()
    expect(names.map(String)).toEqual(ContextTemplate.slotsIn("system").map((slot) => slot.name))
    // The order the runner has always had, restated as an expectation so a reorder is a visible diff
    // rather than a silent prompt change.
    expect([...names]).toEqual([
      "persona",
      "modelPrePrompt",
      "expertiseHint",
      "taxonomyHint",
      "systemPromptOverride",
      "agentIdentity",
      "agentSystem",
      "organization",
      "toolDiscovery",
      "perception",
      "delegation",
      "memoryStance",
      "projectScope",
      "workspace",
      "base",
      "goal",
    ])
    const parts = { persona: "P", goal: "", base: "B" }
    // ⚠️ `""` composes nothing — the non-empty predicate is stated once, in the template. An empty
    // block would otherwise be a slot the model reads and learns nothing from, on every turn.
    expect(ContextTemplate.composedBlocks(parts)).toEqual(["persona", "base"])
    // And `systemBlocks` keeps the table's order for the parts it was given, absent or not.
    expect(ContextTemplate.systemBlocks({ base: "B", persona: "P" }).map((part) => part.block)).toEqual([...names])
  })

  test("the tail is a SEPARATE channel and never leaks into the system parts", () => {
    // 🔴 The first version of this module mapped `SystemPromptParts` over EVERY slot name, so the tail
    // became system blocks. The compose ledger caught it by demanding `memoryRecall` and friends as
    // system blocks. This pins the separation directly, in both directions.
    const system = new Set<string>(ContextTemplate.systemSlotNames())
    for (const name of ContextTemplate.tailSlotNames()) expect(system.has(name)).toBe(false)
    expect([...ContextTemplate.tailSlotNames()]).toEqual([
      "projectGrounding",
      "memoryRecall",
      "todoReminder",
      "toolCatalogueUpdate",
      "maxSteps",
    ])
  })
})

describe("ContextTemplate — VOLATILITY, the column that costs gigabytes when it is wrong", () => {
  test("🔴 exactly ONE slot is epoch-frozen, and it is `base`", () => {
    // Nothing else may be frozen: an `epoch` slot's text is stored WITH the epoch row and reused
    // verbatim, so freezing a per-turn value serves stale text until the next replacement — while
    // unfreezing `base` re-renders the environment, instructions, skills index and catalogue on every
    // turn and throws away the prefix cache behind them. Both directions of that mistake are silent.
    const frozen = ContextTemplate.SLOTS.filter((slot) => slot.volatility === "epoch").map((slot) => slot.name)
    expect(frozen).toEqual(["base"])
  })

  test("every other slot is per-turn, and `compaction` is declared but unused", () => {
    for (const slot of ContextTemplate.SLOTS.filter((entry) => entry.volatility !== "epoch"))
      expect(slot.volatility).toBe("turn")
    // ⚠️ `compaction` is the value the durable area needs (owner: *"updated only after compaction, from
    // the housekeeped shadow copy"*). It has no slot YET, and this line is the record: when the durable
    // slot lands it must carry `compaction`, not `turn`, or a mid-run `durable_set` churns the prefix.
    //
    // ⚠️ Widened to the declared `Volatility` on purpose. Comparing the literal table directly is a TYPE
    // ERROR ("'epoch' | 'turn' and 'compaction' have no overlap") — the compiler proving the same fact,
    // which is nice, but it means the assertion must go through the declared vocabulary to state it.
    const declared: readonly ContextTemplate.Volatility[] = ContextTemplate.SLOTS.map((slot) => slot.volatility)
    expect(declared.filter((value) => value === "compaction")).toEqual([])
  })

  test("the tool schemas are the `tools` channel, never prose in the system prompt", () => {
    // The separation that stops "add a line about tools" from meaning two things in two files. Only the
    // tool-ish SYSTEM slot is `toolDiscovery`.
    expect(ContextTemplate.slotsIn("tools")).toEqual([])
    const systemNames = ContextTemplate.systemSlotNames() as readonly string[]
    expect(systemNames.filter((name) => name.toLowerCase().includes("tool"))).toEqual(["toolDiscovery"])
    expect(ContextTemplate.slotsIn("messages")).toEqual([])
  })
})

describe("ContextTemplate — the tail builder", () => {
  test("emits the table's order and SKIPS absent slots", () => {
    const items = ContextTemplate.tailMessages({
      maxSteps: "steps",
      projectGrounding: "ground",
      // memoryRecall and todoReminder deliberately absent
    })
    // Table order, not the order handed in; absent slots contribute nothing rather than an empty entry.
    expect(items).toEqual(["ground", "steps"])
  })

  test("an empty-string item is KEPT here, because the tail's emptiness rule is the caller's", () => {
    // ⚠️ Deliberate asymmetry with the system blocks: the system's non-empty rule exists because an empty
    // block is pure cost, while a tail entry is an already-built message. `undefined` is the only
    // "absent" the builder knows, so a caller that must not send an empty message says so by passing
    // `undefined` — one rule per layer, both stated.
    expect(ContextTemplate.tailMessages({ todoReminder: "" })).toEqual([""])
  })
})

describe("ContextTemplate — legibility (the complaint this module answers)", () => {
  test("`describe()` names every slot with its channel and volatility", () => {
    const text = ContextTemplate.describe()
    for (const slot of ContextTemplate.SLOTS) {
      expect(text).toContain(slot.name)
      expect(text).toContain(slot.volatility)
    }
    expect(text.split("\n")).toHaveLength(ContextTemplate.SLOTS.length)
    // It is data in, text out — no environment, no I/O — so a UI panel and a log line can both render it.
    expect(ContextTemplate.describe()).toBe(text)
  })

  test("the ACCOUNTING instrument derives from this table, so the two cannot drift", () => {
    // `SystemAccounting.BLOCKS` used to be a hand-written second list and was already stale when it was
    // replaced by a derivation. This pins that it still is one.
    expect([...SystemAccounting.BLOCKS]).toEqual([...ContextTemplate.systemSlotNames()])
  })
})
