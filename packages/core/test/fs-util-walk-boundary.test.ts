import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import { homedir } from "os"
import path from "path"
import { Effect } from "effect"
import { FSUtil } from "@novaclaw/core/fs-util"
import { tmpdir } from "./fixture/tmpdir"

/**
 * 🔴 **An ancestor walk's `stop` is a safety parameter that fails OPEN.**
 *
 * The walks in `fs-util.ts` terminate on `stop === current`, so a boundary that never equals an
 * ancestor is not a boundary at all — the walk covers every directory up to the drive root. Two
 * spellings of *"there is no project root"* produce exactly that: the `"/"` sentinel a location
 * outside any repository carries (which equals nothing on Windows), and a genuine volume root such
 * as `C:\` (which equals something only after the whole volume has been visited). Both were read as
 * *"stop at the root of the disk"*, and the walks that write — a `.gitignore` into every
 * `.novaclaw` on the chain — then wrote outside the three places AGENTS.md principle 11 allows.
 *
 * ⚠️ **Every fixture here lives under the OS temp dir**, deliberately: a test about a walk that
 * escapes its boundary must not itself walk the real filesystem to prove it. The volume-root and
 * home-floor arms are therefore checked on the PURE `walkBoundary`, with synthetic paths and no
 * filesystem at all, and the arm that is observable inside a temp tree — a boundary that is not an
 * ancestor of the start folder — is the one exercised against real directories.
 */
describe("FSUtil.walkBoundary — a walk boundary is never a whole volume", () => {
  test("🔴 the no-repository sentinel and a volume root both stop at the home floor", () => {
    const start = path.join(homedir(), "novaclaw-walk-fixture", "deep")

    for (const sentinel of ["/", path.parse(path.resolve(start)).root]) {
      const boundary = FSUtil.walkBoundary(start, sentinel)

      // The class, stated as one assertion: whatever a caller asked for, the answer is never a
      // boundary that trusts the entire volume.
      expect(FSUtil.isVolumeRoot(boundary), `boundary for ${JSON.stringify(sentinel)} is a volume root`).toBe(false)
      expect(FSUtil.contains(boundary, start)).toBe(true)
      expect(path.relative(boundary, homedir())).toBe("")
    }
  })

  test("a start folder outside home is bounded by ITSELF, never by nothing", () => {
    // Purely lexical — this directory is never created, and `walkBoundary` never touches the disk.
    const outside = path.join(path.parse(homedir()).root, "novaclaw-not-a-real-directory", "deep")
    expect(FSUtil.contains(homedir(), outside)).toBe(false)

    expect(path.relative(FSUtil.walkBoundary(outside, "/"), outside)).toBe("")
  })

  test("a real ancestor boundary is honoured unchanged — this is not a wall", () => {
    const root = path.join(homedir(), "novaclaw-walk-fixture")
    const start = path.join(root, "a", "b")
    expect(path.relative(FSUtil.walkBoundary(start, root), root)).toBe("")
  })

  test("a boundary that is not an ancestor of the start folder is clamped to the start folder", () => {
    const start = path.join(homedir(), "novaclaw-walk-fixture", "a", "b")
    const elsewhere = path.join(homedir(), "novaclaw-walk-fixture-other")
    expect(path.relative(FSUtil.walkBoundary(start, elsewhere), start)).toBe("")
  })
})

const up = (options: { targets: string[]; start: string; stop?: string }) =>
  Effect.runPromise(FSUtil.use.up(options).pipe(Effect.provide(FSUtil.defaultLayer)))

describe("FSUtil.up — the boundary is enforced by the primitive, not remembered by the caller", () => {
  test("🔴 a stop that is not an ancestor of the start folder does not license the ancestors", async () => {
    await using tmp = await tmpdir()
    const project = path.join(tmp.path, "project")
    const deep = path.join(project, "packages", "app")
    const elsewhere = path.join(tmp.path, "elsewhere")
    await fs.mkdir(path.join(project, ".novaclaw"), { recursive: true })
    await fs.mkdir(path.join(deep, ".novaclaw"), { recursive: true })
    await fs.mkdir(elsewhere, { recursive: true })

    // `elsewhere` equals no ancestor of `deep`, so before the boundary rule this walk ran to the
    // drive root and returned the ancestor's directory along the way.
    expect(await up({ targets: [".novaclaw"], start: deep, stop: elsewhere })).toEqual([
      path.join(deep, ".novaclaw"),
    ])

    // The control, in the same fixture: a boundary that IS an ancestor still discovers everything
    // between it and the start folder. A guard that refused both would satisfy the assertion above.
    expect(await up({ targets: [".novaclaw"], start: deep, stop: project })).toEqual([
      path.join(deep, ".novaclaw"),
      path.join(project, ".novaclaw"),
    ])
  })

  test("an omitted stop is still unbounded — repository discovery walks past home by design", async () => {
    await using tmp = await tmpdir()
    const project = path.join(tmp.path, "project")
    const deep = path.join(project, "packages", "app")
    await fs.mkdir(path.join(project, ".novaclaw"), { recursive: true })
    await fs.mkdir(deep, { recursive: true })

    expect(await up({ targets: [".novaclaw"], start: deep })).toContainEqual(path.join(project, ".novaclaw"))
  })
})
