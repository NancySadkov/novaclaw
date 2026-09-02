import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Heap } from "../../src/cli/heap"
import { tmpdir } from "../fixture/fixture"

/**
 * A HEAP SNAPSHOT IS BOUNDED BY WHOEVER OWNS ITS DIRECTORY.
 *
 * 🔴 These used to be written into the log directory, whose retention grammar is
 * `novaclaw-<stamp>.log(.gz)` — so a `.heapsnapshot` matched neither half of the sweep. It was never
 * deleted by age or by budget AND it was not counted in the total the byte ceiling is compared
 * against, so an operator who set `NOVACLAW_AUTO_HEAP_SNAPSHOT`, forgot, and crossed the 2 GiB
 * trigger once per restart accumulated RSS-sized files forever while the Settings row went on saying
 * the log directory was capped at 256 MB.
 *
 * ⚠️ Moving them to a sibling directory is only half the fix, and this file is the other half.
 * A `diagnostics` directory with no bound of its own is the SAME defect one path over: the class is
 * "a large file in a directory nobody bounds", not "a large file in the log directory".
 */

/** `n` snapshots, oldest first, with mtimes a minute apart so the order is unambiguous. */
const plant = (home: string, names: readonly string[]) => {
  fs.mkdirSync(home, { recursive: true })
  const base = Date.now() - names.length * 60_000
  return names.map((name, index) => {
    const file = path.join(home, `${name}.heapsnapshot`)
    fs.writeFileSync(file, Buffer.alloc(16, 0x61))
    const at = new Date(base + index * 60_000)
    fs.utimesSync(file, at, at)
    return file
  })
}

const names = (home: string) => fs.readdirSync(home).sort()

describe("the diagnostics directory bounds itself", () => {
  test("🔴 only the newest snapshots survive, oldest deleted first", async () => {
    await using dir = await tmpdir()
    const home = path.join(dir.path, "diagnostics")
    const planted = plant(home, ["heap-1-a", "heap-2-b", "heap-3-c", "heap-4-d"])

    Heap.prune(home, 2)

    // A leak is read as a DIFFERENCE between two heaps, so the bound is two rather than one.
    expect(names(home)).toEqual(["heap-3-c.heapsnapshot", "heap-4-d.heapsnapshot"])
    expect(planted.slice(0, 2).map((file) => fs.existsSync(file))).toEqual([false, false])
  })

  test("CONTROL: a directory already inside the bound loses nothing, and non-snapshots are not ours", async () => {
    await using dir = await tmpdir()
    const home = path.join(dir.path, "diagnostics")
    plant(home, ["heap-1-a", "heap-2-b"])
    // ⚠️ Owning a directory's retention is not licence to empty it. This module's grammar is
    // `*.heapsnapshot` and it takes nothing else, however far over the count the directory is.
    fs.writeFileSync(path.join(home, "notes.txt"), "an operator left this here")

    Heap.prune(home, 2)

    expect(names(home)).toEqual(["heap-1-a.heapsnapshot", "heap-2-b.heapsnapshot", "notes.txt"])
  })

  test("a directory that does not exist yet is not an error — the first snapshot creates it", async () => {
    await using dir = await tmpdir()
    // Housekeeping runs immediately before the write, at the one moment the process is already over
    // 2 GiB of RSS. It must not be able to stop the snapshot it is making room for.
    expect(() => Heap.prune(path.join(dir.path, "never-made"), 2)).not.toThrow()
  })
})

describe("the bound is WIRED, not merely available", () => {
  test("🔴 the snapshot writer prunes before it writes", () => {
    /**
     * ⚠️ Read from the source, because the write path is gated on the process already holding more
     * than 2 GiB of RSS and cannot be driven from a test. A retention function nothing calls is the
     * shape this whole entry is about: the code existed, it was correct, and the directory still
     * grew. `agent-removal-wiring.test.ts` guards its own registration the same way and for the same
     * reason.
     */
    const source = fs.readFileSync(path.join(import.meta.dir, "..", "..", "src", "cli", "heap.ts"), "utf8")
    expect(source).toContain("prune(home,")
    // Before the write, not after: this runs at the one moment the process is already over the
    // trigger, so the room is made rather than the ceiling exceeded and then trimmed.
    expect(source.indexOf("prune(home,")).toBeLessThan(source.indexOf("writeHeapSnapshot(file)"))
  })
})
