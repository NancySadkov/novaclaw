import { describe, expect, test } from "bun:test"
import { AgentPlugin } from "@novaclaw/core/plugin/agent"
import { whollyDisabled } from "@novaclaw/core/tool/registry"
import { evaluate } from "@novaclaw/core/permission"

/**
 * WHAT A FLOOR'S DENY ACTUALLY DOES TO THE MODEL'S HORIZON.
 *
 * 🔴 A permission rule has two quite different effects and the rule itself does not say which you get.
 * `ToolRegistry.materialize` withdraws a tool from the horizon — the model never learns its name —
 * only when the LAST rule matching its action reads `resource: "*"` with `deny`. A deny on a narrower
 * resource still refuses the call, but the model reads the tool every turn and pays for its schema
 * before being told no.
 *
 * That distinction was asserted in a comment beside the floor on 2026-08-22 and was WRONG: the
 * non-officer `spawn` deny had been written on `resource: "inherit"`, which withdraws nothing, while
 * the comment claimed it kept the tool off the horizon. It cost nothing at runtime and would have
 * cost every non-officer turn the schema bytes the comment said were saved. So the claim is driven
 * through the real predicate here instead of restated.
 */

const floorFor = (officer: boolean) => AgentPlugin.floor({ scratchDirs: [], officer })

describe("the officer floor and the model's horizon", () => {
  test("an officer KEEPS spawn on its horizon — it has a use for it", () => {
    // The grant is on `inherit`, which is deliberately not `*`, so this also proves that a narrow
    // ALLOW does not accidentally withdraw the tool it grants.
    expect(whollyDisabled("spawn", floorFor(true))).toBe(false)
  })

  test("a non-officer is NOT withdrawn from spawn — it is refused on use, and that is a known cost", () => {
    // 🔴 Stated because it is a real cost, not because it is ideal: a non-officer reads `spawn` in
    // its horizon every turn and pays for its schema, then gets refused. Withdrawing it would need a
    // `{ spawn, *, deny }` on the floor — which would also take the tool off `build`, the agent a
    // person drives interactively. That is a product decision, and the honest state until somebody
    // makes it is "advertised and refused", recorded here rather than papered over in a comment.
    expect(whollyDisabled("spawn", floorFor(false))).toBe(false)
  })

  test("🔴 `colleague` is on EVERY horizon — officer, non-officer, and worker alike", () => {
    // INVERTED, owner 2026-09-27, and the inversion is the finding.
    //
    // This used to read *"`colleague` DOES withdraw, which is what the difference looks like"* and
    // assert `whollyDisabled("colleague", floorFor(false)) === true` — a deliberate, documented
    // withdrawal of the hand-off tool from every non-officer. It was defended with a measured number
    // (2,078 bytes a turn) and it was, on the live instance, the thing that stopped an officer from
    // reporting to their superior.
    //
    // The denial was safe to remove because the org chart was never expressed in it.
    // `ColleagueRoute.route` already redirected a worker's message to its parent, refused
    // self-address, let Nova reach anyone, and redirected anything off-tier to the sender's superior.
    // The deny arm could only refuse; it could never deliver, so it added a failure mode and no
    // safety.
    expect(whollyDisabled("colleague", floorFor(true))).toBe(false)
    expect(whollyDisabled("colleague", floorFor(false))).toBe(false)
    // Asserted on the VERDICT as well as the horizon, because the two are different claims and only
    // the first was ever the point: a tool can be on the horizon and still be refused on use.
    expect(evaluate("colleague", "*", floorFor(false)).effect).toBe("allow")
    // And the grant is unconditional rather than merely present, so no later layer can quietly turn
    // an officer back into a non-officer for this one action.
    expect(floorFor(false)).toContainEqual({ action: "colleague", resource: "*", effect: "allow" })
  })

  test("🔴 the `officer` dial no longer decides `colleague` — it is a FLOOR difference now", () => {
    // The dial still widens `spawn`/`kill`/`computer`, and the negative control below still covers
    // the predicate. What must not come back is `colleague` reading differently between the two
    // floors, because that asymmetry is the whole defect.
    const spread = (rules: readonly { action: string }[]) => new Set(rules.map((rule) => rule.action))
    expect(spread(floorFor(false)).has("colleague")).toBe(true)
    expect(spread(floorFor(true)).has("colleague")).toBe(true)
    // …while the dial still means something, so this is not "the officer floor is gone".
    expect(spread(floorFor(true)).has("spawn")).toBe(true)
    expect(spread(floorFor(false)).has("spawn")).toBe(false)
  })

  // 🔴 THE NEGATIVE CONTROL, and the reason this file exists. Write the deny the way it was written
  // first and the predicate says "still on the horizon" — a silent, invisible difference between what
  // the floor does and what its comment said it did.
  test("NEGATIVE CONTROL: a deny on a narrow resource withdraws nothing", () => {
    expect(whollyDisabled("spawn", [{ action: "spawn", resource: "inherit", effect: "deny" }])).toBe(false)
    expect(whollyDisabled("spawn", [{ action: "spawn", resource: "*", effect: "deny" }])).toBe(true)
  })

  test("a user's later rule still wins — the floor is a floor, not a lock", () => {
    // `findLast`: appending IS overriding. A user who wants their `build` agent spawning says so in
    // config and the tool comes back onto the horizon.
    expect(whollyDisabled("spawn", [...floorFor(false), { action: "spawn", resource: "*", effect: "allow" }])).toBe(
      false,
    )
  })
})

// ────────────────────────────────────────────────────────────────────────────────────────────────
// COMPUTER USE: granted to officers in the floor, switched off per officer by a narrowing rule.
// Owner directive 2026-09-10. Two things are asserted, because they are different claims: the
// VERDICT (does the real predicate allow the bind resource the tool actually asserts) and the
// HORIZON (does the opt-out take the schema off the model's turn, or just refuse it).
// ────────────────────────────────────────────────────────────────────────────────────────────────
describe("computer use is opt-out per officer", () => {
  const BIND = "bind-windows-app/novaclaw.exe"

  test("an officer is allowed the bare action AND the bind resource it asserts", () => {
    const ruleset = floorFor(true)
    expect(evaluate("computer", "*", ruleset).effect).toBe("allow")
    // The second assert is the one that bit us: `tool/computer.ts` asserts the action twice, and a
    // grant written on a narrow resource passes the first and refuses the second.
    expect(evaluate("computer", BIND, ruleset).effect).toBe("allow")
  })

  test("a non-officer is refused, exactly as it was before officers were granted anything", () => {
    // No rule at all, so it falls through to `ask`, which the assert path resolves to a denial.
    expect(evaluate("computer", BIND, floorFor(false)).effect).toBe("ask")
  })

  test("the opt-out is a `deny` on `*`: it refuses AND withdraws the tool from the horizon", () => {
    const optedOut = [...floorFor(true), { action: "computer" as const, resource: "*", effect: "deny" as const }]
    expect(evaluate("computer", BIND, optedOut).effect).toBe("deny")
    expect(whollyDisabled("computer", optedOut)).toBe(true)
  })

  test("NEGATIVE CONTROL: a deny narrower than `*` would refuse without withdrawing", () => {
    // This is the shape the opt-out must NOT be written in — the model would pay ~2 KB of schema
    // every turn for a capability it cannot use. Proves the `*` above is load-bearing, not decorative.
    const narrow = [...floorFor(true), { action: "computer" as const, resource: BIND, effect: "deny" as const }]
    expect(evaluate("computer", BIND, narrow).effect).toBe("deny")
    expect(whollyDisabled("computer", narrow)).toBe(false)
  })
})
