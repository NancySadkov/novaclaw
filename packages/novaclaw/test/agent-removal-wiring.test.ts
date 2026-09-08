import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// The instance graph REGISTERS the removal retirement.
//
// 🔴 Same split, same hazard as `reassignment-wiring.test.ts`, and written at the same time as the
// defect it guards. `AgentRemoval` puts detection at the config-write door — which is a global-scope
// STORE module with no memory client — and the action wherever the memory engine lives. A node
// nobody builds means a colleague removed through `POST /api/config/remove` keeps its private
// cabinet, and the next colleague drawn on that pooled id inherits a stranger's memories.
//
// ⚠️ Unit tests cannot see this: each registers its own listener before announcing. Only a check on
// the PRODUCT graph can say whether anything is listening in the thing that ships.

const source = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "server",
    "routes",
    "instance",
    "httpapi",
    "server.ts",
  ),
  "utf8",
)

describe("the instance graph carries the removal retirement", () => {
  test("the node is in the list, not merely imported", () => {
    // Importing without listing is the exact shape that shipped for reassignment: the symbol
    // resolved, the typecheck passed, and nothing built the layer.
    expect(source).toContain("AgentRemoval.node,")
  })

  test("it is imported from the module that owns the rule", () => {
    expect(source).toContain('from "@novaclaw/core/agent/removal"')
  })

  test("it sits beside the reassignment node — both are config-door listeners", () => {
    const removal = source.indexOf("AgentRemoval.node,")
    const reassignment = source.indexOf("AgentReassignment.node,")
    expect(removal).toBeGreaterThan(0)
    expect(reassignment).toBeGreaterThan(0)
    // Adjacent, so a reader who finds one finds the other. Two listeners on one door that live in
    // different parts of a 400-line graph is how the second one gets forgotten.
    expect(Math.abs(source.slice(0, removal).split("\n").length - source.slice(0, reassignment).split("\n").length)).
      toBeLessThan(12)
  })
})
