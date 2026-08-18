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
      expect(body["permissionRules"]).toBe(1)
      // 🔴 And the RULES, not only their count. The count shipped alone with a comment claiming the
      // permission surface rendered them; none did, so a user refused by their folder's file could
      // see that one rule governed them and never which one.
      expect(body["permissions"]).toEqual([{ action: "bash", resource: "*", effect: "deny" }])
      expect(body["exclude"]).toEqual(["secrets/**"])
      // No `.gitignore` beside the file, so no proposal — ABSENT, not an empty one. "Nothing to
      // import" and "no file to import from" are different sentences on screen.
      expect("gitignore" in body).toBe(false)
    }),
  )

  it.effect("🔴 offers what a .gitignore beside the project file WOULD add, and applies none of it", () =>
    Effect.gen(function* () {
      const directory = tmp("gitignore")
      fs.writeFileSync(
        path.join(directory, "novaclaw.json"),
        JSON.stringify({ version: 1, exclude: ["node_modules"] }),
      )
      fs.writeFileSync(
        path.join(directory, ".gitignore"),
        ["# deps", "node_modules", "", "/dist", "*.env", "!.env.example", String.raw`weird\ name`].join("\n"),
      )
      const response = yield* requestInDirectory(ExperimentalPaths.project, directory)
      const body: Record<string, unknown> = JSON.parse(yield* response.text)
      const proposal = body["gitignore"] as Record<string, unknown>
      expect(proposal["file"]).toBe(path.join(directory, ".gitignore"))
      expect(proposal["add"]).toEqual(["/dist", "*.env", "!.env.example"])
      expect(proposal["already"]).toEqual(["node_modules"])
      expect(proposal["reincludes"]).toEqual(["!.env.example"])
      // A line with a backslash cannot be honoured (escape vs path separator) and is REPORTED.
      expect(proposal["dropped"]).toEqual([{ source: String.raw`weird\ name`, reason: "escape" }])
      // 🔴 A SUGGESTION: the file on disk is untouched, and so is `exclude`.
      expect(body["exclude"]).toEqual(["node_modules"])
      expect(JSON.parse(fs.readFileSync(path.join(directory, "novaclaw.json"), "utf8"))).toEqual({
        version: 1,
        exclude: ["node_modules"],
      })
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
