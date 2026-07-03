/**
 * B11 — model-facing git-substrate undo: restore files to their state before the last
 * N file-changing steps (or before an explicit message id), riding the SAME per-turn
 * snapshot trees as the UI revert dock. Reconciliation with the rest of the undo story:
 * git snapshots cover file EDITS (tracked or untracked-but-captured); deletions go
 * through the Trash tool (dated, restorable) — the two are complementary, not rivals.
 */
export * as RevertTool from "./revert"

import { ToolFailure } from "@novaclaw/llm"
import { and, asc, eq } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { RelativePath } from "../schema"
import { SessionMessage } from "../session/message"
import { SessionRevert } from "../session/revert"
import { SessionSchema } from "../session/schema"
import { SessionMessageTable } from "../session/sql"
import { Snapshot } from "../snapshot"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "revert"
export const MAX_STEPS = 50

export const Input = Schema.Struct({
  steps: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(MAX_STEPS))
    .pipe(Schema.optional)
    .annotate({
      description:
        "How many of your most recent file-CHANGING steps to undo (default 1). 0 undoes only the changes made so far in the CURRENT step.",
    }),
  messageID: Schema.String.pipe(Schema.optional).annotate({
    description: "Alternative to steps: revert every file change made after this message id.",
  }),
})

export const Output = Schema.Struct({
  files: Schema.Array(Schema.String),
  count: Schema.Number,
})
export type Output = typeof Output.Type

const MAX_LISTED = 20

export const toModelOutput = (output: Output) => {
  const listed = output.files.slice(0, MAX_LISTED).join(", ")
  const more = output.files.length > MAX_LISTED ? ` (+${output.files.length - MAX_LISTED} more)` : ""
  return `Restored ${output.count} file(s) to their pre-change state: ${listed}${more}. Deleted files are NOT covered here — restore those from the Trash instead.`
}

/** One assistant step as the pure planner sees it (seq order, in-flight step excluded). */
export interface StepInfo {
  readonly id: string
  readonly start?: string
  readonly files: readonly string[]
}

/**
 * Pure: select the last `steps` file-changing steps (plus everything after the earliest
 * of them) and map each touched file to the snapshot tree of the FIRST step that touched
 * it — its state before that change. Mirrors SessionRevert.plan's first-touch semantics.
 */
export function planSteps(
  rows: readonly StepInfo[],
  steps: number,
): { readonly files: ReadonlyMap<string, string> } {
  const files = new Map<string, string>()
  const changed = rows.filter((row) => row.start && row.files.length > 0)
  if (steps <= 0 || changed.length === 0) return { files }
  const first = changed[Math.max(0, changed.length - steps)]!
  for (const row of rows.slice(rows.findIndex((candidate) => candidate.id === first.id))) {
    if (!row.start) continue
    for (const file of row.files) if (!files.has(file)) files.set(file, row.start)
  }
  return { files }
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const snapshot = yield* Snapshot.Service
    const database = yield* Database.Service

    yield* tools
      .register({
        [name]: Tool.withPermission(
          Tool.make({
            description:
              "UNDO file changes by restoring files to an earlier snapshot (git-backed, captured every step). Default undoes your last file-changing step; `steps: N` undoes the last N; `steps: 0` undoes only the current step's changes so far. Restores file EDITS — deletions are restored from the Trash instead. Use when an edit made things worse and you want a known-good state back.",
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
            execute: (input, context) =>
              Effect.gen(function* () {
                const source = {
                  type: "tool" as const,
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                }
                const restore = new Map<RelativePath, Snapshot.ID>()
                if (input.messageID !== undefined) {
                  const planned = yield* SessionRevert.plan({
                    sessionID: context.sessionID,
                    messageID: SessionMessage.ID.make(input.messageID),
                  }).pipe(
                    Effect.provideService(Database.Service, database),
                    Effect.catchTag("Session.MessageNotFoundError", () =>
                      Effect.fail(new ToolFailure({ message: `No message "${input.messageID}" in this session.` })),
                    ),
                  )
                  for (const [file, tree] of planned) restore.set(file, tree)
                } else if ((input.steps ?? 1) === 0) {
                  // Undo the CURRENT step: diff its start snapshot against the live tree.
                  const current = yield* loadStep(database, context.sessionID, context.assistantMessageID)
                  if (!current?.start)
                    return yield* Effect.fail(
                      new ToolFailure({
                        message:
                          "The current step has no snapshot — snapshots may be disabled (git unavailable?) or nothing was captured yet.",
                      }),
                    )
                  const start = Snapshot.ID.make(current.start)
                  const now = yield* snapshot.capture()
                  if (!now)
                    return yield* Effect.fail(
                      new ToolFailure({ message: "Snapshot capture failed — cannot compute the current diff." }),
                    )
                  const changed = yield* snapshot
                    .files({ from: start, to: now })
                    .pipe(Effect.mapError((error) => new ToolFailure({ message: `Snapshot diff failed: ${error.message}` })))
                  for (const file of changed) restore.set(file, start)
                } else {
                  const rows = yield* loadSteps(database, context.sessionID, context.assistantMessageID)
                  const planned = planSteps(rows, input.steps ?? 1)
                  for (const [file, tree] of planned.files)
                    restore.set(RelativePath.make(file), Snapshot.ID.make(tree))
                }
                if (restore.size === 0)
                  return yield* Effect.fail(
                    new ToolFailure({
                      message:
                        "Nothing to revert: no file changes are recorded in the selected steps (snapshots may be disabled, or the steps changed no files).",
                    }),
                  )
                yield* permission.assert({
                  action: name,
                  resources: [...restore.keys()],
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
                yield* snapshot
                  .restore({ files: restore })
                  .pipe(Effect.mapError((error) => new ToolFailure({ message: `Restore failed: ${error.message}` })))
                const files = [...restore.keys()].sort()
                return { files, count: files.length }
              }).pipe(
                Effect.mapError((error) => {
                  if (error instanceof ToolFailure) return error
                  const denial = PermissionV2.denialMessage(error)
                  if (denial) return new ToolFailure({ message: denial })
                  return new ToolFailure({
                    message: `Unable to revert: ${error instanceof Error ? error.message : String(error)}`,
                  })
                }),
              ),
          }),
          name,
        ),
      })
      .pipe(Effect.orDie)
  }),
)

const decodeMessage = Schema.decodeUnknownEffect(SessionMessage.Message)

/** Assistant steps of the session in seq order, EXCLUDING the in-flight one. */
const loadSteps = Effect.fnUntraced(function* (
  database: Database.Interface,
  sessionID: SessionSchema.ID,
  currentMessageID: string,
) {
  const rows = yield* database.db
    .select()
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "assistant")))
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  const steps: StepInfo[] = []
  for (const row of rows) {
    if (row.id === currentMessageID) continue
    const message = yield* decodeMessage({ ...(row.data as object), id: row.id, type: row.type }).pipe(Effect.orDie)
    if (message.type !== "assistant") continue
    steps.push({ id: row.id, start: message.snapshot?.start, files: message.snapshot?.files ?? [] })
  }
  return steps
})

const loadStep = Effect.fnUntraced(function* (
  database: Database.Interface,
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
) {
  const row = yield* database.db
    .select()
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.id, messageID)))
    .get()
    .pipe(Effect.orDie)
  if (!row) return undefined
  const message = yield* decodeMessage({ ...(row.data as object), id: row.id, type: row.type }).pipe(Effect.orDie)
  if (message.type !== "assistant") return undefined
  return { id: row.id, start: message.snapshot?.start, files: message.snapshot?.files ?? [] } satisfies StepInfo
})

export const node = makeLocationNode({
  name: "tool/revert",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, Snapshot.node, Database.node],
})
