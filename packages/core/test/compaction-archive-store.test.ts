import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { MemoryClient } from "@novaclaw/core/kb-graph/memory-client"
import { SessionCompactionArchive } from "@novaclaw/core/session/compaction-archive"
import type { SessionMessage } from "@novaclaw/core/session/message"

// The archive END TO END against a memory store: plan the passages a compaction would write, put
// them in, and get them back by SEARCH — which is the only thing that matters, because "the agent
// can locate and datamine it later" is a claim about retrieval, not about storage.
//
// ⚠️ **What this does NOT prove**: that a live compaction calls it. That needs a conversation big
// enough to overflow a real model's window, and is still owed (`notes/named-agents.md`). This closes
// the half that can be closed here — the plan → store → search loop, including the scope isolation
// the roster promises.

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const user = (text: string): SessionMessage.Message => ({ type: "user", text }) as unknown as SessionMessage.Message
const at = new Date("2026-08-21T14:32:11Z")

const transcript = [
  user("The crimson ledger is stored in the attic cupboard, third shelf."),
  user("The auditor is Mrs Pelham, and she visits on Thursdays."),
]

describe("a compacted conversation, stored and found again", () => {
  test("passages land in the colleague's OWN scope and come back by search", async () => {
    const memory = MemoryClient.stub()
    const passages = SessionCompactionArchive.plan({ messages: transcript, title: "Ledger notes", at })
    expect(passages.length).toBeGreaterThan(0)

    for (const passage of passages)
      await run(
        memory.addMemory({
          id: passage.id,
          kind: "passage",
          text: passage.text,
          name: passage.label,
          scope: "agent:archivist",
        }),
      )

    // The question a colleague would actually ask months later, when recall alone came up short.
    const hits = await run(memory.search({ query: "crimson", scopes: ["agent:archivist"] }))
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.map((hit) => hit.text).join(" ")).toContain("attic cupboard")
    expect(hits[0]!.name).toBe("Ledger notes · 2026-08-21")
  })

  test("another colleague cannot find it — the archive is inside the partition, not beside it", async () => {
    const memory = MemoryClient.stub()
    for (const passage of SessionCompactionArchive.plan({ messages: transcript, title: "Ledger notes", at }))
      await run(
        memory.addMemory({
          id: passage.id,
          kind: "passage",
          text: passage.text,
          name: passage.label,
          scope: "agent:archivist",
        }),
      )

    // The negative that gives the positive its meaning: an archived conversation is the most personal
    // thing a colleague holds, and a roster that partitioned recall but not archives would leak the
    // whole transcript.
    expect(await run(memory.search({ query: "crimson", scopes: ["agent:trader"] }))).toEqual([])
    expect(await run(memory.search({ query: "crimson", scopes: ["global"] }))).toEqual([])
  })

  test("re-archiving an overlapping window adds nothing", async () => {
    const memory = MemoryClient.stub()
    const write = async () => {
      for (const passage of SessionCompactionArchive.plan({ messages: transcript, title: "Ledger notes", at }))
        await run(
          memory.addMemory({
            id: passage.id,
            kind: "passage",
            text: passage.text,
            name: passage.label,
            scope: "agent:archivist",
          }),
        )
    }
    await write()
    const first = (await run(memory.stats())).total
    // Compaction runs again and the windows overlap — the ids are derived from label+text, so the
    // engine dedupes by primary key. This is what lets the archive run on EVERY cycle without
    // tracking what it already wrote.
    await write()
    expect((await run(memory.stats())).total).toBe(first)
  })
})
