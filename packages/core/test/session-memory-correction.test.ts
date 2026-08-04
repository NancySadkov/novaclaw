import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import os from "node:os"
import path from "node:path"
import { MemoryClient } from "@novaclaw/core/kb-graph/memory-client"
import { MemoryCorrection } from "@novaclaw/core/session/runner/memory-correction"

const hit = (id: string, text: string): MemoryClient.SearchHit => ({
  id,
  kind: "episode",
  text,
  name: "pi.c",
  scope: "global",
  source: "auto-extract",
  confidence: null,
  relation: "staged",
  score: 1,
})

const store = (memory: MemoryClient.Interface, row: MemoryClient.SearchHit) =>
  memory.addMemory({
    id: row.id,
    kind: row.kind,
    text: row.text,
    ...(row.name === null ? {} : { name: row.name }),
    scope: row.scope,
    ...(row.source === null ? {} : { source: row.source }),
    ...(row.confidence === null ? {} : { confidence: row.confidence }),
    relation: row.relation,
  })

describe("MemoryCorrection", () => {
  test("a failed read invalidates the recalled claim when its exact path is absent", async () => {
    const memory = MemoryClient.stub()
    const resolved = path.join(os.tmpdir(), `novaclaw-memory-missing-${crypto.randomUUID()}`, "pi.c")
    const stale = hit("mem_stale", `The file ${resolved} already implements the program.`)
    const unrelated = hit("mem_other", "The user prefers C99 for portable programs.")
    await Effect.runPromise(Effect.all([store(memory, stale), store(memory, unrelated)]))

    expect(
      await Effect.runPromise(
        MemoryCorrection.correctMissingRead({ memory, recalled: [stale, unrelated], requested: resolved, resolved }),
      ),
    ).toBe(1)
    expect(await Effect.runPromise(memory.stats())).toEqual({ total: 2, valid: 1 })
    expect((await Effect.runPromise(memory.search({ query: "portable" }))).map((row) => row.id)).toEqual(["mem_other"])
  })

  test("does not invalidate a memory when the read target still exists", async () => {
    const memory = MemoryClient.stub()
    const resolved = path.join(process.cwd(), "package.json")
    const recalled = hit("mem_existing", `The package is at ${resolved}.`)
    await Effect.runPromise(store(memory, recalled))

    expect(
      await Effect.runPromise(
        MemoryCorrection.correctMissingRead({ memory, recalled: [recalled], requested: resolved, resolved }),
      ),
    ).toBe(0)
    expect(await Effect.runPromise(memory.stats())).toEqual({ total: 1, valid: 1 })
  })

  test("does not invalidate unrelated recall merely because some path is absent", async () => {
    const memory = MemoryClient.stub()
    const resolved = path.join(os.tmpdir(), `novaclaw-memory-missing-${crypto.randomUUID()}`, "pi.c")
    const unrelated = hit("mem_other", "The user prefers C99 for portable programs.")
    await Effect.runPromise(store(memory, unrelated))

    expect(
      await Effect.runPromise(
        MemoryCorrection.correctMissingRead({ memory, recalled: [unrelated], requested: resolved, resolved }),
      ),
    ).toBe(0)
    expect(await Effect.runPromise(memory.stats())).toEqual({ total: 1, valid: 1 })
  })

  test("does not automatically invalidate a user-curated memory", async () => {
    const memory = MemoryClient.stub()
    const resolved = path.join(os.tmpdir(), `novaclaw-memory-missing-${crypto.randomUUID()}`, "pi.c")
    const curated = { ...hit("mem_curated", `A historical note cites ${resolved}.`), source: "user" }
    await Effect.runPromise(store(memory, curated))

    expect(
      await Effect.runPromise(
        MemoryCorrection.correctMissingRead({ memory, recalled: [curated], requested: resolved, resolved }),
      ),
    ).toBe(0)
    expect(await Effect.runPromise(memory.stats())).toEqual({ total: 1, valid: 1 })
  })
})
