import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DIR, file, name, save, tombstone } from "../src/session/old-context"

/**
 * `invariants.md` (Context Management 1 and 2) names a file the code never wrote: compaction is
 * supposed to store the folded-away chat at `%AGENT_SCRATCH_FOLDER%/tmp/oldctx-%DATETIME%.txt` and
 * tell the agent, in the compacted context, that it is there. Measured 2026-09-15, the string
 * `oldctx` did not exist anywhere in `packages/`; the folded text went to the KB as passages instead.
 *
 * These pin the naming, the line that names it, and the write. The write is pinned here because the
 * two ways it can go wrong are both SILENT: a folder that was not there turns a tombstone into a lie
 * about a file nobody created, and a name that already exists turns a second fold into either a
 * failed compaction (`wx`) or one file holding two conversations glued together (`a`). The test picks
 * the timestamp, so the collision is exact rather than a race it has to hope for.
 */

const dirs: string[] = []
const tempRoot = async (label: string): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `oldctx-${label}-`))
  dirs.push(dir)
  return dir
}

afterAll(async () => {
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe("the folded-away chat has a name the agent can be handed", () => {
  test("the name is the stamp form the log segments already use, so it sorts", () => {
    const at = new Date("2026-09-15T17:45:00.123Z")
    expect(name(at)).toBe("oldctx-20260915T174500123Z.txt")

    // Lexicographic order is chronological order — the property that makes a directory listing of
    // these readable, and the reason this reuses `stampOf` instead of `toISOString()`.
    const earlier = name(new Date("2026-09-15T09:00:00.000Z"))
    const later = name(new Date("2026-09-15T17:45:00.123Z"))
    expect([later, earlier].sort()).toEqual([earlier, later])
  })

  test("the file lands in the agent's scratch tmp, spelled exactly as the invariant spells it", () => {
    const scratch = path.join("C:", "Users", "someone", "scratch", "geryon")
    const at = new Date("2026-09-15T17:45:00.123Z")
    const target = file({ scratchFolder: scratch, at })

    expect(target).toBe(path.join(scratch, "tmp", "oldctx-20260915T174500123Z.txt"))
    expect(path.dirname(target)).toBe(path.join(scratch, DIR))
    // Absolute, because the agent's working directory is not necessarily its scratch folder: a
    // relative path would point somewhere else the moment the agent is pointed at a project.
    expect(path.isAbsolute(target)).toBe(true)
  })

  test("the tombstone names the file and says what is in it", () => {
    const target = path.join("C:", "scratch", "geryon", "tmp", "oldctx-20260915T174500123Z.txt")
    const line = tombstone(target)

    expect(line).toBe(`${target} holds earlier chat`)
    expect(line).toContain(target)
    // No placeholder may survive into the context the model reads: `%DATETIME%` reaching a model is
    // the same defect as a config value reaching it, and it is invisible in a summary.
    expect(line).not.toContain("%")
  })
})

describe("the harness can always write it, whatever is already on disk", () => {
  test("it creates the whole folder chain when none of it exists", async () => {
    const root = await tempRoot("missing")
    // Nothing is created beforehand: no agent folder, no `tmp`. This is the state a colleague reached
    // before its own provisioning ran, or a scratch folder deleted under a running instance.
    const scratch = path.join(root, "agent", "scratch")
    const at = new Date("2026-09-15T17:45:00.123Z")

    const written = await save({ scratchFolder: scratch, at, text: "earlier chat" })

    expect(written).toBe(file({ scratchFolder: scratch, at }))
    expect(await fs.readFile(written, "utf8")).toBe("earlier chat")
    expect(path.dirname(written)).toBe(path.join(scratch, DIR))
  })

  test("an existing file at the same name is REPLACED, not appended to and not refused", async () => {
    const root = await tempRoot("collision")
    const scratch = path.join(root, "geryon")
    const at = new Date("2026-09-15T17:45:00.123Z")
    const target = file({ scratchFolder: scratch, at })

    // A previous fold that landed on the same millisecond, or a clock that stepped backwards after an
    // NTP correction or a resume — both produce this exact state.
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, "the fold that was here first", "utf8")

    const written = await save({ scratchFolder: scratch, at, text: "the fold that replaced it" })

    expect(written).toBe(target)
    const content = await fs.readFile(target, "utf8")
    expect(content).toBe("the fold that replaced it")
    // The seam is what an append would leave behind: two conversations in one file, with nothing
    // marking where the first ends. An agent grepping it would read them as one chat.
    expect(content).not.toContain("the fold that was here first")
  })

  test("the same instant writes the same path, and the newest write is the one that stands", async () => {
    const root = await tempRoot("idempotent")
    const scratch = path.join(root, "geryon")
    const at = new Date("2026-09-15T17:45:00.123Z")

    const first = await save({ scratchFolder: scratch, at, text: "first" })
    const second = await save({ scratchFolder: scratch, at, text: "second" })

    // The name carries no uniqueness beyond the millisecond, which is exactly why `save` must own the
    // flag: the caller cannot make a collision safe by choosing differently.
    expect(second).toBe(first)
    expect(await fs.readFile(first, "utf8")).toBe("second")
    expect((await fs.readdir(path.join(scratch, DIR))).length).toBe(1)
  })

  test("the path it returns is the file it wrote, not one it intended to write", async () => {
    const root = await tempRoot("returned")
    const scratch = path.join(root, "geryon")
    const at = new Date("2026-09-15T17:45:00.123Z")

    const written = await save({ scratchFolder: scratch, at, text: "earlier chat" })

    // A tombstone built from anything but this return value is a promise about a file the harness may
    // never have created; `oldctx-` and the `tmp/` segment are the invariant's spelling, not a guess.
    expect(path.basename(written)).toBe("oldctx-20260915T174500123Z.txt")
    expect(path.basename(path.dirname(written))).toBe("tmp")
    await expect(fs.stat(written)).resolves.toBeDefined()
  })
})
