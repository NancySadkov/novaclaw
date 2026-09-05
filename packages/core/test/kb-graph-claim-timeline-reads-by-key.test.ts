import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WasmMemory } from "../src/kb-graph/wasm-engine"

/**
 * TWO MORE WAYS THIS STORE ANSWERED WITHOUT KNOWING, both of the shape the engine already documents.
 *
 * 1. **A body read through a TRAVERSAL is not a body read by key.** `hydrate`'s own doc records the
 *    measurement: on the owner's store a scan found text on 64 of 745 rows, and 40 of 40 rows it
 *    called empty came back complete through `MATCH (m:Memory {id: $id})`. `neighbors` and `list`
 *    obey it — the traversal picks the rows, the bodies come back by key. The claim timeline's
 *    evidence pass did not: it projected `b.text` out of the relationship traversal and used it as
 *    the source label. So the one surface whose entire job is *"why is this claim here"* rendered
 *    blank labels, with no way to tell a source that has no description from one the engine failed
 *    to project.
 *
 * 2. **A `MATCH` that binds nothing is not an error.** `setEmbedding` ran its `SET` without reading
 *    the result, so a memory forgotten between `pendingEmbeddings` and the write was reported as
 *    embedded. The drain's whole purpose is that a memory stored before an embedding device existed
 *    eventually gets a vector; a no-op answering success is indistinguishable from that happening.
 *
 * ⚠️ **The pathology is INJECTED, not waited for.** It reproduces on a large real store about a
 * second after a write and not at all on a fresh one, so a test that merely wrote rows and read them
 * back would be green on both the fixed and the broken code — which is the same as no test. The
 * double below blanks `text` for every read that is NOT a primary-key lookup, which is exactly the
 * behaviour `hydrate` was written against, and it is installed AFTER the writes so the store being
 * queried is a real, intact one.
 */

const DIM = 8

describe("the claim timeline's evidence labels come back by key", () => {
  let dir: string
  let mem: WasmMemory
  let claimID: string
  let realRows: (cypher: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>[]>

  type Internals = {
    rows: (cypher: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>[]>
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "kb-timeline-"))
    mem = await WasmMemory.open(join(dir, "graph"), { dim: DIM })
    const written = await mem.addClaim({
      scope: "global",
      statement: "Ann works at Acme",
      subject: "Ann",
      predicate: "employer",
      evidence: [{ kind: "file", locator: "/notes/ann.md" }],
    })
    expect(written.ok).toBe(true)
    claimID = written.id!

    // Now — and only now — make every non-key read lose the long string, the way the real store does.
    const internals = mem as unknown as Internals
    realRows = internals.rows.bind(mem)
    internals.rows = async (cypher, params) => {
      const rows = await realRows(cypher, params)
      if (/MATCH \(m:Memory \{id: \$id\}\)/.test(cypher)) return rows
      return rows.map((row) => ("text" in row ? { ...row, text: "" } : row))
    }
  }, 180_000)

  afterAll(async () => {
    ;(mem as unknown as Internals).rows = realRows
    await mem?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test("🔴 the injected fault is real — a traversal DOES hand back an empty body here", async () => {
    const blanked = await (mem as unknown as Internals).rows(
      `MATCH (m:Memory) WHERE m.id = $wanted RETURN m.id AS id, m.text AS text`,
      { wanted: claimID },
    )
    expect(blanked).toHaveLength(1)
    expect(blanked[0]!.text).toBe("")
  }, 30_000)

  test("the evidence label survives it, because the traversal only picks the source", async () => {
    const history = await mem.claimHistory(claimID)
    expect(history).not.toBeNull()
    expect(history!.evidence).toHaveLength(1)
    const source = history!.evidence[0]!
    // The locator is what the timeline links; the label is the sentence a reader is shown.
    expect(source.locator).toBe("/notes/ann.md")
    expect(source.kind).toBe("file")
    expect(source.label.length).toBeGreaterThan(0)
    expect(source.label).toContain("/notes/ann.md")
  }, 30_000)

  test("the claim's own body comes back too — the double did not simply neuter the store", async () => {
    const history = await mem.claimHistory(claimID)
    expect(history!.claim.text).toBe("Ann works at Acme")
  }, 30_000)

  test("the embedding drain hydrates bodies by key instead of losing them in the scan", async () => {
    const pending = await mem.pendingEmbeddings(10)
    expect(pending.length).toBe(3)
    expect(pending.every((row) => row.text.length > 0)).toBe(true)
    expect(pending.find((row) => row.id === claimID)).toEqual({ id: claimID, text: "Ann works at Acme" })
  }, 30_000)
})

describe("attaching a vector to a memory that is gone REFUSES", () => {
  let dir: string
  let mem: WasmMemory
  const vec = (n: number) => Array.from({ length: DIM }, (_, i) => (i === 0 ? n : 0))

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "kb-embed-"))
    mem = await WasmMemory.open(join(dir, "graph"), { dim: DIM })
    await mem.addMemory({ id: "keep", kind: "entity", text: "still here", scope: "global" })
  }, 180_000)

  afterAll(async () => {
    await mem?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test("a live row is embedded and leaves the drain queue; a vanished one throws instead of lying", async () => {
    // PRESENCE first, so the refusal below is not "setEmbedding stopped working".
    expect((await mem.pendingEmbeddings(10)).map((row) => row.id)).toEqual(["keep"])
    await mem.setEmbedding("keep", vec(3))
    expect(await mem.pendingEmbeddings(10)).toEqual([])

    // …and ABSENCE. The drain read the row, the row was forgotten, and the write bound nothing.
    await mem.addMemory({ id: "ghost", kind: "entity", text: "about to go", scope: "global" })
    await mem.purge("ghost")
    await expect(mem.setEmbedding("ghost", vec(4))).rejects.toThrow(/no memory ghost/)
  }, 60_000)
})
