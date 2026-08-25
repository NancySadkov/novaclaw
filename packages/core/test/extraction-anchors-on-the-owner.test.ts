import { describe, expect, test } from "bun:test"
import { buildExchange } from "@novaclaw/core/session/runner/extract"
import { isPeerTurn } from "@novaclaw/core/session/steer-provenance"

/**
 * AUTO-EXTRACTION MUST NOT RECORD A COLLEAGUE'S WORDS AS THE USER'S.
 *
 * `extract.ts` already screens out harness STEERS, and its own B2 comment explains why: a steer
 * rides the user role, so anchoring on one handed the extractor the harness's instruction text and
 * every fact it produced was written to memory as a fact about the user, then promoted to a durable
 * GLOBAL twin by `consolidate()`.
 *
 * A delivered PEER MESSAGE rides the user role too — the door beside it, and the same laundering:
 * one colleague's question recorded as something the owner said, on every instance they federate
 * with. `compaction.ts` already asks the provenance question one module over.
 */

const owner = (text: string) => ({ type: "user" as const, text })
const colleague = (text: string, label = "theron") => ({
  type: "user" as const,
  text,
  origin: { via: "agent", relation: "peer", label },
})
const parent = (text: string) => ({
  type: "user" as const,
  text,
  origin: { via: "agent", relation: "parent", sessionID: "ses_boss" },
})

describe("what the extractor is told the user said", () => {
  test("🔴 a COLLEAGUE-anchored exchange extracts NOTHING", () => {
    expect(buildExchange([owner("I use dvorak"), colleague("what is the ledger balance?")] as never)).toBeUndefined()
  })

  test("🔴 the owner's own words still anchor normally — the control", () => {
    // Without this, a `buildExchange` that always returned undefined would pass the test above.
    expect(buildExchange([colleague("what is the balance?"), owner("I use dvorak")] as never)).toBe(
      "User: I use dvorak",
    )
  })

  test("⚠️ it does NOT reach back past the colleague to an older owner turn", () => {
    // The steer rule skips and keeps walking; this one must not. Attaching a colleague-driven
    // exchange to words the user said earlier is a subtler version of the same misattribution.
    expect(buildExchange([owner("I use dvorak"), colleague("and the ledger?")] as never)).toBeUndefined()
  })

  test("an empty transcript still extracts nothing", () => {
    expect(buildExchange([] as never)).toBeUndefined()
  })
})

describe("who counts as a colleague turn", () => {
  test("a peer message does", () => {
    expect(isPeerTurn(colleague("hi") as never)).toBe(true)
  })

  test("⚠️ a PARENT (sub-agent delegation) does not — it is not a colleague exchange", () => {
    // `relation` absent or "parent" means the pre-officer shape: a spawn/steer from the session that
    // owns this one. Widening the guard to those would silence extraction for every sub-agent.
    expect(isPeerTurn(parent("do the thing") as never)).toBe(false)
  })

  test("a plain owner turn does not, and neither does an assistant turn", () => {
    expect(isPeerTurn(owner("hello") as never)).toBe(false)
    expect(isPeerTurn({ type: "assistant", content: [] } as never)).toBe(false)
  })
})
