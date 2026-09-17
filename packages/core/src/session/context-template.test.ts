import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
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
      "agentSystem",
      "organization",
      "toolDiscovery",
      "perception",
      "delegation",
      "memoryStance",
      "projectScope",
      "base",
      "goal",
      // Materialised at a rewrite, immediately after the goal — the owner's own sketch puts the durable
      // area there (`<goal>`, `#DURABLE`, …).
      "durable",
      // 🔴 Owner, 2026-09-17: identity and the workspace pointer land LAST, immediately before the
      // transcript, in this order. They are the two facts the model must carry into the first user
      // message, and both are `turn`-volatile, so the end of the prompt is both the strongest recency
      // and the cheapest place to change.
      "agentIdentity",
      "workspace",
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

  test("🔴 the volatility column PARTITIONS the table: one frozen slot, one materialised, the rest per-turn", () => {
    // ⚠️ This test used to read *"every other slot is per-turn, and `compaction` is declared but
    // unused"*, and its own comment was the record: *"when the durable slot lands it must carry
    // `compaction`, not `turn`, or a mid-run `durable_set` churns the prefix"*. The slot landed
    // (owner, 2026-09-16), so the claim inverts — and it stays a claim about the WHOLE column rather
    // than about the one slot, because a SECOND `compaction` slot would be a second thing the runner
    // has to remember to refresh at a rewrite, which is the knowledge that must not live in two places.
    //
    // ⚠️ Widened to the declared `Volatility` on purpose. Comparing the literal table directly is a TYPE
    // ERROR ("'epoch' | 'turn' and 'compaction' have no overlap") — the compiler proving the same fact,
    // which is nice, but it means the assertion must go through the declared vocabulary to state it.
    const byVolatility = (volatility: ContextTemplate.Volatility) =>
      ContextTemplate.SLOTS.filter((slot) => slot.volatility === volatility).map((slot) => slot.name)
    expect(byVolatility("epoch")).toEqual(["base"])
    expect(byVolatility("compaction")).toEqual(["durable"])
    // The rest are per-turn, and asserting the COUNT is what makes a new slot declare itself: a slot
    // that is neither the frozen baseline nor materialised at a rebuild has to be recomputed every
    // turn, and a longer life than its producer can honour is the mistake this column exists to catch.
    expect(byVolatility("turn").length).toBe(ContextTemplate.SLOTS.length - 2)
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

describe("ContextTemplate — DETERMINISM: static arguments, static results", () => {
  /**
   * 🔴 Owner, 2026-09-16: *"please ensure that the template given static arguments, gives static
   * results - i.e. it is deterministic and respects the prefix cache."*
   *
   * This is not a nicety about tidy code. The prefix cache is decided by BYTES: a directive that
   * composes in a different order, or reads a clock, or picks up an environment variable, silently
   * changes the request's prefix and pays a full re-prefill of the history behind it — measured once at
   * 0.3s → 12.9s to first token. Nothing about that failure is visible in a passing test that only
   * checks content, so the determinism is asserted directly.
   */

  test("the same arguments produce byte-identical output, every time", () => {
    const parts = { persona: "P", agentSystem: "J", base: "B", goal: "G" }
    const once = JSON.stringify(ContextTemplate.systemBlocks(parts))
    const twice = JSON.stringify(ContextTemplate.systemBlocks(parts))
    expect(once).toBe(twice)
    expect(ContextTemplate.composedBlocks(parts)).toEqual(ContextTemplate.composedBlocks(parts))
    expect(ContextTemplate.describe()).toBe(ContextTemplate.describe())
  })

  test("🔴 the ORDER comes from the table, never from the argument object's key order", () => {
    // The failure this prevents: composing from `Object.entries(parts)` would make the prompt's order
    // depend on the order keys were SET, which differs between a test, a config walk and a reload — so
    // the same logical prompt would be a different prefix in different processes. The table decides, so
    // two objects with the same content and different insertion orders must be byte-identical.
    const a = ContextTemplate.composedBlocks({ persona: "P", base: "B", goal: "G" })
    const b = ContextTemplate.composedBlocks({ goal: "G", base: "B", persona: "P" })
    expect(a).toEqual(b)
    expect(JSON.stringify(ContextTemplate.systemBlocks({ persona: "P", base: "B" }))).toBe(
      JSON.stringify(ContextTemplate.systemBlocks({ base: "B", persona: "P" })),
    )
  })

  test("the tail is assembled from the table too, so its order cannot depend on insertion order", () => {
    const a = ContextTemplate.tailMessages({ maxSteps: 5, memoryRecall: 2, todoReminder: 3 })
    const b = ContextTemplate.tailMessages({ todoReminder: 3, memoryRecall: 2, maxSteps: 5 })
    expect(a).toEqual(b)
    expect(a).toEqual([2, 3, 5])
  })

  test("🔴 PURITY, as a source ratchet: the module reads nothing but its argument", () => {
    // A pass-through design boundary, not a style rule: any of these would make a "static argument"
    // produce a different request on the next call, and the diff would be invisible in a content
    // assertion. The check is on the SOURCE because the failure is one import away, in a file whose
    // tests would still pass.
    const source = readFileSync(new URL("./context-template.ts", import.meta.url), "utf8")
    for (const impure of [
      "Date.now",
      "new Date",
      "Math.random",
      "performance.now",
      "process.env",
      "crypto.randomUUID",
      "randomUUID",
      "setTimeout",
      "await ",
      "fetch(",
      "readFileSync",
    ])
      expect(source.includes(impure), `context-template.ts must not use ${impure}`).toBe(false)
    // And it imports NOTHING at all: no service, no clock, no filesystem. A pure table + pure helpers.
    expect(source).not.toMatch(/^import /m)
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
