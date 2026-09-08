import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WasmMemory } from "../src/kb-graph/wasm-engine"

/**
 * TWO WAYS THIS STORE USED TO LIE, and the engine is driven for real in both.
 *
 * 1. A fatal WASM abort latched `dead` — whose own doc promises that "every later call must fail
 *    immediately … rather than queue behind a lock that will never release" — and no operation ever
 *    read it. The lock is a promise chain, so the first statement issued against the dead module
 *    never settled and held the lock for every later call in the process. Auto-recall's
 *    `memory.search` has no timeout, so one abort wedged every subsequent turn of every session.
 *
 * 2. `invalidate`/`purge` ran their `SET`/`DETACH DELETE` without reading the result. A `MATCH` that
 *    binds nothing is not an error, so a caller erasing a memory it may not see was told the erase
 *    happened — the `Forgotten` event fired, the access-ledger rows went, and the `kb` tool answered
 *    "Purged … — no history kept." about text that is still in the graph.
 *
 * ⚠️ **The deadline here is the test's OWN, on the LIVE clock, and that is the point.** The defect
 * is a hang, so leaning on the harness's timeout would report it as "the file timed out" — a signal
 * that looks identical to a slow WASM boot. `withDeadline` fails with a sentence naming the op, and
 * the elapsed assertion below proves the call did not merely finish *eventually*.
 */

const DIM = 8

/** Await `work`, but reject with a NAMED failure if it has not settled within `ms` (live clock). */
const withDeadline = async <T>(work: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const bomb = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms — it is hanging`)), ms)
  })
  try {
    return await Promise.race([work, bomb])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const settled = (work: Promise<unknown>): Promise<unknown> => work.then((value) => value, (error) => error)

describe("a dead engine refuses, promptly, and names the fault that killed it", () => {
  let dir: string
  let mem: WasmMemory
  let realConn: unknown

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "kb-dead-"))
    mem = await WasmMemory.open(join(dir, "graph"), { dim: DIM })
    await mem.addMemory({ id: "m1", kind: "entity", name: "One", text: "a thing", scope: "global" })

    /**
     * A CORPSE, not a mock of one. The connection is swapped for one that reproduces the two halves
     * of the measured wedge: `CHECKPOINT` throws emscripten's real abort text (so the production
     * `EngineFault.isFatal` → `dead = deadMessage(...)` path is what marks the store, not the test),
     * and every other statement NEVER SETTLES — which is exactly what a statement issued against an
     * aborted module does, and what makes the lock unreleasable.
     */
    const hang = () => new Promise<never>(() => {})
    realConn = (mem as unknown as { conn: unknown }).conn
    ;(mem as unknown as { conn: unknown }).conn = {
      query: (cypher: string) => {
        if (/^\s*CHECKPOINT/i.test(cypher))
          throw new Error(`Aborted(Assertion failed: pthread mutex deadlock detected, at fs.c:0)`)
        return hang()
      },
      prepare: () => hang(),
      execute: () => hang(),
      close: () => {},
    }
    // The real fatal path: persist → CHECKPOINT → isFatal → dead. Called directly rather than through
    // `flush()` so the assertion does not depend on whether the 1s snapshot debounce happened to have
    // already fired and cleared `dirty`.
    await (mem as unknown as { persist: () => Promise<void> }).persist()
  }, 180_000)

  afterAll(async () => {
    ;(mem as unknown as { conn: unknown }).conn = realConn
    await mem?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test("🔴 the fatal abort actually latched — otherwise the rest proves nothing", () => {
    expect((mem as unknown as { dead: string | undefined }).dead).toContain("the graph engine died")
  })

  test("🔴 search on a dead engine FAILS FAST instead of hanging on the lock forever", async () => {
    const started = Date.now()
    const outcome = await withDeadline(settled(mem.search({ query: "a thing", k: 5 })), 5_000, "search")
    const elapsed = Date.now() - started
    expect(outcome).toBeInstanceOf(Error)
    // It names the ORIGINAL fault, not "engine closed": the first message explains all the rest.
    expect(String((outcome as Error).message)).toContain("the graph engine died")
    expect(String((outcome as Error).message)).toContain("Aborted(")
    // Well inside the deadline — a call that merely finished eventually would still be the wedge.
    expect(elapsed).toBeLessThan(1_000)
  }, 30_000)

  test("a mutation and a read both refuse, and the lock is not consumed by either", async () => {
    for (const [label, op] of [
      ["addMemory", () => mem.addMemory({ id: "m2", kind: "entity", text: "later", scope: "global" })],
      ["stats", () => mem.stats()],
      ["purge", () => mem.purge("m1")],
      ["list", () => mem.list({ limit: 5 })],
      // The one public op that does not go through `serialize`, so it carries its own latch.
      ["stagedScopes", () => mem.stagedScopes("agent:")],
    ] as const) {
      const outcome = await withDeadline(settled(op()), 5_000, label)
      expect(outcome).toBeInstanceOf(Error)
      expect(String((outcome as Error).message)).toContain("the graph engine died")
    }
  }, 30_000)
})

describe("a refused erase says so, and the row is still there", () => {
  let dir: string
  let mem: WasmMemory
  const BOB = ["global", "session:bob"]
  const ALICE = ["global", "session:alice"]

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "kb-erase-"))
    mem = await WasmMemory.open(join(dir, "graph"), { dim: DIM })
    await mem.addMemory({ id: "alice", kind: "entity", name: "Alice's", text: "ALICE ONLY", scope: "session:alice" })
    await mem.addMemory({ id: "bob", kind: "entity", name: "Bob's", text: "BOB ONLY", scope: "session:bob" })
    await mem.addMemory({ id: "bob2", kind: "entity", name: "Bob's other", text: "BOB ONLY", scope: "session:bob" })
  }, 180_000)

  afterAll(async () => {
    await mem?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const present = async (id: string) =>
    (await mem.list({ includeInvalid: true, limit: 100 })).some((row) => row.id === id)

  test("🔴 purging across the scope boundary is REFUSED, and the text stays in the store", async () => {
    const outcome = (await settled(mem.purge("alice", { scopes: BOB }))) as Error
    expect(outcome).toBeInstanceOf(Error)
    expect(outcome.message).toContain(`refused to purge "alice"`)
    expect(outcome.message).toContain("nothing was erased")
    expect(await present("alice")).toBe(true)
  }, 30_000)

  test("🔴 invalidating across the scope boundary is REFUSED, and nothing was invalidated", async () => {
    const before = await mem.stats()
    const outcome = (await settled(mem.invalidate("alice", undefined, { scopes: BOB }))) as Error
    expect(outcome).toBeInstanceOf(Error)
    expect(outcome.message).toContain(`refused to forget "alice"`)
    expect((await mem.stats()).valid).toBe(before.valid)
  }, 30_000)

  test("an id that is in NO scope is refused too — a bogus id is not a successful erase", async () => {
    const outcome = (await settled(mem.purge("no_such_id"))) as Error
    expect(outcome).toBeInstanceOf(Error)
    expect(outcome.message).toContain("No memory with that id is in the store")
  }, 30_000)

  /**
   * ⚠️ Half a control. A guard that refuses everything passes every test above, so the erases that
   * SHOULD work are asserted in the same file — refusal proven without the product still working is
   * a containment test that has shown nothing.
   */
  test("…and an erase the caller may make still succeeds and still reports success", async () => {
    await mem.purge("bob", { scopes: BOB })
    expect(await present("bob")).toBe(false)

    const before = await mem.stats()
    await mem.invalidate("alice", undefined, { scopes: ALICE })
    const after = await mem.stats()
    expect(after.valid).toBe(before.valid - 1)
    expect(after.total).toBe(before.total) // invalidate keeps history; purge does not
  }, 30_000)
})
