import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GraphSnapshot } from "./snapshot"
import { EMPTY_GENERATION, WasmMemory } from "./wasm-engine"

/**
 * THE ENGINE HALF OF NC-REL-018: A DAMAGED NEWEST GENERATION MUST NOT COST THE STORE.
 *
 * `snapshot.test.ts` proves the file-set store falls back correctly. This proves the ENGINE uses it —
 * that a real Ladybug database whose newest snapshot has been corrupted reopens on the predecessor with
 * the user's memories intact, and that a store with nothing usable left still opens rather than failing
 * forever.
 *
 * ⚠️ Corruption is injected by overwriting bytes in the committed generation, which is exactly the
 * damage the OLD publisher produced by truncating a live file. The point is not that this particular
 * byte pattern breaks Ladybug — it is that whatever the engine does with it, the store survives.
 */

const DIM = 8
let root: string | undefined
let mem: WasmMemory | undefined

afterEach(async () => {
  await mem?.close()
  mem = undefined
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

const dir = () => {
  root = mkdtempSync(join(tmpdir(), "kb-recover-"))
  return join(root, "graph")
}
const texts = async (engine: WasmMemory, query: string) =>
  (await engine.search({ query, scopes: ["global"] })).map((hit) => hit.text).sort()

/** Two committed generations: the older holds `first`, the newer holds both. */
const seedTwoGenerations = async (path: string) => {
  const engine = await WasmMemory.open(path, { dim: DIM })
  await engine.addMemory({ id: "a", kind: "entity", text: "the older fact", scope: "global" })
  await engine.flush()
  await engine.addMemory({ id: "b", kind: "entity", text: "the newer fact", scope: "global" })
  await engine.flush()
  await engine.close()
  const gens = readdirSync(path).filter((n) => n.startsWith("g-")).sort()
  expect(gens.length).toBe(GraphSnapshot.KEEP)
  return gens
}

describe("reopening a healthy store", () => {
  test("memories survive a close and reopen, on the pointed generation", async () => {
    const path = dir()
    await seedTwoGenerations(path)
    mem = await WasmMemory.open(path, { dim: DIM })
    expect(await texts(mem, "fact")).toEqual(["the newer fact", "the older fact"])
    expect(mem.recovery.skipped).toEqual([])
    expect(mem.recovery.opened).toBe(GraphSnapshot.current(path)!)
  }, 120_000)
})

describe("a corrupt newest generation", () => {
  test("🔴 the store reopens on the PREDECESSOR instead of failing forever", async () => {
    const path = dir()
    await seedTwoGenerations(path)
    const newest = GraphSnapshot.current(path)!
    for (const file of readdirSync(join(path, newest)))
      if (file !== "MANIFEST") writeFileSync(join(path, newest, file), Buffer.alloc(64, 0x7a))

    mem = await WasmMemory.open(path, { dim: DIM })

    // The older fact is what the predecessor held. The newer one was only ever in the damaged
    // generation, so losing it is the bounded cost the debounce always implied.
    expect(await texts(mem, "fact")).toEqual(["the older fact"])
    expect(mem.recovery.skipped.map((skip) => skip.name)).toEqual([newest])
    expect(mem.recovery.opened).not.toBe(newest)
  }, 120_000)

  test("🔴 the damaged bytes are KEPT, not deleted", async () => {
    const path = dir()
    await seedTwoGenerations(path)
    const newest = GraphSnapshot.current(path)!
    writeFileSync(join(path, newest, "graph"), Buffer.alloc(64, 0x7a))

    mem = await WasmMemory.open(path, { dim: DIM })
    expect(mem.recovery.quarantined).toEqual([`quarantine-${newest}`])
    expect(existsSync(join(path, `quarantine-${newest}`, "graph"))).toBe(true)
  }, 120_000)

  test("🔴 bytes that VERIFY but will not OPEN are caught too — the branch the manifest cannot see", async () => {
    // ⚠️ Every other case here is rejected by the manifest before Ladybug is ever asked, so the
    // engine-rejection branch — which is the ORIGINAL NC-REL-018 damage — was untested until this.
    // Re-signing the manifest over the corrupt bytes is what forces the fallback to happen at OPEN.
    const path = dir()
    await seedTwoGenerations(path)
    const newest = GraphSnapshot.current(path)!
    const rubbish = Buffer.alloc(4096, 0x5a)
    writeFileSync(join(path, newest, "graph"), rubbish)
    const manifest = JSON.parse(readFileSync(join(path, newest, "MANIFEST"), "utf8")) as {
      files: { name: string; size: number; sha256: string }[]
      created: number
    }
    for (const entry of manifest.files)
      if (entry.name === "graph") {
        entry.size = rubbish.byteLength
        entry.sha256 = createHash("sha256").update(rubbish).digest("hex")
      }
    writeFileSync(join(path, newest, "MANIFEST"), Buffer.from(JSON.stringify(manifest)))
    // It verifies now — which is the precondition for this test meaning anything.
    expect(GraphSnapshot.read(GraphSnapshot.candidates(path)[0]!)).toBeDefined()

    mem = await WasmMemory.open(path, { dim: DIM })

    expect(await texts(mem, "fact")).toEqual(["the older fact"])
    expect(mem.recovery.skipped.map((skip) => skip.name)).toEqual([newest])
    // …and the reason is the ENGINE's, not the manifest's.
    expect(mem.recovery.skipped[0]!.reason).not.toBe("did not verify")
  }, 120_000)

  test("⚠️ the recovered store is WRITABLE, and its next publish is a real generation", async () => {
    // A store that opens read-only-in-practice would be a different outage wearing the same face.
    const path = dir()
    await seedTwoGenerations(path)
    const newest = GraphSnapshot.current(path)!
    writeFileSync(join(path, newest, "graph"), Buffer.alloc(64, 0x7a))

    mem = await WasmMemory.open(path, { dim: DIM })
    await mem.addMemory({ id: "c", kind: "entity", text: "written after recovery", scope: "global" })
    await mem.flush()
    await mem.close()
    mem = undefined

    const reopened = await WasmMemory.open(path, { dim: DIM })
    mem = reopened
    expect(await texts(reopened, "recovery")).toEqual(["written after recovery"])
    expect(reopened.recovery.skipped).toEqual([])
  }, 180_000)
})

describe("nothing usable left", () => {
  test("🔴 the engine still opens, empty, rather than failing on every retry", async () => {
    // Memory is a re-derivable tier, so an empty store is survivable — a permanently unopenable
    // directory is not. The old code had no branch between them.
    const path = dir()
    await seedTwoGenerations(path)
    for (const gen of readdirSync(path).filter((n) => n.startsWith("g-")))
      for (const file of readdirSync(join(path, gen)))
        if (file !== "MANIFEST") writeFileSync(join(path, gen, file), Buffer.alloc(64, 0x7a))

    mem = await WasmMemory.open(path, { dim: DIM })
    expect(mem.recovery.opened).toBe(EMPTY_GENERATION)
    expect(mem.recovery.skipped.length).toBe(GraphSnapshot.KEEP)
    // …and it works.
    await mem.addMemory({ id: "d", kind: "entity", text: "a fresh start", scope: "global" })
    expect(await texts(mem, "fresh")).toEqual(["a fresh start"])
  }, 180_000)
})

describe("the pre-generation layout on disk", () => {
  test("🔴 a store written by the OLD publisher still opens, and is retired into a generation", async () => {
    // The upgrade path. Flattening a real generation reproduces exactly what the old code left behind:
    // the db files loose in the directory, no pointer and no manifest.
    const path = dir()
    await seedTwoGenerations(path)
    const newest = GraphSnapshot.current(path)!
    const flat = mkdtempSync(join(root!, "flat-"))
    for (const file of readdirSync(join(path, newest)))
      if (file !== "MANIFEST") renameSync(join(path, newest, file), join(flat, file))
    rmSync(path, { recursive: true, force: true })
    mkdirSync(path, { recursive: true })
    for (const file of readdirSync(flat)) renameSync(join(flat, file), join(path, file))

    mem = await WasmMemory.open(path, { dim: DIM })

    expect(await texts(mem, "fact")).toEqual(["the newer fact", "the older fact"])
    // The loose files are gone: a stale flat `graph` beside generations is a second store waiting to
    // be opened by accident.
    expect(existsSync(join(path, "graph"))).toBe(false)
    expect(GraphSnapshot.current(path)).toBeDefined()
  }, 180_000)
})
