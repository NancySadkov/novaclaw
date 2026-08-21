import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// The instance graph REGISTERS the reassignment delivery.
//
// 🔴 Written after this exact gap shipped. `AgentReassignment` splits detection (the config-write
// door) from delivery (wherever the sessions are), and the delivery node was hung off
// `SessionV2.node` — which this server's graph never builds. So a folder change wrote the config,
// announced to nobody, and the colleague was never told. Measured 2026-08-21 by driving a real
// `PATCH /config`: the chat stayed empty.
//
// ⚠️ **Every unit test passed throughout**, because each registered a listener of its own before
// announcing. Nothing asserted that the PRODUCT registers one. A split like this needs a test on
// each half AND one on the join, or the halves can both be right while the feature does nothing.

const GRAPH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "server",
  "routes",
  "instance",
  "httpapi",
  "server.ts",
)
const source = readFileSync(GRAPH, "utf8")

describe("the instance graph carries the reassignment delivery", () => {
  test("the node is in the list, not merely imported", () => {
    // Importing without listing is precisely the shape that shipped: the symbol resolved, the
    // typecheck passed, and nothing built the layer.
    expect(source).toContain("AgentReassignment.node,")
  })

  test("it sits with the other session-side nodes it needs", () => {
    // It resolves Database and EventV2 — the same graph that owns `SessionProjector`. If this node
    // ever moves to a graph without them, the layer fails to build rather than silently no-op, but
    // the ordering here is what keeps it beside its dependencies where a reader will find it.
    const projector = source.indexOf("SessionProjector.node,")
    const reassignment = source.indexOf("AgentReassignment.node,")
    expect(projector).toBeGreaterThan(-1)
    expect(reassignment).toBeGreaterThan(projector)
  })

  test("NEGATIVE CONTROL: the reader is looking at the real graph", () => {
    // Without this the assertions above would pass just as happily on a file that failed to load.
    expect(source).toContain("SessionProjector.node,")
    expect(source).not.toContain("AgentReassignment.nosuchnode")
  })
})
