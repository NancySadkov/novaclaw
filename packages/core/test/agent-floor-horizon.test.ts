import { describe, expect, test } from "bun:test"
import { AgentPlugin } from "@novaclaw/core/plugin/agent"
import { whollyDisabled } from "@novaclaw/core/tool/registry"

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

  test("`colleague` DOES withdraw, which is what the difference looks like", () => {
    // The same floor, one action apart. `colleague` denies non-officers on `*`, so the tool leaves
    // their horizon entirely — 2,078 measured bytes a turn (see `plugin/agent.ts`). Reading these two
    // side by side is the clearest statement of what a resource scope decides.
    expect(whollyDisabled("colleague", floorFor(true))).toBe(false)
    expect(whollyDisabled("colleague", floorFor(false))).toBe(true)
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
