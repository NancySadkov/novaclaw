import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { describeLogDirectory, logDirectoryNotice, resolveLogDirectory } from "./log-directory"

const eacces = (path: string) =>
  Object.assign(new Error(`EACCES: permission denied, mkdir '${path}'`), { code: "EACCES" })

/**
 * A `mkdir` that refuses every directory under one of `blocked`.
 *
 * ⚠️ Separators are normalised before matching: `resolveLogDirectory` uses `node:path`'s `join`, so
 * on win32 the argument arrives as `\profile\logs\<stamp>` and a naive `startsWith("/profile")`
 * matches nothing — which made both degrade cases silently pass as "ready" on the first run here.
 */
const mkdirRefusing = (blocked: readonly string[]) => {
  const made: string[] = []
  const slash = (value: string) => value.replace(/\\/g, "/")
  return {
    made,
    mkdir: (dir: string) => {
      if (blocked.some((prefix) => slash(dir).startsWith(slash(prefix)))) throw eacces(dir)
      made.push(dir)
    },
  }
}

describe("log directory resolution", () => {
  test("uses the profile folder when it accepts the write", () => {
    const { mkdir, made } = mkdirRefusing([])
    const result = resolveLogDirectory(["/profile/logs", "/tmp/novaclaw-logs"], "20260807T101500", mkdir)

    expect(result.kind).toBe("ready")
    expect(made).toHaveLength(1)
    expect(describeLogDirectory(result)).toBeUndefined()
    expect(logDirectoryNotice(result)).toBeUndefined()
  })

  test("an unwritable profile folder degrades to temp and says so in the log", () => {
    const { mkdir, made } = mkdirRefusing(["/profile"])
    const result = resolveLogDirectory(["/profile/logs", "/tmp/novaclaw-logs"], "20260807T101500", mkdir)

    expect(result.kind).toBe("fallback")
    if (result.kind !== "fallback") return
    expect(result.root).toBe("/tmp/novaclaw-logs")
    expect(result.preferred).toBe("/profile/logs")
    expect(result.reason).toContain("EACCES")
    expect(made).toHaveLength(1)

    const report = describeLogDirectory(result)
    expect(report?.level).toBe("warn")
    expect(report?.meta.preferred).toBe("/profile/logs")
    expect(report?.meta.reason).toContain("EACCES")

    // Logs still land, so the user is not paged — AGENTS.md's managed-by-default stance.
    expect(logDirectoryNotice(result)).toBeUndefined()
  })

  test("when nothing is writable the run reports itself to the USER, and names both attempts", () => {
    const { mkdir, made } = mkdirRefusing(["/profile", "/tmp"])
    const result = resolveLogDirectory(["/profile/logs", "/tmp/novaclaw-logs"], "20260807T101500", mkdir)

    expect(result.kind).toBe("unavailable")
    if (result.kind !== "unavailable") return
    expect(result.attempted).toEqual(["/profile/logs", "/tmp/novaclaw-logs"])
    expect(result.reason).toContain("EACCES")
    expect(made).toHaveLength(0)

    expect(describeLogDirectory(result)?.level).toBe("error")

    const notice = logDirectoryNotice(result)
    expect(notice).toBeDefined()
    expect(notice!.code).toBe("logging.directory.unavailable")
    // One calm sentence, and no stack trace in the part a person reads.
    expect(notice!.summary).toBe("NovaClaw could not write to its profile folder, so it cannot save logs this run.")
    expect(notice!.detail).toContain("/profile/logs")
    expect(notice!.detail).toContain("/tmp/novaclaw-logs")
    expect(notice!.detail).toContain("EACCES")
  })

  test("a non-Error refusal still produces a named reason", () => {
    const result = resolveLogDirectory(["/profile/logs"], "s", () => {
      throw "the disk went away"
    })
    expect(result.kind).toBe("unavailable")
    if (result.kind !== "unavailable") return
    expect(result.reason).toBe("the disk went away")
  })
})

/**
 * The SOURCE ledger for the call site. `resolveLogDirectory`'s own behaviour is provable above, but
 * whether `logging.ts` actually goes through it is invisible to every behavioural test in this
 * package — and reverting `initRunDirectory` to a bare `mkdirSync` restores the exact defect this
 * work removed: a throw before the logger exists, with no window and no log.
 */
describe("logging.ts is wired to the guarded resolver", () => {
  const source = readFileSync(new URL("./logging.ts", import.meta.url), "utf8")

  test("initRunDirectory delegates to resolveLogDirectory", () => {
    expect(source).toMatch(/function initRunDirectory\(\): LogDirectory \{[\s\S]{0,600}resolveLogDirectory\(/)
  })

  test("the file transport is switched off rather than aimed at the cwd", () => {
    expect(source).toMatch(/directory\.kind === "unavailable"[\s\S]{0,400}log\.transports\.file\.level = false/)
  })
})
