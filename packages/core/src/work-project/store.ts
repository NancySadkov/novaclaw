export * as WorkProjects from "./store"

import { and, eq, inArray, isNull } from "drizzle-orm"
import fs from "node:fs/promises"
import path from "node:path"
import { Context, Effect, Layer, Schedule, Schema, Semaphore } from "effect"
import { WorkProject } from "@novaclaw/schema/work-project"
import { Log } from "@novaclaw/schema/log"
import { AgentV2 } from "../agent"
import { AgentConfigStore } from "../agent-config-store"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { ProjectV2 } from "../project"
import { ensureLiveChat } from "../session"
import { SessionInput } from "../session/input"
import { SessionMessage } from "../session/message"
import { Prompt } from "../session/prompt"
import { applySteerProvenance } from "../session/steer-provenance"
import { SessionRunCoordinator } from "../session/run-coordinator"
import { SessionSchema } from "../session/schema"
import { SessionStore } from "../session/store"
import { SessionExecutionTable, SessionInputTable, SessionMessageTable, SessionTable } from "../session/sql"
import { ProjectNoticeTable, ProjectOfficerTable, WorkProjectTable } from "./sql"

type Db = Database.Interface["db"]
type Row = typeof WorkProjectTable.$inferSelect

const serverDirectory = (value: string | null | undefined) =>
  Effect.tryPromise({
    try: async () => {
      const directory = value?.trim()
      if (!directory) return null
      if (!path.isAbsolute(directory)) throw new globalThis.Error("Use an absolute folder path on the server.")
      if (!(await fs.stat(directory)).isDirectory()) throw new globalThis.Error("The selected path is not a folder.")
      return path.normalize(directory)
    },
    catch: (cause) =>
      new Error({
        message: `Cannot assign the project folder: ${cause instanceof globalThis.Error ? cause.message : String(cause)}`,
      }),
  })

export class Error extends Schema.TaggedErrorClass<Error>()("WorkProject.Error", { message: Schema.String }) {}
export interface Interface {
  readonly execute: (command: WorkProject.Command) => Effect.Effect<WorkProject.Snapshot, Error>
}
export class Service extends Context.Service<Service, Interface>()("@novaclaw/WorkProjects") {}

export const owner = (db: Db, sessionID: SessionSchema.ID): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const visited = new Set<string>()
    let cursor: SessionSchema.ID | null = sessionID
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor)
      const row: { agent: string | null; parent: SessionSchema.ID | null } | undefined = yield* db
        .select({ agent: SessionTable.agent, parent: SessionTable.parent_id })
        .from(SessionTable)
        .where(eq(SessionTable.id, cursor))
        .get()
        .pipe(Effect.orDie)
      if (!row) return undefined
      if (!row.parent) return row.agent ?? undefined
      cursor = row.parent
    }
    return undefined
  })

export const forOfficer = (db: Db, agent: string) =>
  db
    .select({ project: WorkProjectTable })
    .from(ProjectOfficerTable)
    .innerJoin(WorkProjectTable, eq(ProjectOfficerTable.project_id, WorkProjectTable.id))
    .where(eq(ProjectOfficerTable.agent, agent))
    .get()
    .pipe(
      Effect.orDie,
      Effect.map((row) => row?.project),
    )

export const held = (db: Db, sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const agent = yield* owner(db, sessionID)
    return agent !== undefined && (yield* forOfficer(db, agent))?.paused === true
  })

export const brief = (project: Row | undefined) =>
  project
    ? `Project assignment: ${JSON.stringify(project.name)} (${project.id}). ${project.paused ? "This project is paused. Work will resume when the project is resumed." : "Work on this project toward its objective."}\nObjective: ${project.objective}\n${project.directory ? `Project folder on the server: ${JSON.stringify(project.directory)}. Use this folder for project work; pass it as the working directory for shell commands and use absolute paths for files.\n` : "No project folder is assigned.\n"}Plan:\n${project.phases.map((phase, i) => `${i + 1}. [${phase.status}] ${phase.name}`).join("\n") || "No phases yet."}\nNova coordinates project assignments and plan updates.`
    : "Your project assignment has ended. Stop pursuing that project's objective; await your next assignment or user request."

export const primeContext = (db: Db, events: EventV2.Interface, sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const agent = yield* owner(db, sessionID)
    const project = agent ? yield* forOfficer(db, agent) : undefined
    if (!project || project.paused) return
    const previous = yield* db
      .select({ id: SessionMessageTable.id })
      .from(SessionMessageTable)
      .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "assistant")))
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    if (previous) return
    const text = applySteerProvenance(brief(project))
    const pending = yield* db
      .select({ prompt: SessionInputTable.prompt })
      .from(SessionInputTable)
      .where(eq(SessionInputTable.session_id, sessionID))
      .all()
      .pipe(Effect.orDie)
    if (!pending.some((item) => item.prompt.text === text)) yield* SessionInput.steer(db, events, sessionID, text)
  })

export const fromParts = (input: {
  readonly db: Db
  readonly agents: Pick<AgentConfigStore.Interface, "agents">
  readonly notify: (agent: string, text: string, id: string) => Effect.Effect<void>
}): Interface & { readonly flush: Effect.Effect<void> } => {
  const { db } = input
  const lock = Semaphore.makeUnsafe(1)
  const flush = Effect.gen(function* () {
    const pending = yield* db.select().from(ProjectNoticeTable).all().pipe(Effect.orDie)
    for (const notice of pending) {
      yield* input.notify(notice.agent, notice.text, notice.id)
      yield* db
        .delete(ProjectNoticeTable)
        .where(and(eq(ProjectNoticeTable.agent, notice.agent), eq(ProjectNoticeTable.id, notice.id)))
        .run()
        .pipe(Effect.orDie)
    }
  })
  const roster = Effect.gen(function* () {
    const configured = yield* input.agents.agents()
    return Object.entries(configured).flatMap(([id, layers]) => {
      const config = AgentConfigStore.fold(layers)
      return id !== AgentV2.NOVA_ID && AgentV2.isColleague({ ...config, id }) && AgentV2.kindOf(config) === "agent"
        ? [{ id, name: config?.name ?? id, title: config?.title ?? "Officer", paused: config?.disabled === true }]
        : []
    })
  })
  const snapshot = Effect.gen(function* () {
    const officers = yield* roster
    const projects = yield* db
      .select()
      .from(WorkProjectTable)
      .orderBy(WorkProjectTable.name, WorkProjectTable.id)
      .all()
      .pipe(Effect.orDie)
    const assignments = yield* db.select().from(ProjectOfficerTable).all().pipe(Effect.orDie)
    const active = yield* db
      .select({ id: SessionTable.id })
      .from(SessionExecutionTable)
      .innerJoin(SessionTable, eq(SessionExecutionTable.session_id, SessionTable.id))
      .where(
        and(
          isNull(SessionTable.time_archived),
          inArray(SessionExecutionTable.state, ["starting", "busy", "recovering"]),
        ),
      )
      .all()
      .pipe(Effect.orDie)
    const working = new Set<string>()
    for (const session of active) {
      const agent = yield* owner(db, session.id)
      if (agent) working.add(agent)
    }
    const members = officers.map((officer) => ({
      ...officer,
      working: working.has(officer.id),
      projectID: assignments.find((row) => row.agent === officer.id)?.project_id ?? null,
    }))
    return {
      officers: members,
      projects: projects.map((project) => {
        const assigned = members.filter((officer) => officer.projectID === project.id)
        return {
          ...project,
          completedPhases: project.phases.filter((phase) => phase.status === "complete").length,
          totalPhases: project.phases.length,
          workingOfficers: assigned.filter((officer) => officer.working).length,
          totalOfficers: assigned.length,
        }
      }),
    }
  })
  return {
    flush: lock.withPermit(flush),
    execute: (command) =>
      lock.withPermit(
        Effect.gen(function* () {
          if (command.op === "list") return yield* snapshot
          const directory =
            (command.op === "create" || command.op === "edit") && command.directory !== undefined
              ? yield* serverDirectory(command.directory)
              : undefined
          const officers = yield* roster
          const affected = new Set<string>()
          yield* db
            .transaction(
              (tx) =>
                Effect.gen(function* () {
                  const invalid = (message: string) => new Error({ message })
                  const validate = (name: string, objective: string, phases: readonly WorkProject.Phase[]) => {
                    if (!name.trim() || !objective.trim()) return "Give the project a name and an objective."
                    if (phases.some((phase) => !phase.id.trim() || !phase.name.trim()))
                      return "Each phase needs a name and an ID."
                    if (new Set(phases.map((phase) => phase.id)).size !== phases.length)
                      return "Phase IDs must be unique."
                  }
                  if (command.op === "create") {
                    const problem = validate(command.name, command.objective, command.phases)
                    if (problem) return yield* invalid(problem)
                    yield* tx
                      .insert(WorkProjectTable)
                      .values({
                        id: `prj_${crypto.randomUUID()}`,
                        name: command.name.trim(),
                        objective: command.objective.trim(),
                        directory,
                        phases: command.phases,
                      })
                      .run()
                    return
                  }
                  if (command.op === "assign") {
                    if (!officers.some((officer) => officer.id === command.officer))
                      return yield* invalid(
                        "Choose an existing officer. Nova oversees all projects; Chat, human and service agents cannot be assigned.",
                      )
                    if (
                      command.projectID !== null &&
                      !(yield* tx
                        .select()
                        .from(WorkProjectTable)
                        .where(eq(WorkProjectTable.id, command.projectID))
                        .get())
                    )
                      return yield* invalid("This project no longer exists.")
                    const previous = yield* tx
                      .select()
                      .from(ProjectOfficerTable)
                      .where(eq(ProjectOfficerTable.agent, command.officer))
                      .get()
                    if ((previous?.project_id ?? null) === command.projectID) return
                    if (command.projectID === null)
                      yield* tx.delete(ProjectOfficerTable).where(eq(ProjectOfficerTable.agent, command.officer)).run()
                    else
                      yield* tx
                        .insert(ProjectOfficerTable)
                        .values({ agent: command.officer, project_id: command.projectID })
                        .onConflictDoUpdate({
                          target: ProjectOfficerTable.agent,
                          set: { project_id: command.projectID },
                        })
                        .run()
                    affected.add(command.officer)
                    return
                  }
                  const project = yield* tx
                    .select()
                    .from(WorkProjectTable)
                    .where(eq(WorkProjectTable.id, command.id))
                    .get()
                  if (!project) return yield* invalid("This project no longer exists.")
                  if ((command.op === "edit" || command.op === "delete") && command.revision !== project.revision)
                    return yield* invalid(
                      "This project changed while you were editing. Reload it before saving or deleting.",
                    )
                  const assigned = yield* tx
                    .select()
                    .from(ProjectOfficerTable)
                    .where(eq(ProjectOfficerTable.project_id, project.id))
                    .all()
                  for (const officer of assigned) affected.add(officer.agent)
                  if (command.op === "delete") {
                    yield* tx.delete(WorkProjectTable).where(eq(WorkProjectTable.id, project.id)).run()
                    return
                  }
                  let update: Partial<Row>
                  if (command.op === "edit") {
                    const problem = validate(command.name, command.objective, command.phases)
                    if (problem) return yield* invalid(problem)
                    update = {
                      name: command.name.trim(),
                      objective: command.objective.trim(),
                      phases: command.phases,
                      ...(directory !== undefined ? { directory } : {}),
                    }
                  } else if (command.op === "pause") update = { paused: command.paused }
                  else {
                    if (!project.phases.some((phase) => phase.id === command.phaseID))
                      return yield* invalid("This phase no longer exists. Reload the plan.")
                    update = {
                      phases: project.phases.map((phase) =>
                        phase.id === command.phaseID ? { ...phase, status: command.status } : phase,
                      ),
                    }
                  }
                  yield* tx
                    .update(WorkProjectTable)
                    .set({ ...update, revision: project.revision + 1 })
                    .where(eq(WorkProjectTable.id, project.id))
                    .run()
                }).pipe(
                  Effect.andThen(
                    Effect.gen(function* () {
                      for (const agent of affected) {
                        const assigned = yield* tx
                          .select({ project: WorkProjectTable })
                          .from(ProjectOfficerTable)
                          .innerJoin(WorkProjectTable, eq(ProjectOfficerTable.project_id, WorkProjectTable.id))
                          .where(eq(ProjectOfficerTable.agent, agent))
                          .get()
                        const notice = { agent, id: crypto.randomUUID(), text: brief(assigned?.project) }
                        yield* tx
                          .insert(ProjectNoticeTable)
                          .values(notice)
                          .onConflictDoUpdate({ target: ProjectNoticeTable.agent, set: notice })
                          .run()
                      }
                    }),
                  ),
                ),
              { behavior: "immediate" },
            )
            .pipe(Effect.catch((error) => (error instanceof Error ? Effect.fail(error) : Effect.die(error))))
          yield* flush.pipe(
            Effect.catchCause((cause) =>
              Log.event("session.project.delivery.retry", { "project.fault": Log.fault(cause) }),
            ),
          )
          return yield* snapshot
        }),
      ),
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const agents = yield* AgentConfigStore.Service
    const events = yield* EventV2.Service
    const projects = yield* ProjectV2.Service
    const store = yield* SessionStore.Service
    const wake = yield* SessionRunCoordinator.Wake
    const service = fromParts({
      db,
      agents,
      notify: (agent, text, id) =>
        Effect.gen(function* () {
          const sessionID = yield* ensureLiveChat(
            { db, events, projects, store, agentConfigs: agents },
            AgentV2.ID.make(agent),
          )
          if (!sessionID) return
          const admit = (target: SessionSchema.ID) =>
            SessionInput.automated(db, events, {
              id: SessionMessage.ID.make(`msg_project_${id}_${target}`),
              sessionID: target,
              prompt: Prompt.make({ text: applySteerProvenance(text) }),
              delivery: "steer",
            })
          yield* admit(sessionID)
          yield* wake.wake(sessionID)
          const children = yield* store.children(sessionID)
          const pending = [...children]
          const seen = new Set<SessionSchema.ID>()
          while (pending.length) {
            const child = pending.pop()!
            if (seen.has(child)) continue
            seen.add(child)
            const info = yield* store.get(child)
            if (!info || info.time.archived !== undefined || info.result !== undefined) continue
            yield* admit(child)
            yield* wake.wake(child)
            pending.push(...(yield* store.children(child)))
          }
        }),
    })
    yield* service.flush.pipe(
      Effect.catchCause((cause) => Log.event("session.project.delivery.retry", { "project.fault": Log.fault(cause) })),
      Effect.repeat(Schedule.spaced("10 seconds")),
      Effect.forkScoped,
    )
    return service
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [
    Database.node,
    AgentConfigStore.node,
    EventV2.node,
    ProjectV2.node,
    SessionStore.node,
    SessionRunCoordinator.wakeNode,
  ],
})
