import { expect, test } from "bun:test"
import { SessionWorkerRunnerLayer } from "./runner-layer"

test("isolated runner includes every registration boot node it consumes", () => {
  const names = new Set(SessionWorkerRunnerLayer.root.dependencies.map((node) => node.name))
  expect(names).toContain("plugin-internal")
  expect(names).toContain("system-context-builtins")
  expect(names).toContain("built-in-tools")
})
