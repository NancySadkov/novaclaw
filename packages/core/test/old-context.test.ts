import { describe, expect, test } from "bun:test"
import path from "node:path"
import { DIR, file, name, tombstone } from "../src/session/old-context"

/**
 * `invariants.md` (Context Management 1 and 2) names a file the code never wrote: compaction is
 * supposed to store the folded-away chat at `%AGENT_SCRATCH_FOLDER%/tmp/oldctx-%DATETIME%.txt` and
 * tell the agent, in the compacted context, that it is there. Measured 2026-09-15, the string
 * `oldctx` did not exist anywhere in `packages/`; the folded text went to the KB as passages instead.
 *
 * These pin the naming and the line that names it. What they deliberately do NOT pin is the write —
 * that is the caller's half, and a test that reached the filesystem would be testing `fs`, not this.
 */
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
