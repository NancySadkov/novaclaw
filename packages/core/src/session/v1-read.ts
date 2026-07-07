export * as SessionV1Read from "./v1-read"

import { Effect } from "effect"
import { and, asc, desc, eq, gte, inArray, isNull, like, lt, or, sql, type SQL } from "drizzle-orm"
import type { Database } from "../database/database"
import { ProjectV2 } from "../project"
import { ProjectTable } from "../project/sql"
import { WorkspaceV2 } from "../workspace"
import { SessionV1 } from "../v1/session"
import { SessionSchema } from "./schema"
import { SessionTable } from "./sql"
import { v1InfoFromRow } from "./info"

/**
 * Row-faithful session-level reads in the LEGACY wire shape (`SessionV1.SessionInfo`) — the
 * vocabulary the HTTP session API and the session-level events (`session.created/updated/
 * deleted`, kept by F1g) share, so the client sees ONE shape from both. Deliberately NOT a
 * lossy V2→V1 bridge: it reads the raw row exactly like the V1 `Session.Service` it replaces
 * (F1c read-sweep). Retires only with a wholesale session-API wire migration.
 */

export const get = (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
): Effect.Effect<SessionV1.SessionInfo | undefined> =>
  db
    .select()
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(
      Effect.orDie,
      Effect.map((row) => (row ? v1InfoFromRow(row) : undefined)),
    )

export const children = (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
): Effect.Effect<SessionV1.SessionInfo[]> =>
  db
    .select()
    .from(SessionTable)
    .where(eq(SessionTable.parent_id, sessionID))
    .orderBy(asc(SessionTable.time_created))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map(v1InfoFromRow)),
    )

// The V1 list filter surface, lifted verbatim from the V1 engine's `listByProject` — with the
// ONE ambient input made explicit: `projectID` comes from the caller (the HTTP handler resolves
// it from the request's instance context), never from module state. (The V1 signature also took
// `experimentalWorkspaces`, which its body never read — dropped.)
export interface ListInput {
  readonly projectID: ProjectV2.ID
  readonly directory?: string
  readonly scope?: "project"
  readonly path?: string
  readonly workspaceID?: WorkspaceV2.ID
  readonly roots?: boolean
  readonly start?: number
  readonly search?: string
  readonly limit?: number
}

export const list = (db: Database.Interface["db"], input: ListInput): Effect.Effect<SessionV1.SessionInfo[]> => {
  const conditions = [eq(SessionTable.project_id, input.projectID)]
  if (input.workspaceID) {
    conditions.push(eq(SessionTable.workspace_id, input.workspaceID))
  }
  if (input.path !== undefined) {
    if (input.path) {
      const conds = [
        eq(SessionTable.path, input.path),
        like(SessionTable.path, sql.param(`${input.path}/%`, SessionTable.path)),
      ]
      conditions.push(
        input.directory
          ? or(...conds, and(isNull(SessionTable.path), eq(SessionTable.directory, input.directory))!)!
          : or(...conds)!,
      )
    }
  } else if (input.scope !== "project") {
    if (input.directory) {
      conditions.push(eq(SessionTable.directory, input.directory))
    }
  }
  if (input.roots) {
    conditions.push(isNull(SessionTable.parent_id))
  }
  if (input.start) {
    conditions.push(gte(SessionTable.time_updated, input.start))
  }
  if (input.search) {
    conditions.push(like(SessionTable.title, `%${input.search}%`))
  }
  return db
    .select()
    .from(SessionTable)
    .where(and(...conditions))
    .orderBy(desc(SessionTable.time_updated))
    .limit(input.limit ?? 100)
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map(v1InfoFromRow)),
    )
}

export interface GlobalListInput {
  readonly directory?: string
  readonly roots?: boolean
  readonly start?: number
  readonly cursor?: number
  readonly search?: string
  readonly limit?: number
  readonly archived?: boolean
}

// The project summary the global list joins onto each row (the wire GlobalSession.project).
export interface ProjectSummary {
  readonly id: ProjectV2.ID
  readonly name?: string
  readonly worktree: string
}

export const listGlobal = (
  db: Database.Interface["db"],
  input?: GlobalListInput,
): Effect.Effect<Array<SessionV1.SessionInfo & { project: ProjectSummary | null }>> =>
  Effect.gen(function* () {
    const conditions: SQL[] = []
    if (input?.directory) conditions.push(eq(SessionTable.directory, input.directory))
    if (input?.roots) conditions.push(isNull(SessionTable.parent_id))
    if (input?.start) conditions.push(gte(SessionTable.time_updated, input.start))
    if (input?.cursor) conditions.push(lt(SessionTable.time_updated, input.cursor))
    if (input?.search) conditions.push(like(SessionTable.title, `%${input.search}%`))
    if (!input?.archived) conditions.push(isNull(SessionTable.time_archived))
    const query =
      conditions.length > 0
        ? db
            .select()
            .from(SessionTable)
            .where(and(...conditions))
        : db.select().from(SessionTable)
    const rows = yield* query
      .orderBy(desc(SessionTable.time_updated), desc(SessionTable.id))
      .limit(input?.limit ?? 100)
      .all()
      .pipe(Effect.orDie)
    const ids = [...new Set(rows.map((row) => row.project_id))]
    const projects = new Map<string, ProjectSummary>()
    if (ids.length > 0) {
      const items = yield* db
        .select({ id: ProjectTable.id, name: ProjectTable.name, worktree: ProjectTable.worktree })
        .from(ProjectTable)
        .where(inArray(ProjectTable.id, ids))
        .all()
        .pipe(Effect.orDie)
      for (const item of items) {
        projects.set(item.id, { id: item.id, name: item.name ?? undefined, worktree: item.worktree })
      }
    }
    return rows.map((row) => ({ ...v1InfoFromRow(row), project: projects.get(row.project_id) ?? null }))
  })
