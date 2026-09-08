import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ColleagueHandoff } from "@novaclaw/core/session/colleague-handoff"
import { AgentV2 } from "@novaclaw/core/agent"

/**
 * THE GOVERNING AGENT IS NOT RETIRABLE — AT THE SHARED IMPLEMENTATION, NOT ONE DOOR.
 *
 * AGENTS.md: *"the charter is not editable from inside. The user shapes their officers freely, but
 * Nova itself is not user-editable, renameable or deletable. An instance whose governing agent can
 * be neutered by a stray prompt has no floor to stand on."*
 *
 * The tool door checked, and that looked like enough. It is not: the colleague tool runs INSIDE THE
 * WORKER, so `mayStaff` and `isProtected` there are the worker's own checks on itself.
 * `session-worker/interaction-bridge` then asks the HOST to retire whoever the worker names, and the
 * host obeyed. A guard the guarded party applies to itself is not a guard.
 */

const removed: string[] = []
const parts = () =>
  ColleagueHandoff.fromParts({
    db: undefined as never,
    events: undefined as never,
    session: () => Effect.succeed({ agent: "nova" }),
    wake: () => Effect.succeed(true),
    store: {
      agents: () => Effect.succeed({}),
      removeAgent: (name: string) => Effect.sync(() => void removed.push(name)),
    } as never,
    refresh: Effect.void,
    takenNames: Effect.succeed([]),
    forget: (name) => Effect.sync(() => void removed.push(`forgot:${name}`)),
  })

describe("retiring through the SHARED implementation", () => {
  test("🔴 Nova is refused, and nothing is removed or forgotten", async () => {
    removed.length = 0
    expect(await Effect.runPromise(parts().retire(AgentV2.NOVA_ID))).toBe(false)
    // The half that matters: not merely "returned false", but that no store write happened. A guard
    // that answers no AFTER erasing the cabinet has protected nothing.
    expect(removed).toEqual([])
  })

  test("🔴 an ordinary colleague is still retired — the control", () => {
    removed.length = 0
    return Effect.runPromise(parts().retire("theron")).then((ok) => {
      expect(ok).toBe(true)
      expect(removed).toEqual(["theron", "forgot:theron"])
    })
  })

  test("the check is the shared protected set, not a local string", () => {
    // If `PROTECTED_IDS` ever grows a second entry, this door inherits it without being edited.
    expect(AgentV2.isProtected(AgentV2.NOVA_ID)).toBe(true)
    expect(AgentV2.isProtected("theron")).toBe(false)
  })
})
