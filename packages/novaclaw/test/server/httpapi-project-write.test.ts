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
