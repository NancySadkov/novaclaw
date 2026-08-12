import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * 🔴 Ingestion used to CHUNK AND STORE, and that was all: 202 passages written with
 * `name: <document label>`, no entity, no edges. Measured on a real store — 280 nodes, **22 edges**,
 * 63 distinct names across 280 nodes ("EDDS rules" ×102). The graph view was drawn as though a
 * knowledge graph existed behind it.
 *
 * A SOURCE ledger because ORDER is the correctness property and it is invisible once the store is
 * written: an edge needs both endpoints to exist, so the document entity must be written before the
 * passages, and each passage before its own edge.
 */
const body = () => {
  const source = readFileSync(
    path.join(import.meta.dir, "../src/server/routes/instance/httpapi/handlers/memory.ts"),
    "utf8",
  )
  const start = source.indexOf('"ingest",')
  const end = source.indexOf('"clearScope",', start)
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe("document ingestion builds a connected graph", () => {
  test("the document entity is written BEFORE the passages that link to it", () => {
    const source = body()
    const entity = source.indexOf('kind: "entity"')
    const passage = source.indexOf('kind: "passage"')
    expect(entity).toBeGreaterThan(0)
    expect(passage).toBeGreaterThan(entity)
  })

  test("every passage gets a part_of edge to its document, pointing the right way", () => {
    const source = body()
    const edge = source.indexOf('type: "part_of"')
    expect(edge).toBeGreaterThan(source.indexOf('kind: "passage"'))
    const region = source.slice(source.lastIndexOf("addEdge", edge), edge + 80)
    // A reversed edge still "connects", which is why the endpoints are pinned rather than counted.
    expect(region).toContain("from: id")
    expect(region).toContain("to: documentID")
  })

  test("the document id comes from the SHARED entityID, not a local formula", () => {
    // ⚠️ The regression this exists for: a second formula mints a second node for one name, and the
    // graph re-fragments exactly where the entity layer was supposed to join it.
    expect(body()).toContain("KbChunk.entityID(scope, label)")
  })
})
