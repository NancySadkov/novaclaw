import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { MemoryClient } from "@novaclaw/core/kb-graph/memory-client"
import { MEMORY_EXPORT_PAGE_SIZE, eraseAllMemory, exportAllMemory } from "./memory"

const row = (id: number, scope = "global"): MemoryClient.MemoryRow => ({
  id: `mem_${id}`,
  kind: "episode",
  text: `memory ${id}`,
  name: null,
  scope,
  source: null,
  confidence: null,
  relation: "core",
  status: "active",
  subject: null,
  predicate: null,
  conflictKey: null,
  supersededBy: null,
  evidence: null,
  evidenceKind: null,
})

describe("the authoritative memory export and erase operations", () => {
  test("exhausts the 2,000-row store page and includes an older-only scope", async () => {
    const stored = Array.from({ length: MEMORY_EXPORT_PAGE_SIZE + 1 }, (_, index) =>
      row(index, index === MEMORY_EXPORT_PAGE_SIZE ? "session:older-only" : "global"),
    )
    const requested: MemoryClient.ListInput[] = []
    const exported = await Effect.runPromise(
      exportAllMemory(
        {
          list: (input = {}) => {
            requested.push(input)
            return Effect.succeed(stored.slice(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? 0)))
          },
        },
        true,
      ),
    )

    expect(exported).toHaveLength(MEMORY_EXPORT_PAGE_SIZE + 1)
    expect(exported.at(-1)?.scope).toBe("session:older-only")
    expect(requested).toEqual([
      { includeInvalid: true, limit: MEMORY_EXPORT_PAGE_SIZE, offset: 0 },
      { includeInvalid: true, limit: MEMORY_EXPORT_PAGE_SIZE, offset: MEMORY_EXPORT_PAGE_SIZE },
    ])
  })

  test("a page-two store fault fails the whole export instead of returning page one", async () => {
    const fault = new MemoryClient.MemoryError({ reason: "page two could not be read" })
    const error = await Effect.runPromise(
      exportAllMemory({
        list: (input = {}) =>
          (input.offset ?? 0) === 0
            ? Effect.succeed(Array.from({ length: MEMORY_EXPORT_PAGE_SIZE }, (_, index) => row(index)))
            : Effect.fail(fault),
      }).pipe(Effect.flip),
    )

    expect(error).toMatchObject({ _tag: "InvalidRequestError", message: "page two could not be read" })
  })

  test("returns the committed erase count exactly and maps an erase fault to the declared error", async () => {
    await expect(
      Effect.runPromise(eraseAllMemory({ eraseAll: () => Effect.succeed(MEMORY_EXPORT_PAGE_SIZE + 743) })),
    ).resolves.toBe(MEMORY_EXPORT_PAGE_SIZE + 743)

    const error = await Effect.runPromise(
      eraseAllMemory({
        eraseAll: () => Effect.fail(new MemoryClient.MemoryError({ reason: "erase transaction rolled back" })),
      }).pipe(Effect.flip),
    )
    expect(error).toMatchObject({ _tag: "InvalidRequestError", message: "erase transaction rolled back" })
  })
})
