import { afterEach, describe, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { ExperimentalPaths } from "../../src/server/routes/instance/httpapi/groups/experimental"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { testEffectShared } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

/**
 * **`GET /api/project` — what governs this folder, and why.**
 *
 * A `novaclaw.json` can NARROW a session's permissions, so a user whose tool call is refused needs
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

  // 🔴 **This asserted the OPPOSITE until 2026-09-01, and the reversal is deliberate.** It read
  // "never reports a valid or malformed file above a non-repository location root" and expected
  // `none`. It arrived in the same change as `trustedBoundary`, whose boundary outside a repository
  // was the selected folder — which does not tighten the feature so much as switch it off, because a
  // project file exists to govern the folders BENEATH it. Three tests that PREDATE that change say
  // so, including `httpapi-project-write-invalidates.test.ts` one directory away, which requires a
  // session in `<root>/sub` to pick up a file written at `<root>`. A test added alongside the
  // behaviour it pins cannot referee a conflict with the behaviour that was already shipped.
  //
  // The floor outside a repository is HOME, which is where the rule stood before and what the real
  // containment claim is about: a file ABOVE home would otherwise govern every session on the
  // machine. `project-file-cache-invalidate.test.ts` drives that boundary directly.
  it.effect("reports a file in the PARENT of a non-repository folder — that is what a project file is for", () =>
    Effect.gen(function* () {
      const parent = tmp("outside-parent")
      const directory = path.join(parent, "selected")
      fs.mkdirSync(directory)
      fs.writeFileSync(path.join(parent, "novaclaw.json"), JSON.stringify({ version: 1, name: "outside" }))
      const response = yield* requestInDirectory(ExperimentalPaths.project, directory)
      expect(response.status).toBe(200)
      const body: Record<string, unknown> = JSON.parse(yield* response.text)
      expect(body["kind"]).toBe("project")
      expect(body["root"]).toBe(parent)
    }),
  )

  it.effect("a malformed file in that parent is reported as a FAULT, never flattened to `none`", () =>
    Effect.gen(function* () {
      // Ruling 2's shape at the presentation layer: a file we could not read is said out loud, because
      // "no project here" and "your project file is broken" send a reader to different places.
      const parent = tmp("outside-parent-bad")
      const directory = path.join(parent, "selected")
      fs.mkdirSync(directory)
      fs.writeFileSync(path.join(parent, "novaclaw.json"), "{ broken")
      const response = yield* requestInDirectory(ExperimentalPaths.project, directory)
      expect(response.status).toBe(200)
      expect(JSON.parse(yield* response.text)["kind"]).toBe("invalid")
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
      fs.writeFileSync(path.join(directory, "novaclaw.json"), JSON.stringify({ version: 1, exclude: ["node_modules"] }))
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

describe("GET /api/project — the `skills` section", () => {
  /**
   * 🔴 The route reports what is IN FORCE, already narrowed, plus what it declined to act on.
   *
   * A project may HIDE a skill from the user's own slash menu and may never UN-HIDE one the instance
   * hid — a `novaclaw.json` travels inside a repository somebody cloned. `skills` is therefore a list
   * of ids the folder hides, and a `{"show":true}` never appears in it. It is not silently dropped
   * either: `skillsRefused` names it, because the person who wrote a line that does nothing has to be
   * told, and the file is otherwise perfectly valid.
   *
   * ⚠️ **A/B, run by hand and reported:** make the handler send `resolution.info.skills` keys instead
   * of `narrowSkills(...).hidden` — the second case below goes red.
   */
  it.effect("🔴 a `show:false` is reported as hidden; a `show:true` is refused, never hidden", () =>
    Effect.gen(function* () {
      const directory = tmp("skills")
      fs.writeFileSync(
        path.join(directory, "novaclaw.json"),
        JSON.stringify({
          version: 1,
          skills: { "hidden-one": { show: false }, "asked-back": { show: true }, "no-opinion": {} },
        }),
      )
      const response = yield* requestInDirectory(ExperimentalPaths.project, directory)
      expect(response.status).toBe(200)
      const body: Record<string, unknown> = JSON.parse(yield* response.text)
      expect(body["kind"]).toBe("project")
      expect(body["skills"]).toEqual(["hidden-one"])
      expect(body["skillsRefused"]).toEqual(["asked-back"])
    }),
  )

  it.effect("a project with no `skills` section reports two empty lists, not absent fields", () =>
    Effect.gen(function* () {
      const directory = tmp("noskills")
      fs.writeFileSync(path.join(directory, "novaclaw.json"), JSON.stringify({ version: 1 }))
      const response = yield* requestInDirectory(ExperimentalPaths.project, directory)
      const body: Record<string, unknown> = JSON.parse(yield* response.text)
      expect(body["skills"]).toEqual([])
      expect(body["skillsRefused"]).toEqual([])
    }),
  )

  it.effect("🔴 a skill named `__proto__` travels as an ordinary id", () =>
    Effect.gen(function* () {
      const directory = tmp("proto")
      // Written as TEXT: `{__proto__: v}` in source sets a prototype and serialises as `{}`, so an
      // object literal here would test nothing at all.
      fs.writeFileSync(path.join(directory, "novaclaw.json"), '{"version":1,"skills":{"__proto__":{"show":false}}}')
      const response = yield* requestInDirectory(ExperimentalPaths.project, directory)
      const body: Record<string, unknown> = JSON.parse(yield* response.text)
      expect(body["skills"]).toEqual(["__proto__"])
    }),
  )
})

describe("GET /api/project — the `tune` the folder puts in force", () => {
  /**
   * 🔴 **The route said WHICH file governs and never WHAT it sets, and that gap was a false
   * statement on screen.** The composer's Tune panel keys provenance on a session id, so a DRAFT had
   * none and every switch read as the instance's. Measured in dev Electron 2026-08-19: a draft in a
   * folder declaring `quality: true` rendered *"Quality gates … Using Settings default: Off"* one
   * line below a sentence naming the file that sets it on.
   *
   * ⚠️ What is asserted here is the WIRING — that the kernel's own fold reaches the wire. The fold
   * itself is `packages/core/test/folder-stance.test.ts`, and it is called rather than re-derived for
   * the same reason `narrowSkills` is: two implementations of one narrowing rule is one too many.
   */
  it.effect("carries the switches a chat created here would start with, and names them", () =>
    Effect.gen(function* () {
      const directory = tmp("tune")
      fs.writeFileSync(
        path.join(directory, "novaclaw.json"),
        JSON.stringify({ version: 1, tune: { features: { quality: true, introspection: false } } }),
      )
      const response = yield* requestInDirectory(ExperimentalPaths.project, directory)
      expect(response.status).toBe(200)
      const body: Record<string, unknown> = JSON.parse(yield* response.text)
      const tune = body["tune"] as Record<string, unknown>
      expect(tune["features"]).toEqual({ quality: true, introspection: false })
      expect([...(tune["applied"] as string[])].sort()).toEqual(["introspection", "quality"])
      expect(tune["refused"]).toEqual([])
      expect(tune["deferred"]).toEqual([])
    }),
  )

  it.effect("a folder with no `tune` section supplies NOTHING — never a list of offs", () =>
    Effect.gen(function* () {
      // The distinction the whole `ProjectFile.Tune` discipline rests on: absent means INHERIT. A
      // route that answered `{quality:false}` here would pin every folder against the user's own
      // Settings, which is exactly what the file format refuses to let a folder do.
      const directory = tmp("notune")
      fs.writeFileSync(path.join(directory, "novaclaw.json"), JSON.stringify({ version: 1, name: "Acme" }))
      const response = yield* requestInDirectory(ExperimentalPaths.project, directory)
      const body: Record<string, unknown> = JSON.parse(yield* response.text)
      expect(body["tune"]).toEqual({ features: {}, applied: [], refused: [], deferred: [] })
    }),
  )

  it.effect("the answer comes from the NEAREST governing file, ancestor included", () =>
    Effect.gen(function* () {
      // A nested folder follows the file above it, and the panel names that file — so the tune it
      // reports has to be that file's, not an empty one because the leaf folder holds no `.json`.
      const root = yield* tmpdirScoped({ git: true })
      fs.writeFileSync(
        path.join(root, "novaclaw.json"),
        JSON.stringify({ version: 1, tune: { features: { affective: true } } }),
      )
      const nested = path.join(root, "packages", "app")
      fs.mkdirSync(nested, { recursive: true })
      const response = yield* requestInDirectory(ExperimentalPaths.project, nested)
      const body: Record<string, unknown> = JSON.parse(yield* response.text)
      expect(body["root"]).toBe(root)
      expect((body["tune"] as Record<string, unknown>)["features"]).toEqual({ affective: true })
    }),
  )

  it.effect("a `mode` a folder may declare is not smuggled in as a switch", () =>
    Effect.gen(function* () {
      // `tune.mode` is a different kind of thing (the kernel thread type) and only `interactive` is
      // expressible at all. It must not appear among the feature switches this panel renders.
      const directory = tmp("tunemode")
      fs.writeFileSync(
        path.join(directory, "novaclaw.json"),
        JSON.stringify({ version: 1, tune: { mode: "interactive", features: { memory: false } } }),
      )
      const response = yield* requestInDirectory(ExperimentalPaths.project, directory)
      const body: Record<string, unknown> = JSON.parse(yield* response.text)
      expect((body["tune"] as Record<string, unknown>)["features"]).toEqual({ memory: false })
    }),
  )
})
