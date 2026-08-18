import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { FSUtil } from "@novaclaw/core/fs-util"
import { ProjectFileResolve } from "@novaclaw/core/project-file"
import { ProjectFileWrite } from "@novaclaw/core/project-file-write"
import { testEffect } from "./lib/effect"

/**
 * `todo/projects.md`: *"Write path: create or update `novaclaw.json`, replacing only the sections
 * supplied. Refuse when the existing file does not parse — an edit is a merge onto the raw object,
 * and there is none."*
 *
 * Two halves get the attention here because both fail SILENTLY:
 *
 *  · A write that round-trips the DECODED view deletes every section this build has no type for.
 *    Nothing errors; the user simply finds their file shorter than they left it. So the preserving
 *    cases below assert on the raw JSON, key by key, rather than on what `parse` gives back.
 *  · A write over an unparseable file destroys content the user can still recover by hand. So the
 *    refusal cases assert the bytes on disk are UNCHANGED, not merely that the call reported an
 *    error.
 */

const it = testEffect(FSUtil.defaultLayer)

const roots: string[] = []
const tmp = (name: string) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `novaclaw-projwrite-${name}-`)))
  roots.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true })
})

const at = (dir: string) => path.join(dir, "novaclaw.json")
const read = (dir: string) => fs.readFileSync(at(dir), "utf8")
const json = (dir: string) => JSON.parse(read(dir)) as Record<string, unknown>

/**
 * A file with one of everything: a section this build knows and edits (`tune`), one it knows and is
 * NOT editing (`permissions`, `exclude`), and two it has never heard of — a top-level key and a
 * nested one inside a section it does know.
 */
const RICH = {
  $schema: "https://novaclaw.app/schema/project.json",
  version: 1,
  name: "Acme",
  permissions: [{ action: "bash", resource: "rm *", effect: "deny" }],
  exclude: ["secrets/**"],
  tune: { features: { memory: true } },
  // Not in `Info`. A newer NovaClaw wrote these; this build must hand them back untouched.
  futureSection: { enabled: true, weights: [1, 2, 3] },
  telemetry: "off",
}

describe("writing novaclaw.json", () => {
  it.effect("creates the file when the folder has none", () =>
    Effect.gen(function* () {
      const dir = tmp("create")
      const result = yield* ProjectFileWrite.write(dir, { tune: { features: { memory: true, quality: false } } })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.created).toBe(true)
      expect(result.file).toBe(at(dir))
      expect(result.sections).toEqual(["tune"])
      expect(json(dir)).toEqual({ version: 1, tune: { features: { memory: true, quality: false } } })
    }),
  )

  it.effect("🔴 replaces ONLY the section supplied — everything else survives, known or not", () =>
    Effect.gen(function* () {
      const dir = tmp("merge")
      fs.writeFileSync(at(dir), `${JSON.stringify(RICH, null, 2)}\n`)

      const result = yield* ProjectFileWrite.write(dir, { tune: { features: { surgicalEdits: true } } })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.created).toBe(false)
      expect(result.sections).toEqual(["tune"])

      const after = json(dir)
      // The new tune is there, whole — a section is REPLACED, not deep-merged, so the old `memory`
      // key is gone. That is the honest semantics: a caller holding the section holds all of it, and
      // a deep merge cannot express "this list is now empty".
      expect(after["tune"]).toEqual({ features: { surgicalEdits: true } })
      // Everything else is byte-for-byte what it was.
      expect(after["$schema"]).toBe(RICH.$schema)
      expect(after["version"]).toBe(1)
      expect(after["name"]).toBe("Acme")
      expect(after["permissions"]).toEqual(RICH.permissions)
      expect(after["exclude"]).toEqual(RICH.exclude)
      expect(after["futureSection"]).toEqual(RICH.futureSection)
      expect(after["telemetry"]).toBe("off")
      // And the whole document differs from the original in exactly one key.
      const changed = Object.keys(after).filter((key) => JSON.stringify(after[key]) !== JSON.stringify((RICH as Record<string, unknown>)[key]))
      expect(changed).toEqual(["tune"])
    }),
  )

  it.effect("writes several sections at once and still leaves the rest alone", () =>
    Effect.gen(function* () {
      const dir = tmp("sections")
      fs.writeFileSync(at(dir), `${JSON.stringify(RICH, null, 2)}\n`)
      const result = yield* ProjectFileWrite.write(dir, {
        name: "Renamed",
        exclude: ["build/**"],
        policies: ["policy.review"],
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      // Reported in the module's declared order, not the caller's object order.
      expect(result.sections).toEqual(["name", "exclude", "policies"])
      const after = json(dir)
      expect(after["name"]).toBe("Renamed")
      expect(after["exclude"]).toEqual(["build/**"])
      expect(after["policies"]).toEqual(["policy.review"])
      expect(after["permissions"]).toEqual(RICH.permissions)
      expect(after["futureSection"]).toEqual(RICH.futureSection)
    }),
  )

  it.effect("🔴 REFUSES a file that is not JSON, and leaves it exactly as it was", () =>
    Effect.gen(function* () {
      const dir = tmp("malformed")
      const original = '{ "version": 1, "name": "half-typed"\n'
      fs.writeFileSync(at(dir), original)

      const result = yield* ProjectFileWrite.write(dir, { tune: { features: { memory: true } } })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toBe("unreadable")
      expect(result.detail.length).toBeGreaterThan(0)
      expect(result.file).toBe(at(dir))
      // The point of the refusal: their file is still there to fix.
      expect(read(dir)).toBe(original)
    }),
  )

  it.effect("🔴 REFUSES valid JSON that fails the schema, and leaves it exactly as it was", () =>
    Effect.gen(function* () {
      const dir = tmp("schema")
      // Parses as JSON; `permissions` is not a ruleset and `version` is fine, so only the DECODE
      // rejects it. A write path that only tried `JSON.parse` would sail past this one.
      const original = `${JSON.stringify({ version: 1, permissions: "everything" }, null, 2)}\n`
      fs.writeFileSync(at(dir), original)

      const result = yield* ProjectFileWrite.write(dir, { tune: { features: { memory: true } } })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toBe("not-an-object")
      expect(read(dir)).toBe(original)
    }),
  )

  it.effect("a file from a NEWER NovaClaw is refused as `future-version`, not as corruption", () =>
    Effect.gen(function* () {
      const dir = tmp("future")
      const original = `${JSON.stringify({ version: 9999, mystery: true }, null, 2)}\n`
      fs.writeFileSync(at(dir), original)
      const result = yield* ProjectFileWrite.write(dir, { tune: { features: { memory: true } } })
      expect(result.ok).toBe(false)
      if (result.ok) return
      // Upgrade, versus fix your file. Overwriting here would destroy a file this build cannot read
      // but a newer one can.
      expect(result.reason).toBe("future-version")
      expect(read(dir)).toBe(original)
    }),
  )

  it.effect("🔴 a supervision switch is never RECORDED as off — it is dropped and reported", () =>
    Effect.gen(function* () {
      const dir = tmp("supervision")
      const result = yield* ProjectFileWrite.write(dir, {
        tune: { features: { safeMode: false, askBeforeChanges: false, memory: false, quality: true } },
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.refusedTune).toEqual(["safeMode", "askBeforeChanges"])
      // `memory: false` is a PREFERENCE and is written; the two rails are simply absent, which means
      // inherit — the folder takes no position on them.
      expect(json(dir)["tune"]).toEqual({ features: { memory: false, quality: true } })
    }),
  )

  it.effect("a supervision switch turned ON is written normally", () =>
    Effect.gen(function* () {
      const dir = tmp("raise")
      const result = yield* ProjectFileWrite.write(dir, { tune: { features: { safeMode: true } } })
      expect(result.ok).toBe(true)
      expect(json(dir)["tune"]).toEqual({ features: { safeMode: true } })
    }),
  )

  it.effect("writes LF line endings and a trailing newline, on every platform", () =>
    Effect.gen(function* () {
      const dir = tmp("newlines")
      yield* ProjectFileWrite.write(dir, { tune: { features: { memory: true } } })
      const text = read(dir)
      // A CRLF file is invisible to `git status` under `text=auto`; only a byte check ever sees it.
      expect(text.includes("\r")).toBe(false)
      expect(text.endsWith("}\n")).toBe(true)
      expect(text.split("\n").length).toBeGreaterThan(3)
    }),
  )

  it.effect("a folder whose path contains spaces is written like any other", () =>
    Effect.gen(function* () {
      const base = tmp("spaces")
      const dir = path.join(base, "My Projects", "Acme Corp")
      fs.mkdirSync(dir, { recursive: true })
      const result = yield* ProjectFileWrite.write(dir, { name: "Acme Corp" })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.file).toBe(at(dir))
      expect(json(dir)["name"]).toBe("Acme Corp")
    }),
  )

  it.effect("the target is resolved against the folder — a relative directory still lands inside it", () =>
    Effect.gen(function* () {
      const dir = tmp("resolve")
      // `path.resolve` inside `write` is what makes this predictable; the assertion is that the file
      // never escapes the folder it was asked about, which is AGENTS.md principle 11(c).
      const result = yield* ProjectFileWrite.write(path.join(dir, "sub", ".."), { name: "here" })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(path.dirname(result.file)).toBe(dir)
      expect(path.basename(result.file)).toBe("novaclaw.json")
    }),
  )

  it.effect("🔴 round trip: after a write the resolver reports the folder as a Project with that tune", () =>
    Effect.gen(function* () {
      const dir = tmp("roundtrip")
      const write = yield* ProjectFileWrite.write(dir, {
        name: "Round",
        tune: { mode: "interactive", features: { memory: true, safeMode: true, affective: false } },
      })
      expect(write.ok).toBe(true)

      // The READ side, unchanged, over the bytes the write side produced. This is the join the two
      // halves are only ever tested apart from — a write whose output the resolver rejects would
      // pass every assertion above.
      const resolved = yield* ProjectFileResolve.resolve(dir, dir)
      expect(resolved.kind).toBe("project")
      if (resolved.kind !== "project") return
      expect(resolved.root).toBe(dir)
      expect(resolved.file).toBe(at(dir))
      expect(resolved.info.name).toBe("Round")
      expect(resolved.info.tune).toEqual({ mode: "interactive", features: { memory: true, safeMode: true, affective: false } })
    }),
  )

  it.effect("a second write updates rather than duplicating, and keeps what the first wrote", () =>
    Effect.gen(function* () {
      const dir = tmp("twice")
      yield* ProjectFileWrite.write(dir, { name: "First", tune: { features: { memory: true } } })
      const second = yield* ProjectFileWrite.write(dir, { tune: { features: { quality: true } } })
      expect(second.ok).toBe(true)
      if (!second.ok) return
      expect(second.created).toBe(false)
      const after = json(dir)
      expect(after["name"]).toBe("First")
      expect(after["tune"]).toEqual({ features: { quality: true } })
    }),
  )
})

describe("planning a write (no filesystem)", () => {
  const file = path.join(path.sep === "\\" ? "C:\\work\\acme" : "/work/acme", "novaclaw.json")

  test("an absent section is left alone; a present one replaces", () => {
    const planned = ProjectFileWrite.plan(
      file,
      JSON.stringify({ version: 1, name: "keep", exclude: ["a"], unknown: 7 }),
      { exclude: ["b"] },
    )
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.sections).toEqual(["exclude"])
    const parsed = JSON.parse(planned.text) as Record<string, unknown>
    expect(parsed).toEqual({ version: 1, name: "keep", exclude: ["b"], unknown: 7 })
  })

  test("supplying nothing rewrites the file unchanged rather than emptying it", () => {
    const original = { version: 1, name: "keep", unknown: 7 }
    const planned = ProjectFileWrite.plan(file, JSON.stringify(original), {})
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.sections).toEqual([])
    expect(JSON.parse(planned.text)).toEqual(original)
  })

  test("a Windows-shaped path is carried through verbatim", () => {
    const windows = "C:\\Users\\nancy\\My Work\\acme\\novaclaw.json"
    const planned = ProjectFileWrite.plan(windows, undefined, { name: "acme" })
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.created).toBe(true)
    // The path is data here — it appears in the receipt and in a refusal, and a backslash must not
    // be mangled on the way through.
    const refusal = ProjectFileWrite.plan(windows, "{ broken", { name: "acme" })
    expect(refusal.ok).toBe(false)
    if (refusal.ok) return
    expect(refusal.file).toBe(windows)
  })
})
