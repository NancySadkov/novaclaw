import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * 🔴 NO MEMORY BOUND MAY BE WRITTEN AGAINST A SELF-REPORTED FIGURE.
 *
 * Measured 2026-09-28 on a live instance: a `novaclaw` worker process held **6.32 GB of commit at
 * 18.5 MB of working set**, idle, and the per-worker ceiling never fired. It never fired because the
 * ceiling was evaluated against the worker's own `process.memoryUsage.rss()` — and working set is a
 * number the operating system is free to shrink. 18.5 MB is 31× under a 2 GiB limit, so the process
 * that was starving the host read as tiny to the only code that could have stopped it. The host's
 * commit budget is what actually runs out.
 *
 * The class, stated once: **a resource guard measures a quantity the system it guards can shrink, so
 * the failure it exists to prevent is invisible to it.**
 *
 * The tree already said so in prose — `core/src/util/process-commit.ts` was written to replace exactly
 * this and carries the measurement — but it sat in `packages/novaclaw/src/storage/`, where `core` could
 * not import it, so the memory-graph worker's ceiling in `kb-graph/isolated-engine.ts` had no way to
 * use the correct reader. The instrument moved to `core` for that reason, and this file holds the line.
 *
 * ⚠️ A ratchet is only worth having if it can fail, so every check below names the files it read and
 * asserts they were read. The behavioural proof lives beside each bound: `supervisor.test.ts` drives a
 * real worker over a real external reading, and `worker-recycle.test.ts` drives a real child against a
 * ceiling no process can be under. Neither fakes a number any more.
 */

const ROOT = join(import.meta.dir, "..", "..", "..")

const read = (relative: string) => {
  const raw = readFileSync(join(ROOT, relative), "utf8")
  expect(raw.length, `${relative} must be readable — a moved file must fail LOUDLY, not pass silently`).toBeGreaterThan(200)
  return raw
}

/**
 * Source with comments stripped, so prose ABOUT the rule cannot satisfy the rule — but string
 * literals LEFT ALONE, because a `Select-Object …` crosscheck is a real string a person runs by hand
 * and must not be mistaken for an implementation.
 */
const code = (relative: string) =>
  read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")

/** As `code`, with quoted strings blanked — for checks that must not match a human-facing hint. */
const readable = (relative: string) => code(relative).replace(/`[^`]*`|("[^"]*"|'[^']*')/g, '""')

describe("a memory bound is never evaluated against a figure the guarded process reported", () => {
  test("the worker heartbeat carries no resource claim at all", () => {
    const protocol = code("packages/core/src/session/execution/worker-protocol.ts")
    // The field is not merely unused — it is GONE, so there is nothing left to bound against.
    expect(protocol).not.toMatch(/rssBytes/)
    const heartbeat = /Heartbeat\s*=\s*Schema\.Struct\(\{([\s\S]*?)\}\)/.exec(protocol)?.[1] ?? ""
    expect(heartbeat, "the Heartbeat schema must still be findable — a rename must fail here").toContain("at:")
  })

  test("the worker entrypoint no longer reports its own footprint", () => {
    expect(code("packages/novaclaw/src/session-worker/entrypoint.ts")).not.toMatch(/rssBytes|memoryUsage/)
  })

  test("the supervisor's memory outcome is a real measurement, and says which metric it is", () => {
    const supervisor = code("packages/novaclaw/src/session-worker/supervisor.ts")
    // `heldBytes` + `metric`, read from outside by ProcessCommit.
    expect(supervisor).toContain("heldBytes")
    expect(supervisor).toMatch(/metric:\s*("commit"\s*\|\s*"rss"|reading\.metric)/)
    expect(supervisor).toContain("ProcessCommit")
    // The old shape must be gone from the type, not just from the call site.
    expect(supervisor).not.toMatch(/rssBytes/)
  })

  test("the memory worker stops reporting a footprint, and the reason it did is corrected", () => {
    const worker = code("packages/novaclaw/src/memory-worker-node.ts")
    expect(worker).not.toMatch(/rssBytes|memoryUsage\(\)/)
  })

  test("the memory-graph ceiling reads from outside, and its accessor is not named after RSS", () => {
    const engine = code("packages/core/src/kb-graph/isolated-engine.ts")
    expect(engine).toContain("ProcessCommit")
    expect(engine).not.toMatch(/rssBytes|maxWorkerRssBytes|workerRssBytes/)
  })

  test("admission reads the ONE instrument rather than its own WorkingSet64 probe", () => {
    const pressure = readable("packages/novaclaw/src/storage/pressure.ts")
    expect(pressure).toContain("ProcessCommit")
    // The duplicate reader is the second door: a shrinkable number, read by a second implementation.
    expect(pressure).not.toMatch(/WorkingSet64/)
  })

  test("there is exactly ONE implementation of the instrument", () => {
    // Two readers of a shrinkable number is how this drifted the first time. The Windows probe reads
    // `PagedMemorySize64`, so if that reaches a file other than the instrument, a second reader exists.
    //
    // ⚠️ The instrument is matched with its strings INTACT — its PowerShell script legitimately names
    // `PagedMemorySize64` inside a template literal — while every other file is matched with strings
    // blanked, so a `Select-Object …` crosscheck cannot be mistaken for a second reader. Those are the
    // one-line commands this product prints so a person can reproduce a reading by hand; they read
    // nothing, and a ratchet that flagged them would be a ratchet people learn to delete.
    const BOUND_FILES = [
      "packages/novaclaw/src/storage/pressure.ts",
      "packages/novaclaw/src/session-worker/supervisor.ts",
      "packages/core/src/kb-graph/isolated-engine.ts",
    ]
    const readers = [
      ...(code("packages/core/src/util/process-commit.ts").includes("PagedMemorySize64")
        ? ["packages/core/src/util/process-commit.ts"]
        : []),
      ...BOUND_FILES.filter((file) => readable(file).includes("PagedMemorySize64")),
    ]
    expect(readers, "only the instrument may read PagedMemorySize64").toEqual([
      "packages/core/src/util/process-commit.ts",
    ])
  })
})
