export * as OwnedRuntimeContext from "./owned-runtime-context"

import { eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "../database/database"
import { SystemContext } from "../system-context"
import { BashJobs } from "../tool/bash-jobs"
import { SessionExecutionTable, SessionTable } from "./sql"
import type { SessionSchema } from "./schema"
import { WorkerPurpose } from "./worker-purpose"

export const DEFAULT_HEARTBEAT_MINUTES = 60

export const WorkerState = Schema.Literals(["starting", "busy", "recovering", "paused", "queued"])
export type WorkerState = typeof WorkerState.Type

export const Worker = Schema.Struct({
  id: Schema.String,
  purpose: Schema.String,
  state: WorkerState,
  startedAt: Schema.Number,
})
export type Worker = typeof Worker.Type

export const Shell = Schema.Struct({
  id: Schema.String,
  sessionID: Schema.String,
  command: Schema.String,
  startedAt: Schema.Number,
})
export type Shell = typeof Shell.Type

export const Observation = Schema.Struct({
  observedAt: Schema.Number,
  heartbeatMinutes: Schema.Number,
  workers: Schema.Array(Worker),
  shells: Schema.Array(Shell),
})
export type Observation = typeof Observation.Type

const entityFacts = (value: Observation) => ({
  heartbeatMinutes: value.heartbeatMinutes,
  workers: value.workers,
  shells: value.shells,
})

const sameEntityFacts = (previous: Observation, current: Observation) =>
  JSON.stringify(entityFacts(previous)) === JSON.stringify(entityFacts(current))

export const equivalent = (previous: Observation, current: Observation) =>
  sameEntityFacts(previous, current) && current.observedAt - previous.observedAt < current.heartbeatMinutes * 60_000

const age = (startedAt: number, observedAt: number) => {
  const minutes = Math.max(0, Math.floor((observedAt - startedAt) / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`
}

const render = (value: Observation, changed: boolean) => {
  const heading = changed ? "Your live owned work changed." : "Live work you own (persistent heartbeat)."
  const workers =
    value.workers.length === 0
      ? ["Direct worker sessions: none."]
      : [
          "Direct worker sessions still alive:",
          ...value.workers.map(
            (worker) =>
              `- ${worker.id} · ${worker.state} · ${age(worker.startedAt, value.observedAt)} · ${worker.purpose}`,
          ),
          'Before spawning a replacement, compare its task with this list. To stop a duplicate, stale, or wrong direct worker, call `kill` with `{"sessionID":"<worker id>"}`.',
        ]
  const shells =
    value.shells.length === 0
      ? ["Running background shells in your session tree: none."]
      : [
          "Running background shells in your session tree:",
          ...value.shells.map(
            (shell) =>
              `- ${shell.id} · owner ${shell.sessionID} · ${age(shell.startedAt, value.observedAt)} · ${shell.command}`,
          ),
          'Inspect a shell with `bash` using `{"job":"<job id>","action":"status"}`; stop it with `{"job":"<job id>","action":"stop"}`.',
        ]
  return [
    heading,
    "This ledger is reconstructed from durable session and shell ownership, so compaction and restarts do not erase it.",
    ...workers,
    ...shells,
    `Repeat heartbeat: every ${value.heartbeatMinutes} minute${value.heartbeatMinutes === 1 ? "" : "s"}; changes are reported immediately.`,
  ].join("\n")
}

/** A pure constructor kept separate from the database observation so cadence and rendering are unit-testable. */
export const make = (value: Observation) =>
  SystemContext.make({
    key: SystemContext.Key.make("core/session/owned-runtime"),
    codec: Schema.toCodecJson(Observation),
    load: Effect.succeed(value),
    baseline: (current) => render(current, false),
    update: (previous, current) => render(current, !sameEntityFacts(previous, current)),
    equivalent,
    removed: () => "All worker sessions and background shells previously listed in your live-work ledger have stopped.",
  })

const livingWorkerState = (
  state: "starting" | "busy" | "recovering" | "paused" | "failed" | "interrupted" | "settled" | null,
): WorkerState | undefined => {
  if (state === null) return "queued"
  if (state === "settled" || state === "failed" || state === "interrupted") return undefined
  return state
}

export const observe = Effect.fn("OwnedRuntimeContext.observe")(function* (input: {
  readonly db: Database.Interface["db"]
  readonly sessionID: SessionSchema.ID
  readonly heartbeatMinutes: number
  readonly now?: number
}) {
  const rows = yield* input.db
    .select({
      id: SessionTable.id,
      parentID: SessionTable.parent_id,
      type: SessionTable.type,
      title: SessionTable.title,
      metadata: SessionTable.metadata,
      result: SessionTable.result,
      archivedAt: SessionTable.time_archived,
      createdAt: SessionTable.time_created,
      state: SessionExecutionTable.state,
    })
    .from(SessionTable)
    .leftJoin(SessionExecutionTable, eq(SessionExecutionTable.session_id, SessionTable.id))
    .all()
    .pipe(Effect.orDie)

  const byParent = new Map<string, typeof rows>()
  for (const row of rows) {
    if (row.parentID === null) continue
    const children = byParent.get(row.parentID) ?? []
    children.push(row)
    byParent.set(row.parentID, children)
  }

  const descendants: string[] = [input.sessionID]
  const seen = new Set<string>(descendants)
  for (let index = 0; index < descendants.length; index++) {
    for (const child of byParent.get(descendants[index]!) ?? []) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      descendants.push(child.id)
    }
  }

  const workers = (byParent.get(input.sessionID) ?? [])
    .flatMap((row): Worker[] => {
      const state = livingWorkerState(row.state)
      if (row.type !== "sub-agent" || row.archivedAt !== null || row.result !== null || state === undefined) return []
      return [
        {
          id: row.id,
          purpose: WorkerPurpose.fromMetadata(row.metadata) ?? row.title,
          state,
          startedAt: row.createdAt,
        },
      ]
    })
    .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))

  const shells = (yield* BashJobs.listRunning(input.db, descendants))
    .map((job): Shell => ({ ...job }))
    .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))

  return {
    observedAt: input.now ?? Date.now(),
    heartbeatMinutes: input.heartbeatMinutes,
    workers,
    shells,
  } satisfies Observation
})

export const load = Effect.fn("OwnedRuntimeContext.load")(function* (input: {
  readonly db: Database.Interface["db"]
  readonly sessionID: SessionSchema.ID
  readonly heartbeatMinutes: number
  readonly now?: number
}) {
  const observation = yield* observe(input)
  if (observation.workers.length === 0 && observation.shells.length === 0) return SystemContext.empty
  return make(observation)
})

/** Live ownership may tighten a goal-oriented officer's ordinary recheck sleep, never lengthen it. */
export const sleepMilliseconds = (input: {
  readonly ordinaryMilliseconds: number
  readonly heartbeatMinutes: number
  readonly observation: Observation
}) =>
  input.observation.workers.length === 0 && input.observation.shells.length === 0
    ? input.ordinaryMilliseconds
    : Math.min(input.ordinaryMilliseconds, input.heartbeatMinutes * 60_000)
