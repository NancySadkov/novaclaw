import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GraphSnapshot } from "./snapshot"

/**
 * CRASH INJECTION BETWEEN THE PUBLISH STEPS — NC-REL-018.
 *
 * 🔴 The store this replaces wrote each file straight over its live path. The acceptance the hardening
 * plan asks for is: interrupt the publish at ANY step and a restart opens either the complete new
 * generation or the complete old one, never a mixture and never a directory that fails forever.
 *
 * ⚠️ Every fault below is injected by doing to the directory exactly what a dead process would have
 * left behind, rather than by killing anything. A test that has to kill a process to observe a
 * half-written directory can only inject the faults it manages to hit; this one injects the state.
 * The cost is that the mapping "this file state == that crash point" is an assumption, so each case
 * names the step it stands for.
 */

let root: string | undefined
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

const fresh = () => {
  root = join(mkdtempSync(join(tmpdir(), "gen-snap-")), "graph")
  return root
}
const bytes = (text: string) => Buffer.from(text)
const set = (...pairs: [string, string][]) => new Map(pairs.map(([n, v]) => [n, bytes(v)] as const))
const restored = (dir: string) => {
  const cands = GraphSnapshot.candidates(dir)
  for (const gen of cands) {
    const files = GraphSnapshot.read(gen)
    if (files) return { name: gen.name, files: Object.fromEntries([...files].map(([k, v]) => [k, v.toString()])) }
  }
  return undefined
}

describe("publishing generations", () => {
  test("a published generation reads back exactly", () => {
    const dir = fresh()
    const name = GraphSnapshot.publish(dir, set(["graph", "A"], ["graph.wal", "wal-A"]))
    expect(GraphSnapshot.current(dir)).toBe(name)
    expect(restored(dir)).toEqual({ name, files: { graph: "A", "graph.wal": "wal-A" } })
  })

  test("the predecessor is RETAINED, so there is something to fall back to", () => {
    const dir = fresh()
    const first = GraphSnapshot.publish(dir, set(["graph", "A"]))
    const second = GraphSnapshot.publish(dir, set(["graph", "B"]))
    expect(existsSync(join(dir, first))).toBe(true)
    expect(GraphSnapshot.current(dir)).toBe(second)
  })

  test("older generations are pruned — retention is bounded, not unbounded", () => {
    const dir = fresh()
    for (const value of ["A", "B", "C", "D"]) GraphSnapshot.publish(dir, set(["graph", value]))
    const gens = readdirSync(dir).filter((n) => n.startsWith("g-"))
    expect(gens.length).toBe(GraphSnapshot.KEEP)
    expect(restored(dir)?.files.graph).toBe("D")
  })

  test("a file that shrinks between generations does not leave the old bytes behind", () => {
    // The old publisher deleted leftovers from a SHARED directory. Generations are separate
    // directories, so this is structural — but a regression here would silently resurrect a stale WAL.
    const dir = fresh()
    GraphSnapshot.publish(dir, set(["graph", "A"], ["graph.wal", "wal"]))
    GraphSnapshot.publish(dir, set(["graph", "B"]))
    expect(restored(dir)?.files).toEqual({ graph: "B" })
  })
})

describe("a crash between the publish steps", () => {
  test("🔴 (1) after staging, before the manifest — the prior generation is what opens", () => {
    const dir = fresh()
    const good = GraphSnapshot.publish(dir, set(["graph", "A"]))
    // What a death mid-stage leaves: a staging directory with files and no manifest.
    const staging = join(dir, ".staging-999-7")
    mkdirSync(staging, { recursive: true })
    writeFileSync(join(staging, "graph"), bytes("B-partial"))

    expect(restored(dir)).toEqual({ name: good, files: { graph: "A" } })
  })

  test("🔴 (2) after the rename, before the pointer — A opens, and B is not silently preferred", () => {
    const dir = fresh()
    const good = GraphSnapshot.publish(dir, set(["graph", "A"]))
    // A complete, correctly-named generation that no pointer commits to.
    const orphan = join(dir, "g-000009")
    mkdirSync(orphan, { recursive: true })
    writeFileSync(join(orphan, "graph"), bytes("B"))
    writeFileSync(
      join(orphan, "MANIFEST"),
      JSON.stringify({ files: [{ name: "graph", size: 1, sha256: sha("B") }], created: 0 }),
    )

    // ⚠️ The pointer is the ONLY statement that a publish finished. An uncommitted generation is a
    // candidate, never the first one, so the answer here is A.
    expect(restored(dir)).toEqual({ name: good, files: { graph: "A" } })
  })

  test("🔴 (3) a generation whose manifest never landed is skipped, not opened", () => {
    const dir = fresh()
    const good = GraphSnapshot.publish(dir, set(["graph", "A"]))
    const half = join(dir, "g-000005")
    mkdirSync(half, { recursive: true })
    writeFileSync(join(half, "graph"), bytes("B-torn"))
    writeFileSync(join(dir, "CURRENT"), bytes("g-000005"))

    expect(restored(dir)).toEqual({ name: good, files: { graph: "A" } })
  })

  test("🔴 (4) a TRUNCATED file inside a committed generation fails verification", () => {
    // The exact damage the old design produced: `writeFileSync` truncated the live file and stopped.
    const dir = fresh()
    const good = GraphSnapshot.publish(dir, set(["graph", "A"]))
    const newer = GraphSnapshot.publish(dir, set(["graph", "BBBBBBBB"]))
    writeFileSync(join(dir, newer, "graph"), bytes("BB"))

    expect(restored(dir)).toEqual({ name: good, files: { graph: "A" } })
  })

  test("🔴 a file whose LENGTH is unchanged but whose bytes rotted is still caught", () => {
    // Size alone would pass this. The digest is what makes the manifest a check rather than a label.
    const dir = fresh()
    const good = GraphSnapshot.publish(dir, set(["graph", "AAAA"]))
    const newer = GraphSnapshot.publish(dir, set(["graph", "BBBB"]))
    writeFileSync(join(dir, newer, "graph"), bytes("BBXB"))

    expect(restored(dir)).toEqual({ name: good, files: { graph: "AAAA" } })
  })

  test("⚠️ a pointer naming a generation that is not there falls through to the newest that is", () => {
    const dir = fresh()
    const good = GraphSnapshot.publish(dir, set(["graph", "A"]))
    writeFileSync(join(dir, "CURRENT"), bytes("g-000042"))
    expect(restored(dir)).toEqual({ name: good, files: { graph: "A" } })
  })

  test("⚠️ an unreadable pointer is not fatal", () => {
    const dir = fresh()
    const good = GraphSnapshot.publish(dir, set(["graph", "A"]))
    writeFileSync(join(dir, "CURRENT"), Buffer.from([0xff, 0xfe, 0x00]))
    expect(restored(dir)?.name).toBe(good)
  })
})

describe("quarantine", () => {
  test("🔴 damaged bytes are KEPT, not deleted — recovery must stay diagnosable", () => {
    const dir = fresh()
    GraphSnapshot.publish(dir, set(["graph", "A"]))
    const bad = GraphSnapshot.publish(dir, set(["graph", "BBBB"]))
    writeFileSync(join(dir, bad, "graph"), bytes("XX"))

    const gen = GraphSnapshot.candidates(dir)[0]!
    expect(gen.name).toBe(bad)
    const held = GraphSnapshot.quarantine(dir, gen)!
    expect(readFileSync(join(dir, held, "graph")).toString()).toBe("XX")
  })

  test("🔴 quarantining RETRACTS the pointer that named it", () => {
    // Otherwise the next open resolves to a directory that has moved and falls back for the wrong
    // reason — which looks identical in a log to the damage itself.
    const dir = fresh()
    const good = GraphSnapshot.publish(dir, set(["graph", "A"]))
    const bad = GraphSnapshot.publish(dir, set(["graph", "B"]))
    GraphSnapshot.quarantine(dir, GraphSnapshot.candidates(dir)[0]!)

    expect(GraphSnapshot.current(dir)).toBeUndefined()
    expect(restored(dir)).toEqual({ name: good, files: { graph: "A" } })
    expect(bad).not.toBe(good)
  })

  test("⚠️ quarantine retention is bounded — damage does not accumulate forever", () => {
    const dir = fresh()
    for (const value of ["A", "B", "C", "D", "E", "F"]) {
      GraphSnapshot.publish(dir, set(["graph", value]))
      const newest = GraphSnapshot.candidates(dir)[0]!
      if (!newest.legacy) GraphSnapshot.quarantine(dir, newest)
    }
    expect(readdirSync(dir).filter((n) => n.startsWith("quarantine-")).length).toBeLessThanOrEqual(1)
  })
})

describe("the pre-generation layout", () => {
  test("🔴 loose files from the old design are still readable — an upgrade keeps the store", () => {
    const dir = fresh()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "graph"), bytes("legacy"))

    const gen = GraphSnapshot.candidates(dir)[0]!
    expect(gen.legacy).toBe(true)
    expect(restored(dir)?.files).toEqual({ graph: "legacy" })
  })

  test("🔴 once a generation exists the loose files are gone, and never preferred", () => {
    // A stale flat `graph` sitting beside generations is a second store waiting to be opened by
    // accident. The first publish is what retires it.
    const dir = fresh()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "graph"), bytes("legacy"))
    GraphSnapshot.publish(dir, set(["graph", "A"]))

    expect(existsSync(join(dir, "graph"))).toBe(false)
    expect(restored(dir)?.files).toEqual({ graph: "A" })
  })

  test("an empty directory offers nothing to restore", () => {
    const dir = fresh()
    mkdirSync(dir, { recursive: true })
    expect(GraphSnapshot.candidates(dir)).toEqual([])
    expect(GraphSnapshot.exists(dir)).toBe(false)
  })

  test("a directory that does not exist is not an error", () => {
    expect(GraphSnapshot.candidates(join(tmpdir(), "gen-snap-absent-xyz"))).toEqual([])
  })
})

function sha(text: string): string {
  // Local rather than exported: a test that computes the digest the same way the code does could only
  // ever agree with it. This one is used to build a VALID manifest for a fixture, never to check one.
  const { createHash } = require("node:crypto") as typeof import("node:crypto")
  return createHash("sha256").update(Buffer.from(text)).digest("hex")
}

describe("🔴 the last VERIFIED generation is pinned, so two bad checkpoints cannot empty the store", () => {
  /**
   * The incident, 2026-08-26. Two checkpoints published generations that did not read back. `KEEP = 2`
   * counted them by INDEX, so they filled both retained slots and the store the user actually had was
   * pruned behind them: `fell back to an EMPTY store`, `stats.total = 0` — 1516 nodes and 200 absorbed
   * passages gone, on two separate stores.
   *
   * ⚠️ The obvious fix — "when pruning, spare the newest generation that still reads" — does NOT work,
   * and proving that is why this file says so. Prune runs on every publish, so the steady state IS two
   * generations; by the time both are known bad there is nothing older left to spare. The pin has to be
   * taken while a generation is still known good.
   */
  const pin = (dir: string) => readFileSync(join(dir, "LASTGOOD"), "utf8").trim()

  test("publish pins the generation it just read back", () => {
    const dir = fresh()
    GraphSnapshot.publish(dir, set(["graph", "A"]))
    const second = GraphSnapshot.publish(dir, set(["graph", "B"]))
    expect(pin(dir)).toBe(second)
  })

  /**
   * A generation that does NOT read back, injected through the public API only: a payload named
   * `MANIFEST` is written, digested, and then overwritten by the real manifest — so the manifest
   * describes bytes the file no longer holds, which is precisely "Checksum verification failed".
   * No private hook and no monkey-patching, so this cannot pass because the injection missed.
   */
  const unverifiable = (dir: string, value: string) =>
    GraphSnapshot.publish(dir, set(["graph", value], ["MANIFEST", "clobbered"]))

  test("a generation that cannot be read back does NOT take the pin", () => {
    const dir = fresh()
    const good = GraphSnapshot.publish(dir, set(["graph", "A"]))
    unverifiable(dir, "B")
    expect(pin(dir)).toBe(good) // the pin stayed put, which is the whole mechanism
  })

  test("🔴 two unverifiable publishes in a row do NOT erase the store", () => {
    const dir = fresh()
    const good = GraphSnapshot.publish(dir, set(["graph", "A"]))
    unverifiable(dir, "B")
    unverifiable(dir, "C") // this publish's prune is what deleted `good` before the fix

    expect(existsSync(join(dir, good))).toBe(true)
    expect(restored(dir)?.files).toEqual({ graph: "A" }) // before the fix: undefined — total memory loss
  })

  // ⚠️ CONTROL. "Never delete anything" would pass every test above, so the ordinary path must still prune.
  test("the ordinary path still prunes — the pin is one generation, not a hoard", () => {
    const dir = fresh()
    const oldest = GraphSnapshot.publish(dir, set(["graph", "A"]))
    GraphSnapshot.publish(dir, set(["graph", "B"]))
    GraphSnapshot.publish(dir, set(["graph", "C"]))
    expect(existsSync(join(dir, oldest))).toBe(false)
    expect(readdirSync(dir).filter((n) => n.startsWith("g-")).length).toBe(2)
  })

  test("the pin FILE survives pruning — sweeping it would silently un-pin the store", () => {
    const dir = fresh()
    GraphSnapshot.publish(dir, set(["graph", "A"]))
    GraphSnapshot.publish(dir, set(["graph", "B"]))
    GraphSnapshot.prune(dir)
    expect(existsSync(join(dir, "LASTGOOD"))).toBe(true)
  })
})
