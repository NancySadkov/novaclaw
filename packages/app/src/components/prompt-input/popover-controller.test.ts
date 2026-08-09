import { expect, test } from "bun:test"
import { atOptionKey, visibleAgentOptions } from "./popover-options"

test("agent suggestions exclude hidden and primary agents", () => {
  expect(
    visibleAgentOptions([
      { name: "worker", mode: "subagent" },
      { name: "hidden", mode: "subagent", hidden: true },
      { name: "primary", mode: "primary" },
    ]),
  ).toEqual([{ type: "agent", name: "worker", display: "worker" }])
})

test("suggestion keys preserve the agent/file namespace", () => {
  expect(atOptionKey({ type: "agent", name: "worker", display: "worker" })).toBe("agent:worker")
  expect(atOptionKey({ type: "file", path: "src/app.ts", display: "src/app.ts" })).toBe("file:src/app.ts")
})
