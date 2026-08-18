import { afterEach, describe, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { ExperimentalPaths } from "../../src/server/routes/instance/httpapi/groups/experimental"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffectShared } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

/**
 * **`POST /api/project` — create or update this folder's `novaclaw.json`.**
 *
 * `todo/projects.md`: *"Write path: create or update `novaclaw.json`, replacing only the sections
 * supplied. Refuse when the existing file does not parse."*
 *
 * ⚠️ Driven over real HTTP against real directories. The merge semantics have their own unit tests
 * (`packages/core/test/project-file-write.test.ts`); what can only fail HERE is the wiring — the
 * route existing, the payload decoding, the directory header choosing the target folder, and a
 * refusal arriving as a 200 body rather than as a thrown error.
 */

const it = testEffectShared(httpApiLayer)
afterEach(async () => {
  await disposeAllInstances()
})

const tmp = (name: string) =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `novaclaw-httpprojwrite-${name}-`)))

const post = (directory: string, body: unknown) =>
  requestInDirectory(ExperimentalPaths.project, directory, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  })

const at = (dir: string) => path.join(dir, "novaclaw.json")

describe("POST /api/project", () => {
  it.effect("creates the file in the ROUTED folder when there is none", () =>
    Effect.gen(function* () {
      const directory = tmp("create")
      const response = yield* post(directory, { tune: { features: { memory: true } } })
      expect(response.status).toBe(200)
      const body: Record<string, unknown> = JSON.parse(yield* response.text)
      expect(body["ok"]).toBe(true)
      expect(body["created"]).toBe(true)
      expect(body["file"]).toBe(at(directory))
      expect(body["sections"]).toEqual(["tune"])
      expect(JSON.parse(fs.readFileSync(at(directory), "utf8"))).toEqual({
        version: 1,
        tune: { features: { memory: true } },
      })
    }),
  )

  it.effect("🔴 replaces only the section supplied — permissions and unknown fields survive", () =>
    Effect.gen(function* () {
      const directory = tmp("merge")
      const before = {
        $schema: "https://novaclaw.app/schema/project.json",
        version: 1,
        name: "Acme",
        permissions: [{ action: "bash", resource: "*", effect: "deny" }],
        futureSection: { anything: [1, 2] },
      }
      fs.writeFileSync(at(directory), `${JSON.stringify(before, null, 2)}\n`)

      const response = yield* post(directory, { tune: { features: { quality: true } } })
      expect(response.status).toBe(200)
      const body: Record<string, unknown> = JSON.parse(yield* response.text)
      expect(body["ok"]).toBe(true)
      expect(body["created"]).toBe(false)

      const after = JSON.parse(fs.readFileSync(at(directory), "utf8")) as Record<string, unknown>
      expect(after["permissions"]).toEqual(before.permissions)
      expect(after["futureSection"]).toEqual(before.futureSection)
      expect(after["$schema"]).toBe(before.$schema)
      expect(after["name"]).toBe("Acme")
      expect(after["tune"]).toEqual({ features: { quality: true } })
    }),
  )

  it.effect("🔴 a BROKEN file is refused at 200, and the bytes on disk are untouched", () =>
    Effect.gen(function* () {
      const directory = tmp("broken")
      const original = "{ not json"
      fs.writeFileSync(at(directory), original)

      const response = yield* post(directory, { tune: { features: { memory: true } } })
      // Not a 4xx. `GET /api/project` already answers 200 `{kind:"invalid"}` for this same file, and
      // the app's fetch layer turns a non-2xx into a thrown Error — which would make a state the UI
      // is supposed to explain calmly arrive as "request failed".
      expect(response.status).toBe(200)
      const body: Record<string, unknown> = JSON.parse(yield* response.text)
      expect(body["ok"]).toBe(false)
      expect(body["reason"]).toBe("unreadable")
      expect(body["file"]).toBe(at(directory))
      expect(typeof body["detail"]).toBe("string")
      expect(fs.readFileSync(at(directory), "utf8")).toBe(original)
    }),
  )

  it.effect("a file from a NEWER NovaClaw is refused as `future-version`, not overwritten", () =>
    Effect.gen(function* () {
      const directory = tmp("future")
      const original = `${JSON.stringify({ version: 9999, mystery: true }, null, 2)}\n`
      fs.writeFileSync(at(directory), original)
      const response = yield* post(directory, { name: "mine" })
      const body: Record<string, unknown> = JSON.parse(yield* response.text)
      expect(body["ok"]).toBe(false)
      expect(body["reason"]).toBe("future-version")
      expect(fs.readFileSync(at(directory), "utf8")).toBe(original)
    }),
  )

  it.effect("🔴 a supervision switch cannot be persisted as OFF over the wire either", () =>
    Effect.gen(function* () {
      const directory = tmp("supervision")
      const response = yield* post(directory, {
        tune: { features: { safeMode: false, askBeforeChanges: false, memory: true } },
      })
      const body: Record<string, unknown> = JSON.parse(yield* response.text)
      expect(body["ok"]).toBe(true)
      expect(body["refusedTune"]).toEqual(["safeMode", "askBeforeChanges"])
      const after = JSON.parse(fs.readFileSync(at(directory), "utf8")) as Record<string, unknown>
      expect(after["tune"]).toEqual({ features: { memory: true } })
    }),
  )

  it.effect("🔴 a permissions edit writes ONLY that section, over the wire", () =>
    Effect.gen(function* () {
      const directory = tmp("permissions")
      const before = {
        $schema: "https://novaclaw.app/schema/project.json",
        version: 1,
        name: "Acme",
        tune: { features: { memory: true } },
        exclude: ["secrets/**"],
        futureSection: { anything: [1, 2] },
      }
      fs.writeFileSync(at(directory), `${JSON.stringify(before, null, 2)}\n`)

      const response = yield* post(directory, {
        permissions: [{ action: "bash", resource: "rm *", effect: "deny" }],
      })
      const body: Record<string, unknown> = JSON.parse(yield* response.text)
      expect(body["ok"]).toBe(true)
      expect(body["sections"]).toEqual(["permissions"])
      expect(body["cleared"]).toEqual([])

      const after = JSON.parse(fs.readFileSync(at(directory), "utf8")) as Record<string, unknown>
      expect(after["permissions"]).toEqual([{ action: "bash", resource: "rm *", effect: "deny" }])
      // The whole document differs in exactly one key — a field-by-field check would pass for a
      // write that quietly ADDED something.
      const changed = Object.keys({ ...before, ...after }).filter(
        (key) => JSON.stringify(after[key]) !== JSON.stringify((before as Record<string, unknown>)[key]),
      )
      expect(changed).toEqual(["permissions"])
    }),
  )

  it.effect("🔴 an `allow` rule cannot be persisted over the wire either, and is reported", () =>
    Effect.gen(function* () {
      // The permissions twin of the supervision-switch case above: a project ruleset is a NARROWING
      // constraint, so an `allow` is read, matched, and provably ignored. Writing one would put a
      // grant in the user's own file that the product does not honour.
      const directory = tmp("widen")
      const response = yield* post(directory, {
        permissions: [
          { action: "read", resource: "*", effect: "allow" },
          { action: "bash", resource: "*", effect: "deny" },
        ],
      })
      const body: Record<string, unknown> = JSON.parse(yield* response.text)
      expect(body["ok"]).toBe(true)
      expect(body["refusedPermissions"]).toEqual([{ action: "read", resource: "*", effect: "allow" }])
      const after = JSON.parse(fs.readFileSync(at(directory), "utf8")) as Record<string, unknown>
      expect(after["permissions"]).toEqual([{ action: "bash", resource: "*", effect: "deny" }])
    }),
  )

  it.effect("🔴 `clear` removes a section — the spelling that did not exist before", () =>
    Effect.gen(function* () {
      const directory = tmp("clear")
      const before = {
        version: 1,
        name: "Acme",
        permissions: [{ action: "bash", resource: "*", effect: "deny" }],
        futureSection: { anything: 1 },
      }
      fs.writeFileSync(at(directory), `${JSON.stringify(before, null, 2)}\n`)

      const response = yield* post(directory, { clear: ["permissions"] })
      const body: Record<string, unknown> = JSON.parse(yield* response.text)
      expect(body["ok"]).toBe(true)
      expect(body["cleared"]).toEqual(["permissions"])
      expect(body["sections"]).toEqual([])

      const after = JSON.parse(fs.readFileSync(at(directory), "utf8")) as Record<string, unknown>
      // Gone, not present-and-empty. `[]` and absent read the same to the kernel, and the user asked
      // for the sentence to leave their file.
      expect("permissions" in after).toBe(false)
      expect(after["name"]).toBe("Acme")
      expect(after["futureSection"]).toEqual(before.futureSection)

      // And the read side agrees: the folder is still a Project, with no rules.
      const read = yield* requestInDirectory(ExperimentalPaths.project, directory)
      const state: Record<string, unknown> = JSON.parse(yield* read.text)
      expect(state["kind"]).toBe("project")
      expect(state["permissionRules"]).toBe(0)
      expect(state["permissions"]).toEqual([])
    }),
  )

  it.effect("asking to both set and clear one section is refused at 200, with nothing written", () =>
    Effect.gen(function* () {
      const directory = tmp("contradiction")
      const original = `${JSON.stringify({ version: 1, name: "Acme" }, null, 2)}\n`
      fs.writeFileSync(at(directory), original)
      const response = yield* post(directory, { clear: ["name"], name: "Other" })
      expect(response.status).toBe(200)
      const body: Record<string, unknown> = JSON.parse(yield* response.text)
      expect(body["ok"]).toBe(false)
      // Its own reason, spelled apart from the file-is-broken ones: the fault is in the REQUEST, and
      // telling the user to fix a file that is fine is the wrong pointer.
      expect(body["reason"]).toBe("contradictory")
      expect(fs.readFileSync(at(directory), "utf8")).toBe(original)
    }),
  )

  it.effect("a confirmed .gitignore import is an ordinary exclude write", () =>
    Effect.gen(function* () {
      const directory = tmp("gitignore")
      fs.writeFileSync(at(directory), `${JSON.stringify({ version: 1, exclude: ["secrets/**"] }, null, 2)}\n`)
      fs.writeFileSync(path.join(directory, ".gitignore"), "node_modules\n/dist\n")

      // What the read side proposes …
      const read = yield* requestInDirectory(ExperimentalPaths.project, directory)
      const state: Record<string, unknown> = JSON.parse(yield* read.text)
      const proposal = state["gitignore"] as { add: string[] }
      expect(proposal.add).toEqual(["node_modules", "/dist"])

      // … is written by the ordinary write path, appended AFTER the user's own lines, because the
      // last matching pattern wins and their list must keep its precedence.
      const response = yield* post(directory, { exclude: ["secrets/**", ...proposal.add] })
      const body: Record<string, unknown> = JSON.parse(yield* response.text)
      expect(body["ok"]).toBe(true)
      expect(body["sections"]).toEqual(["exclude"])
      const after = JSON.parse(fs.readFileSync(at(directory), "utf8")) as Record<string, unknown>
      expect(after["exclude"]).toEqual(["secrets/**", "node_modules", "/dist"])
    }),
  )

  it.effect("what was written reads back through GET /api/project", () =>
    Effect.gen(function* () {
      const directory = tmp("roundtrip")
      yield* post(directory, { name: "Acme", exclude: ["secrets/**"], tune: { features: { memory: true } } })
      const read = yield* requestInDirectory(ExperimentalPaths.project, directory)
      const body: Record<string, unknown> = JSON.parse(yield* read.text)
      expect(body["kind"]).toBe("project")
      expect(body["root"]).toBe(directory)
      expect(body["name"]).toBe("Acme")
      expect(body["exclude"]).toEqual(["secrets/**"])
    }),
  )
})

describe("POST /api/project — the `skills` section refuses what its own reader would ignore", () => {
  /**
   * 🔴 The write-side twin of the narrowing, and the third instance of one rule: **our own writer
   * never emits a line our own reader is guaranteed to discard.** A project may hide a skill and may
   * never un-hide one the instance hid, so a `show:true` is dropped and REPORTED rather than written
   * — exactly what `refusedPermissions` does for an `allow` rule and `refusedTune` for a supervision
   * `false`.
   *
   * ⚠️ This is not the enforcement. An attacker's `novaclaw.json` never goes through this route;
   * `ProjectFile.narrowSkills` holds the line on every READ, and
   * `packages/core/test/skill-invocation-command-list.test.ts` drives that end to end.
   *
   * ⚠️ **A/B, run by hand and reported:** delete the `show === true` branch in
   * `ProjectFile.writableSkills` — the first case below goes red on both assertions.
   */
  it.effect("🔴 a `show:true` is refused and reported; the `show:false` beside it is written", () =>
    Effect.gen(function* () {
      const directory = tmp("skills")
      const response = yield* post(directory, {
        skills: { "hide-me": { show: false }, "show-me": { show: true } },
      })
      expect(response.status).toBe(200)
      const body: Record<string, unknown> = JSON.parse(yield* response.text)
      expect(body["ok"]).toBe(true)
      expect(body["sections"]).toEqual(["skills"])
      expect(body["refusedSkills"]).toEqual(["show-me"])
      expect(JSON.parse(fs.readFileSync(at(directory), "utf8"))).toEqual({
        version: 1,
        skills: { "hide-me": { show: false } },
      })
    }),
  )

  it.effect("a write with nothing to refuse reports an empty list, not an absent field", () =>
    Effect.gen(function* () {
      const directory = tmp("clean")
      const response = yield* post(directory, { skills: { "hide-me": { show: false } } })
      const body: Record<string, unknown> = JSON.parse(yield* response.text)
      expect(body["refusedSkills"]).toEqual([])
    }),
  )

  it.effect("`clear` removes the section — the folder stops having an opinion about any skill", () =>
    Effect.gen(function* () {
      const directory = tmp("clear")
      fs.writeFileSync(
        at(directory),
        JSON.stringify({ version: 1, name: "Acme", skills: { "hide-me": { show: false } } }),
      )
      const response = yield* post(directory, { clear: ["skills"] })
      const body: Record<string, unknown> = JSON.parse(yield* response.text)
      expect(body["ok"]).toBe(true)
      expect(body["cleared"]).toEqual(["skills"])
      expect(JSON.parse(fs.readFileSync(at(directory), "utf8"))).toEqual({ version: 1, name: "Acme" })
    }),
  )

  it.effect("supplying and clearing `skills` in one request is refused without writing", () =>
    Effect.gen(function* () {
      const directory = tmp("contradiction")
      const response = yield* post(directory, { skills: { a: { show: false } }, clear: ["skills"] })
      const body: Record<string, unknown> = JSON.parse(yield* response.text)
      expect(body["ok"]).toBe(false)
      expect(body["reason"]).toBe("contradictory")
      expect(fs.existsSync(at(directory))).toBe(false)
    }),
  )
})
