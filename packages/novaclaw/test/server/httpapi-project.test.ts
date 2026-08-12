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
 * **`GET /api/project` — what governs this folder, and why.**
 *
 * `todo/projects.md`: *"Never make a person infer project state from a hidden dotfile."* A
 * `novaclaw.json` can now NARROW a session's permissions, so a user whose tool call is refused needs
 * somewhere to see which file did it, and an agent asked to explain the refusal needs the same.
 *
 * ⚠️ Driven over real HTTP against real directories. The resolution logic has its own unit tests; the
 * thing that can only fail HERE is the wiring — the route existing, the directory header reaching the
 * resolver, and the union encoding as declared.
 */

const it = testEffectShared(httpApiLayer)
afterEach(async () => {
  await disposeAllInstances()
})

const tmp = (name: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `novaclaw-httpproject-${name}-`)))

describe("GET /api/project", () => {
  it.effect("reports a folder with no project as `none` — usable, just not a Project", () =>
    Effect.gen(function* () {
      const directory = tmp("bare")
      const response = yield* requestInDirectory(ExperimentalPaths.project, directory)
      expect(response.status).toBe(200)
      expect(JSON.parse(yield* response.text)).toEqual({ kind: "none" })
    }),
  )

  it.effect("reports the root, the file and what it CONTRIBUTES", () =>
    Effect.gen(function* () {
      const directory = tmp("real")
      fs.writeFileSync(
        path.join(directory, "novaclaw.json"),
        JSON.stringify({
          version: 1,
          name: "Acme",
          permissions: [{ action: "bash", resource: "*", effect: "deny" }],
          exclude: ["secrets/**"],
        }),
      )
      const response = yield* requestInDirectory(ExperimentalPaths.project, directory)
      expect(response.status).toBe(200)
      const body: Record<string, unknown> = JSON.parse(yield* response.text)
      expect(body["kind"]).toBe("project")
      expect(body["root"]).toBe(directory)
      expect(body["file"]).toBe(path.join(directory, "novaclaw.json"))
      expect(body["name"]).toBe("Acme")
      // A COUNT, not the rules: the permission surface already renders those, and a second place
      // that formats them is a second place for the two to disagree about what is in force.
      expect(body["permissionRules"]).toBe(1)
      expect(body["exclude"]).toEqual(["secrets/**"])
    }),
  )

  it.effect("🔴 a BROKEN file is reported as invalid, never flattened into `none`", () =>
    Effect.gen(function* () {
      // "There is no project here" and "your project file is broken" are the two answers a user acts
      // on differently. Collapsing them is how a typo becomes an afternoon — and the resolver stops
      // the walk at a broken file precisely so this surface can say so.
      const directory = tmp("broken")
      fs.writeFileSync(path.join(directory, "novaclaw.json"), "{ not json")
      const response = yield* requestInDirectory(ExperimentalPaths.project, directory)
      expect(response.status).toBe(200)
      const body: Record<string, unknown> = JSON.parse(yield* response.text)
      expect(body["kind"]).toBe("invalid")
      expect(body["reason"]).toBe("unreadable")
      expect(body["file"]).toBe(path.join(directory, "novaclaw.json"))
    }),
  )

  it.effect("a file from a NEWER NovaClaw says so, rather than reading as corruption", () =>
    Effect.gen(function* () {
      const directory = tmp("future")
      fs.writeFileSync(path.join(directory, "novaclaw.json"), JSON.stringify({ version: 9999 }))
      const response = yield* requestInDirectory(ExperimentalPaths.project, directory)
      const body: Record<string, unknown> = JSON.parse(yield* response.text)
      // Upgrade, versus fix your file. The caller must be able to tell a user which.
      expect(body["reason"]).toBe("future-version")
    }),
  )
})
