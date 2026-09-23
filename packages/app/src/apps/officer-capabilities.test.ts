import { expect, test } from "bun:test"
import { officerCapabilities, withComputerUse, withToolOverride } from "./officer-capabilities"

test("officer capability settings use one projection and preserve unrelated rules", () => {
  const otherRule = { action: "write", resource: "/books/*", effect: "deny" }
  const computerRule = { action: "computer", resource: "*", effect: "deny" }
  const capabilities = officerCapabilities({
    permissionMode: "plan",
    maxWorkers: 4,
    spawnDepth: 2,
    workerModel: "local/fast",
    tools: { bash: false },
    permissions: [otherRule, computerRule],
  })

  expect(capabilities.permissionMode).toBe("plan")
  expect(officerCapabilities({ permissionMode: "ask" }).permissionMode).toBe("ask")
  expect(capabilities.maxWorkers).toBe(4)
  expect(capabilities.spawnDepth).toBe(2)
  expect(capabilities.workerModel).toBe("local/fast")
  expect(capabilities.computerUse).toBe(false)
  expect(withComputerUse(capabilities.rules, true)).toEqual([otherRule])
  expect(withComputerUse(capabilities.rules, false)).toEqual([otherRule, computerRule])
  expect(withToolOverride(capabilities.tools, "bash")).toEqual({})
})

test("missing capability settings resolve to shipped defaults", () => {
  expect(officerCapabilities(undefined)).toMatchObject({
    permissionMode: "bypass",
    maxWorkers: 100,
    spawnDepth: 1,
    computerUse: true,
    tools: {},
    rules: [],
  })
})
