import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

test("the instance graph builds the worker capacity listener", () => {
  const graph = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "src",
    "server",
    "routes",
    "instance",
    "httpapi",
    "server.ts",
  )
  const source = readFileSync(graph, "utf8")
  expect(source).toContain("AgentWorkerCapacity.node,")
  expect(source.indexOf("AgentWorkerCapacity.node,")).toBeGreaterThan(source.indexOf("SessionProjector.node,"))
})
