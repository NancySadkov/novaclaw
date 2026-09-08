import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ConfigAgent } from "@novaclaw/core/config/agent"

// Every field of the agent CONFIG reaches the agent RECORD, or is deliberately excluded.
//
// 🔴 Written after walking into the trap it guards, the same day it was written down as a lesson.
// `directory` was added to `ConfigAgent.Info` and never mapped in `applyItem`, so a colleague
// configured to work on a project silently kept working in its scratch — the config stored the field,
// the API returned no such key, and nothing failed. That is the third hand-kept projection of this
// schema to go stale in one session (the clone's carried set and the roster loader were the others).
//
// ⚠️ A SOURCE ledger, because `applyItem` maps field-by-field onto a DIFFERENT shape and cannot be
// derived: the two schemas overlap but are not the same, and several config keys are consumed rather
// than copied. What can be checked mechanically is that no key is simply forgotten.

const APPLY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "config", "plugin", "agent.ts")
const source = readFileSync(APPLY, "utf8")

/**
 * Keys `applyItem` handles WITHOUT a plain `agent.<key> = item.<key>` line, each with its reason.
 * A new entry here is a decision; a new entry that is missing is a silent drop.
 */
const CONSUMED: Record<string, string> = {
  model: "parsed into `agent.model` as {providerID, id} — a shape change, not a copy",
  variant: "folded into `agent.model.variant`, which only exists once a model does",
  request: "merged field-by-field into the existing headers/body rather than replaced",
  permissions: "PUSHED onto the ruleset, never assigned — order is the whole semantics",
  disabled:
    "PAUSES the agent (`agent.paused = true`) rather than being copied — it used to remove the agent " +
    "from the draft entirely, which bypassed every guarantee of `agent/retire.ts`",
}

describe("no config field is silently dropped on the way to the agent record", () => {
  test("every key is either assigned or listed as consumed, with a reason", () => {
    const missing = Object.keys(ConfigAgent.Info.fields).filter((key) => {
      if (key in CONSUMED) return false
      return !source.includes(`item.${key} !== undefined`)
    })
    expect(missing).toEqual([])
  })

  test("each consumed key really is handled, just not by assignment", () => {
    // Guards the other direction: a key parked in CONSUMED with no handling at all would read as
    // deliberate while behaving exactly like the bug.
    for (const key of Object.keys(CONSUMED))
      expect({ key, handled: source.includes(key) }).toEqual({ key, handled: true })
  })

  test("NEGATIVE CONTROL: the detector recognises an unmapped field", () => {
    // Without this the assertion above passes just as happily on a source file it failed to read.
    expect(source.includes("item.nosuchfield !== undefined")).toBe(false)
    expect(source.includes("item.directory !== undefined")).toBe(true)
  })
})
