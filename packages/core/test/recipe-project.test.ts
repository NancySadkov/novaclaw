import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@novaclaw/effect-drizzle-sqlite"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { AgentConfigTable } from "@novaclaw/core/agent-config/sql"
import { Database } from "@novaclaw/core/database/database"
import { DatabaseMigration } from "@novaclaw/core/database/migration"
import { Recipe } from "@novaclaw/core/recipe"
import * as Deployment from "@novaclaw/core/recipe-deployment"
import { deployRecipeProject } from "@novaclaw/core/work-project/deploy"
import { WorkProjects } from "@novaclaw/core/work-project/store"
import { ProjectNoticeTable, WorkProjectTable } from "@novaclaw/core/work-project/sql"
import { Nudge } from "@novaclaw/core/nudge"

let homeDirectory: string
let recipesRoot: string
const prototypes = [
  {
    title: "Builder",
    description: "Build the page. Report to your manager.",
    nudges: [{ name: "Remember", text: "Check the acceptance criteria.", hook: { type: "after-compaction" as const } }],
  },
]
beforeEach(async () => {
  homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "novaclaw-recipe-project-"))
  recipesRoot = path.join(homeDirectory, "recipes")
  await Recipe.save({ name: "Observatory", prompt: "Make index.html", officers: prototypes }, { root: recipesRoot })
})
afterEach(async () => {
  await fs.rm(homeDirectory, { recursive: true, force: true })
})

test("officer prototypes survive source edits and .nova round trips; nudges match their events", async () => {
  const source = await Recipe.sourceOf("observatory", { root: recipesRoot })
  const changed = Recipe.edit(source!, { description: "A team project" })
  expect(Recipe.parse(changed).officers).toEqual(prototypes)
  const archive = await Recipe.exportArchive("observatory", { root: recipesRoot })
  expect(Recipe.previewArchive(archive).officers).toEqual(prototypes)
  const copy = await Recipe.importArchive(archive, { root: recipesRoot })
  expect(copy.officers).toEqual(prototypes)
  expect(Nudge.matches({ ...prototypes[0]!.nudges[0]!, id: "test" }, { type: "compaction", id: "epoch" })).toBe(true)
  for (const officers of [
    [{ title: "Builder", description: "Build", nudges: [], permissions: "all" }],
    [
      {
        title: "Builder",
        description: "Build",
        nudges: [{ name: "Bad", text: "Run", hook: { type: "script", command: "anything" } }],
      },
    ],
  ])
    expect(() => Recipe.parse(JSON.stringify({ version: 1, name: "X", prompt: "Build", officers }))).toThrow()
  await expect(
    Recipe.importSource(JSON.stringify({ version: 1, name: "Imported recipe", officers: "broken", prompt: "Build" }), {
      root: recipesRoot,
    }),
  ).rejects.toThrow("Invalid recipe.json")
  await fs.mkdir(path.join(recipesRoot, "broken"))
  await fs.writeFile(
    path.join(recipesRoot, "broken", "recipe.json"),
    JSON.stringify({ version: 1, name: "Imported recipe", officers: "broken", prompt: "Build" }),
  )
  expect((await Recipe.list({ root: recipesRoot })).some((recipe) => recipe.slug === "observatory")).toBe(true)
  await expect(Recipe.read("broken", { root: recipesRoot })).rejects.toThrow("Invalid recipe.json")
})

test("destinations are exclusive, launch targets contained, and undeploy preserves an unowned folder", async () => {
  const directory = path.join(homeDirectory, "custom")
  await Deployment.materialize("observatory", "project-one", { directory, recipesRoot })
  await fs.writeFile(path.join(directory, "kept.txt"), "keep")
  await expect(Deployment.materialize("observatory", "project-two", { directory, recipesRoot })).rejects.toThrow(
    "already exists",
  )
  await expect(Deployment.remove("project-two", directory)).rejects.toThrow("ownership")
  expect(await fs.readFile(path.join(directory, "kept.txt"), "utf8")).toBe("keep")
  await fs.writeFile(
    path.join(directory, ".nova-launch.json"),
    JSON.stringify({ kind: "html", path: "../outside.html" }),
  )
  expect(await Deployment.readyLaunch(directory)).toBeUndefined()
  await expect(
    Deployment.materialize("observatory", "project-two", { directory: "relative", recipesRoot }),
  ).rejects.toThrow("absolute")
})

test("deployment atomically staffs a project; only its manager receives kickoff and manages its phases", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.run("PRAGMA foreign_keys = ON")
      yield* DatabaseMigration.apply(db)
      return yield* Effect.gen(function* () {
        const agents = yield* AgentConfigStore.Service
        const id = yield* deployRecipeProject({
          slug: "observatory",
          recipesRoot,
          homeDirectory,
          model: "fixture/model",
        })
        const row = (yield* db.select().from(WorkProjectTable).where(eq(WorkProjectTable.id, id)).get())!
        expect(path.dirname(row.directory!)).toBe(path.join(homeDirectory, "projects"))
        expect(yield* Effect.promise(() => fs.readFile(path.join(row.directory!, "recipe.json"), "utf8"))).toContain(
          "Make index.html",
        )
        const roster = yield* agents.agents()
        const manager = row.recipe!.manager
        const officer = row.recipe!.officers.find((id) => id !== manager)!
        expect(AgentConfigStore.fold(roster[manager]!)!).toMatchObject({
          title: "Manager",
          superior: "nova",
          model: "fixture/model",
        })
        expect(AgentConfigStore.fold(roster[officer]!)!).toMatchObject({
          title: "Builder",
          superior: manager,
          system: prototypes[0]!.description,
        })
        expect(AgentConfigStore.fold(roster[officer]!)!.nudges!.some((nudge) => nudge.name === "Remember")).toBe(true)
        expect((yield* db.select().from(ProjectNoticeTable).all()).map((row) => row.agent)).toEqual([manager])
        const delivered: Array<{ agent: string; delivery: string }> = []
        const projects = WorkProjects.fromParts({
          db,
          agents,
          notify: (agent, _text, _id, delivery) =>
            Effect.sync(() => {
              delivered.push({ agent, delivery })
            }),
        })
        yield* projects.flush
        expect(delivered).toEqual([{ agent: manager, delivery: "queue" }])
        const snapshot = yield* projects.execute({ op: "list" }, manager)
        expect(snapshot.projects[0]!.totalOfficers).toBe(2)
        yield* projects.execute({ op: "phase", id, phaseID: "prepare", status: "complete" }, manager)
        expect((yield* projects.execute({ op: "list" })).projects[0]!.completedPhases).toBe(1)
        expect((yield* Effect.exit(projects.execute({ op: "pause", id, paused: true }, manager)))._tag).toBe("Failure")
        expect((yield* Effect.exit(projects.execute({ op: "list" }, officer)))._tag).toBe("Failure")
        const another = yield* deployRecipeProject({ slug: "observatory", recipesRoot, homeDirectory })
        expect(another).not.toBe(id)
        expect(
          (yield* Effect.exit(
            projects.execute({ op: "phase", id: another, phaseID: "prepare", status: "complete" }, manager),
          ))._tag,
        ).toBe("Failure")
        expect((yield* db.select().from(AgentConfigTable).all()).length).toBe(4)
        expect(
          (yield* projects.execute({ op: "phase", id, phaseID: "build", status: "complete" }, manager)).projects.map(
            (item) => item.id,
          ),
        ).toEqual([id])
        yield* db.run(
          "CREATE TRIGGER refuse_project BEFORE INSERT ON work_project BEGIN SELECT RAISE(ABORT, 'test storage fault'); END",
        )
        const refusedDirectory = path.join(homeDirectory, "refused")
        expect(
          (yield* Effect.exit(deployRecipeProject({ slug: "observatory", recipesRoot, directory: refusedDirectory })))
            ._tag,
        ).toBe("Failure")
        expect(
          yield* Effect.promise(() =>
            fs.stat(refusedDirectory).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false)
        expect((yield* db.select().from(AgentConfigTable).all()).length).toBe(4)
        expect((yield* db.select().from(WorkProjectTable).all()).length).toBe(2)
      }).pipe(Effect.provide(AgentConfigStore.layer), Effect.provideService(Database.Service, { db }))
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  ))
