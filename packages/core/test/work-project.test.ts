import { describe, expect, test } from "bun:test"
import path from "node:path"
import { eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@novaclaw/effect-drizzle-sqlite"
import { WorkProject } from "@novaclaw/schema/work-project"
import { ConfigAgent } from "@novaclaw/core/config/agent"
import type { Database } from "@novaclaw/core/database/database"
import { DatabaseMigration } from "@novaclaw/core/database/migration"
import recipeMigration from "@novaclaw/core/database/migration/20260930002633_recipe_projects"
import directoryMigration from "@novaclaw/core/database/migration/20260928002558_work_project_directory"
import { SessionExecutionAttempt } from "@novaclaw/core/session/execution-attempt"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionExecutionTable, SessionTable } from "@novaclaw/core/session/sql"
import { WorkProjects } from "@novaclaw/core/work-project/store"
import { ProjectNoticeTable, ProjectOfficerTable } from "@novaclaw/core/work-project/sql"

type Db = Database.Interface["db"]
const plan = [
  { id: "research", name: "Research", status: "pending" as const },
  { id: "ship", name: "Ship", status: "pending" as const },
]
const create = { op: "create" as const, name: "Observatory", objective: "Build an observatory", phases: plan }
const config = (value: Record<string, unknown>) => Schema.decodeUnknownSync(ConfigAgent.Info)(value)
const roster = {
  iris: [config({ name: "Iris", title: "Engineer" })],
  lyra: [config({ name: "Lyra", disabled: true })],
  nova: [config({})],
  chat: [config({ kind: "chat" })],
  service: [config({ hidden: true })],
}

const fixture = <A>(
  run: (input: {
    db: Db
    projects: WorkProjects.Interface
    notices: Array<{ agent: string; text: string }>
    reopen: () => WorkProjects.Interface
  }) => Effect.Effect<A, unknown>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.run("PRAGMA foreign_keys = ON")
      yield* DatabaseMigration.apply(db)
      const notices: Array<{ agent: string; text: string }> = []
      const agents = { agents: () => Effect.succeed(roster) }
      const reopen = () =>
        WorkProjects.fromParts({
          db,
          agents,
          notify: (agent, text) =>
            Effect.sync(() => {
              notices.push({ agent, text })
            }),
        })
      return yield* run({ db, projects: reopen(), notices, reopen })
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const session = (db: Db, name: string, parent?: string, archived?: number) =>
  db
    .insert(SessionTable)
    .values({
      id: SessionSchema.ID.make(name),
      agent: parent ? "worker" : "iris",
      parent_id: parent ? SessionSchema.ID.make(parent) : null,
      slug: name,
      title: name,
      directory: "C:/test/projects",
      version: "test",
      time_archived: archived,
    })
    .run()

describe("work projects", () => {
  test("upgrading a populated project table matches a fresh database", () =>
    fixture(({ db }) =>
      Effect.gen(function* () {
        const columns = () =>
          db
            .all<{
              name: string
              type: string
              notnull: number
              dflt_value: string | null
            }>("PRAGMA table_info(work_project)")
            .pipe(
              Effect.map((rows) =>
                rows
                  .map(({ name, type, notnull, dflt_value }) => ({ name, type, notnull, dflt_value }))
                  .sort((a, b) => a.name.localeCompare(b.name)),
              ),
            )
        const fresh = yield* columns()
        yield* db.run("DROP TABLE work_project")
        yield* db.run(
          "CREATE TABLE work_project (id text PRIMARY KEY, name text NOT NULL, objective text NOT NULL, phases text NOT NULL, paused integer DEFAULT false NOT NULL, revision integer DEFAULT 1 NOT NULL)",
        )
        yield* db.run(
          "INSERT INTO work_project (id, name, objective, phases) VALUES ('existing', 'Old project', 'Keep the data', '[]')",
        )
        yield* db.run("DELETE FROM migration WHERE id = '20260928002558_work_project_directory'")
        yield* db.run("DELETE FROM migration WHERE id = '20260930002633_recipe_projects'")
        yield* DatabaseMigration.applyOnly(db, [directoryMigration, recipeMigration])
        expect(yield* columns()).toEqual(fresh)
        expect(yield* db.all("SELECT id, objective, directory FROM work_project")).toEqual([
          { id: "existing", objective: "Keep the data", directory: null },
        ])
      }),
    ))
  test("server folders persist, reach officers, survive omitted edits and can be cleared", () =>
    fixture(({ projects, reopen, notices }) =>
      Effect.gen(function* () {
        const directory = path.resolve(import.meta.dirname)
        let project = (yield* projects.execute({ ...create, directory })).projects[0]!
        expect((yield* reopen().execute({ op: "list" })).projects[0]!.directory).toBe(directory)
        yield* projects.execute({ op: "assign", officer: "iris", projectID: project.id })
        expect(notices.at(-1)!.text).toContain(JSON.stringify(directory))
        expect(notices.at(-1)!.text).toContain("working directory for shell commands")
        project = (yield* projects.execute({ ...create, op: "edit", id: project.id, revision: project.revision }))
          .projects[0]!
        expect(project.directory).toBe(directory)
        project = (yield* projects.execute({ ...project, op: "edit", directory: null })).projects[0]!
        expect(project.directory).toBeNull()
        expect(notices.at(-1)!.text).toContain("No project folder is assigned")
      }),
    ))

  test("rejects relative paths, files and missing server folders without saving a project", () =>
    fixture(({ projects }) =>
      Effect.gen(function* () {
        for (const directory of [
          "relative/path",
          import.meta.filename,
          path.join(import.meta.dirname, crypto.randomUUID()),
        ]) {
          expect((yield* projects.execute({ ...create, directory }).pipe(Effect.flip)).message).toContain(
            "Cannot assign the project folder",
          )
        }
        expect((yield* projects.execute({ op: "list" })).projects).toEqual([])
      }),
    ))

  test("assignment delivery survives a failed notification and a restart", () =>
    fixture(({ db, projects }) =>
      Effect.gen(function* () {
        const project = (yield* projects.execute(create)).projects[0]!
        const agents = { agents: () => Effect.succeed(roster) }
        const unavailable = WorkProjects.fromParts({
          db,
          agents,
          notify: () => Effect.die("temporary delivery failure"),
        })
        yield* unavailable.execute({ op: "assign", officer: "iris", projectID: project.id })
        const pending = (yield* db.select().from(ProjectNoticeTable).all())[0]!
        expect(pending.agent).toBe("iris")
        expect(pending.text).toContain("Build an observatory")
        expect(pending.delivery).toBe("queue")
        yield* unavailable.execute({ op: "phase", id: project.id, phaseID: "research", status: "complete" })
        const latest = (yield* db.select().from(ProjectNoticeTable).all())[0]!
        expect(latest.delivery).toBe("queue")
        const delivered: Array<{ id: string; delivery: string }> = []
        const recovered = WorkProjects.fromParts({
          db,
          agents,
          notify: (_agent, _text, id, delivery) =>
            Effect.sync(() => {
              delivered.push({ id, delivery })
            }),
        })
        yield* recovered.flush
        yield* recovered.flush
        expect(delivered).toEqual([{ id: latest.id, delivery: "queue" }])
        expect(yield* db.select().from(ProjectNoticeTable).all()).toEqual([])
      }),
    ))
  test("persists ordered phases, progress and pause across service reconstruction", () =>
    fixture(({ projects, reopen }) =>
      Effect.gen(function* () {
        const project = (yield* projects.execute(create)).projects[0]!
        expect(project).toMatchObject({
          completedPhases: 0,
          totalPhases: 2,
          workingOfficers: 0,
          totalOfficers: 0,
          paused: false,
          revision: 1,
        })
        yield* projects.execute({ op: "phase", id: project.id, phaseID: "research", status: "complete" })
        yield* projects.execute({ op: "pause", id: project.id, paused: true })
        const restored = (yield* reopen().execute({ op: "list" })).projects[0]!
        expect(restored).toMatchObject({ completedPhases: 1, totalPhases: 2, paused: true, revision: 3 })
        expect(restored.phases.map((phase) => phase.id)).toEqual(["research", "ship"])
        yield* projects.execute({ op: "phase", id: project.id, phaseID: "research", status: "pending" })
        expect((yield* projects.execute({ op: "list" })).projects[0]!.completedPhases).toBe(0)
      }),
    ))

  test("edits are atomic and reject stale revisions rather than overwriting a phase update", () =>
    fixture(({ projects }) =>
      Effect.gen(function* () {
        const project = (yield* projects.execute(create)).projects[0]!
        yield* projects.execute({ op: "phase", id: project.id, phaseID: "research", status: "complete" })
        const stale = yield* projects.execute({ op: "edit", ...project, name: "Stale edit" }).pipe(Effect.flip)
        expect(stale.message).toContain("changed while you were editing")
        const latest = (yield* projects.execute({ op: "list" })).projects[0]!
        const edited = (yield* projects.execute({
          op: "edit",
          ...latest,
          name: "New name",
          objective: "New objective",
          phases: [...latest.phases].reverse(),
        })).projects[0]!
        expect(edited.name).toBe("New name")
        expect(edited.objective).toBe("New objective")
        expect(edited.phases.map((phase) => phase.id)).toEqual(["ship", "research"])
        expect(edited.completedPhases).toBe(1)
      }),
    ))

  test("one officer has one assignment; reassignment and release deliver updated context", () =>
    fixture(({ projects, notices }) =>
      Effect.gen(function* () {
        const first = (yield* projects.execute(create)).projects[0]!
        const second = (yield* projects.execute({ ...create, name: "Ziggurat" })).projects.find(
          (project) => project.id !== first.id,
        )!
        yield* projects.execute({ op: "assign", officer: "iris", projectID: first.id })
        let result = yield* projects.execute({ op: "assign", officer: "iris", projectID: second.id })
        expect(result.projects.find((project) => project.id === first.id)!.totalOfficers).toBe(0)
        expect(result.projects.find((project) => project.id === second.id)!.totalOfficers).toBe(1)
        expect(notices.at(-1)!.text).toContain("Ziggurat")
        result = yield* projects.execute({ op: "assign", officer: "iris", projectID: null })
        expect(result.officers.find((officer) => officer.id === "iris")!.projectID).toBeNull()
        expect(notices.at(-1)!.text).toContain("assignment has ended")
      }),
    ))

  test("project hold reaches grandchildren, survives reload, and never rewrites personal pause", () =>
    fixture(({ db, projects, reopen }) =>
      Effect.gen(function* () {
        yield* session(db, "ses_root")
        yield* session(db, "ses_child", "ses_root")
        yield* session(db, "ses_grandchild", "ses_child")
        const project = (yield* projects.execute(create)).projects[0]!
        yield* projects.execute({ op: "assign", officer: "iris", projectID: project.id })
        yield* projects.execute({ op: "assign", officer: "lyra", projectID: project.id })
        yield* projects.execute({ op: "pause", id: project.id, paused: true })
        expect(yield* WorkProjects.held(db, SessionSchema.ID.make("ses_grandchild"))).toBe(true)
        expect((yield* reopen().execute({ op: "list" })).projects[0]!.paused).toBe(true)
        const resumed = yield* projects.execute({ op: "pause", id: project.id, paused: false })
        expect(yield* WorkProjects.held(db, SessionSchema.ID.make("ses_grandchild"))).toBe(false)
        expect(resumed.officers.find((officer) => officer.id === "lyra")!.paused).toBe(true)
        expect(roster.lyra[0]!.disabled).toBe(true)
      }),
    ))

  test("working counts deduplicate an officer's workers and exclude archived sessions", () =>
    fixture(({ db, projects }) =>
      Effect.gen(function* () {
        yield* session(db, "ses_root")
        yield* session(db, "ses_child", "ses_root")
        yield* session(db, "ses_old", "ses_root", Date.now())
        const project = (yield* projects.execute(create)).projects[0]!
        yield* projects.execute({ op: "assign", officer: "iris", projectID: project.id })
        for (const id of ["ses_root", "ses_child", "ses_old"])
          yield* db
            .insert(SessionExecutionTable)
            .values({
              session_id: SessionSchema.ID.make(id),
              attempt_id: `exe_${id}`,
              generation: 1,
              owner_id: "host",
              state: "busy",
              phase: "provider",
              heartbeat_at: Date.now(),
              started_at: Date.now(),
              time_updated: Date.now(),
            })
            .run()
        expect((yield* projects.execute({ op: "list" })).projects[0]).toMatchObject({
          workingOfficers: 1,
          totalOfficers: 1,
        })
        yield* db
          .update(SessionExecutionTable)
          .set({ state: "paused" })
          .where(eq(SessionExecutionTable.session_id, SessionSchema.ID.make("ses_root")))
          .run()
        expect((yield* projects.execute({ op: "list" })).projects[0]!.workingOfficers).toBe(1)
        yield* db
          .update(SessionExecutionTable)
          .set({ state: "paused" })
          .where(eq(SessionExecutionTable.session_id, SessionSchema.ID.make("ses_child")))
          .run()
        expect((yield* projects.execute({ op: "list" })).projects[0]!.workingOfficers).toBe(0)
      }),
    ))

  test("pause fences stale executions and preserves unfinished provider obligations", () =>
    fixture(({ db }) =>
      Effect.gen(function* () {
        yield* session(db, "ses_root")
        const sessionID = SessionSchema.ID.make("ses_root")
        const lease = { sessionID, attemptID: "exe_hold", generation: 2, ownerID: "host" }
        yield* db
          .insert(SessionExecutionTable)
          .values({
            session_id: sessionID,
            attempt_id: lease.attemptID,
            generation: 2,
            owner_id: "host",
            state: "busy",
            phase: "provider",
            failure_class: "provider",
            failure_count: 3,
            heartbeat_at: 1,
            started_at: 1,
            time_updated: 1,
          })
          .run()
        yield* SessionExecutionAttempt.pause(db, { ...lease, generation: 1 })
        expect((yield* db.select().from(SessionExecutionTable).get())!.state).toBe("busy")
        yield* SessionExecutionAttempt.pause(db, lease)
        expect(yield* db.select().from(SessionExecutionTable).get()).toMatchObject({
          state: "paused",
          failure_class: "provider",
          failure_count: 3,
        })
      }),
    ))

  test("deletion releases all assignments without deleting chats and rejects stale deletes", () =>
    fixture(({ db, projects, notices }) =>
      Effect.gen(function* () {
        yield* session(db, "ses_root")
        const project = (yield* projects.execute(create)).projects[0]!
        yield* projects.execute({ op: "assign", officer: "iris", projectID: project.id })
        yield* projects.execute({ op: "pause", id: project.id, paused: true })
        expect(
          (yield* projects.execute({ op: "delete", id: project.id, revision: 1 }).pipe(Effect.flip)).message,
        ).toContain("changed")
        const result = yield* projects.execute({ op: "delete", id: project.id, revision: 2 })
        expect(result.projects).toEqual([])
        expect(yield* db.select().from(ProjectOfficerTable).all()).toEqual([])
        expect(yield* db.select().from(SessionTable).all()).toHaveLength(1)
        expect(yield* WorkProjects.held(db, SessionSchema.ID.make("ses_root"))).toBe(false)
        expect(notices.at(-1)!.text).toContain("assignment has ended")
      }),
    ))

  test("rejects blank fields, duplicate phases, missing projects and ineligible officers", () =>
    fixture(({ projects }) =>
      Effect.gen(function* () {
        expect((yield* projects.execute({ ...create, name: " " }).pipe(Effect.flip)).message).toContain("name")
        expect(
          (yield* projects.execute({ ...create, phases: [plan[0]!, plan[0]!] }).pipe(Effect.flip)).message,
        ).toContain("unique")
        const project = (yield* projects.execute({ ...create, phases: [] })).projects[0]!
        expect(project).toMatchObject({ completedPhases: 0, totalPhases: 0 })
        for (const officer of ["nova", "chat", "service", "missing"])
          expect(
            (yield* projects.execute({ op: "assign", officer, projectID: project.id }).pipe(Effect.flip)).message,
          ).toContain("existing officer")
        expect(
          (yield* projects.execute({ op: "assign", officer: "iris", projectID: "missing" }).pipe(Effect.flip)).message,
        ).toContain("no longer exists")
        expect(
          (yield* projects
            .execute({ op: "phase", id: project.id, phaseID: "missing", status: "complete" })
            .pipe(Effect.flip)).message,
        ).toContain("phase no longer exists")
      }),
    ))

  test("wire schema limits project size and keeps phase status closed", () => {
    const decode = Schema.decodeUnknownSync(WorkProject.Command)
    expect(() => decode({ ...create, phases: [{ id: "a", name: "A", status: "working" }] })).toThrow()
    expect(() =>
      decode({
        ...create,
        phases: Array.from({ length: 257 }, (_, i) => ({ id: String(i), name: "Phase", status: "pending" })),
      }),
    ).toThrow()
    expect(() => decode({ ...create, objective: "x".repeat(16001) })).toThrow()
  })
})
