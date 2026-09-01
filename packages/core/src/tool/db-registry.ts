export * as DbRegistryTool from "./db-registry"

import { ToolFailure } from "@novaclaw/llm"
import { Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { DbRegistry } from "../db-registry"
import { makeLocationNode } from "../effect/app-node"
import { SessionOrigin } from "../session/origin"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

/**
 * **The `registry` tool — the self-healing law reaching the instance database.**
 *
 * 🔴 The defect it closes. `core/db-registry.ts` (tables · rows · insert · update · delete) had
 * exactly ONE caller: the Developer-mode Registry app. No tool imported it. So a **person** could
 * edit any row of the instance database and the **agent** could edit none — the self-healing law
 * backwards, on the surface that law most depends on. AGENTS.md asks of every feature *"if this
 * breaks while the vendor is asleep, can an agent inside the OS repair it?"*; for anything whose
 * state lives only in SQLite the answer was no, and the human was the only repair path.
 *
 * ── one module, two writers ─────────────────────────────────────────────────────────────────────
 *
 * This is a thin op vocabulary over the SAME `DbRegistry` functions the app calls — one
 * implementation, one identifier-validation path, one set of guards. A second read/write path over
 * the same tables would be two places to get `sql.identifier` right and two places to forget a guard.
 *
 * What differs is only WHO is asking, expressed as `DbRegistry.Writer`:
 *  · the app writes as `developer` — a human on their own machine, past an expertise gate;
 *  · this tool writes as `agent`, and config-backed tables are REFUSED, pointing at `configure`.
 * ⚠️ That refusal is not tidiness. Every config key carries a tier (`config-tier.ts`) enforced at the
 * `configure` seam, so a raw `runtime_setting` row-write would let a model denied a privileged card
 * simply write the row instead. The one guard both writers share is the migration journal, because
 * corrupting it removes the instance's ability to boot and therefore to repair itself.
 *
 * ── deferred, and why ───────────────────────────────────────────────────────────────────────────
 *
 * `Tool.withDeferred`, the same call `log` and `resource_status` make: a raw database surface is
 * reached AFTER something has gone wrong, so its schema has no claim on every turn's prefix
 * (reported degradation starts at 30–50 tools, and we are past it). The index a
 * model needs is `{op:'tables'}`, which is a call, not a name it must already know.
 *
 * ── framed ──────────────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ Row VALUES are framed as untrusted, and this is the entry's whole justification: the instance
 * database is where other parties' words are STORED. A `messenger_account` row holds what a provider
 * sent, a session row holds what a model and its MCP servers said, and nothing framed them on the way
 * in — the same gap `log.ts` names ("nothing ever framed a log line"). Reading them back out here is
 * the cheap honest place to declare it. Table NAMES and row COUNTS are our own schema and are never
 * framed, exactly as `log`'s `count`/`keys` are not.
 *
 * ── no free-form SQL, deliberately ──────────────────────────────────────────────────────────────
 *
 * ⛔ `DbRegistry` exposes structured ops only, and this tool adds none. A `query` op is a much larger
 * safety argument (it re-opens every guard above as a string-matching problem) and belongs to its own
 * item, not to this one.
 */
export const name = "registry"

/** Rows per page, and the ceiling a caller may ask for — `DbRegistry.rows` clamps to the same 500. */
export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 500
/** One cell is truncated here: a blob column must not become the whole result. */
export const MAX_CELL_CHARS = 300

/** The label the frame carries. Says WHOSE words these are, not merely that they are external. */
export const FOREIGN_LABEL = "stored rows, which may contain other programs' and other people's text"

const TablesOp = Schema.Struct({ op: Schema.Literal("tables") })

const RowsOp = Schema.Struct({
  op: Schema.Literal("rows"),
  table: Schema.String.annotate({ description: "Table name, exactly as {op:'tables'} reports it" }),
  limit: Schema.optional(Schema.Finite).annotate({ description: `Rows to return (default ${DEFAULT_LIMIT})` }),
  offset: Schema.optional(Schema.Finite).annotate({ description: "Rows to skip, for paging" }),
})

const InsertOp = Schema.Struct({
  op: Schema.Literal("insert"),
  table: Schema.String,
  values: Schema.Record(Schema.String, Schema.Unknown).annotate({
    description: "Column → value. Unknown columns are dropped, never interpolated.",
  }),
})

const UpdateOp = Schema.Struct({
  op: Schema.Literal("update"),
  table: Schema.String,
  rowid: Schema.Finite.annotate({ description: "The `rowid` {op:'rows'} returned for this row" }),
  values: Schema.Record(Schema.String, Schema.Unknown),
})

const DeleteOp = Schema.Struct({
  op: Schema.Literal("delete"),
  table: Schema.String,
  rowid: Schema.Finite,
})

export const Input = Schema.Union([TablesOp, RowsOp, InsertOp, UpdateOp, DeleteOp])

export const Output = Schema.Struct({ ok: Schema.Boolean, message: Schema.String })
export type Output = typeof Output.Type

export const description = [
  "Browse and edit THIS instance's SQLite database directly — the same surface the Developer-mode",
  "Registry app gives a person. Use it to inspect or repair state that lives only in the database and",
  "has no other tool, after you have established from the log what is actually wrong.",
  "Ops: {op:'tables'} — every table with its row count (start here);",
  "{op:'rows',table,limit?,offset?} — a page of rows, each with the `rowid` the write ops take;",
  "{op:'insert',table,values} · {op:'update',table,rowid,values} · {op:'delete',table,rowid}.",
  "Configuration tables are read-only here — change settings with `configure`, which applies their",
  "permission rules. The schema-migration journal is read-only to everyone.",
].join("\n")

/** One cell, rendered short and unambiguous. `null` is a value and must not read as an empty string. */
const cell = (value: unknown): string => {
  if (value === null) return "NULL"
  if (value === undefined) return ""
  const text = typeof value === "string" ? value : JSON.stringify(value)
  return text.length <= MAX_CELL_CHARS ? text : `${text.slice(0, MAX_CELL_CHARS)}…`
}

/** A page of rows as text. Exported so the test reads what the model reads. */
export const formatPage = (page: DbRegistry.TablePage, offset: number): string => {
  const header =
    `${page.table}: ${page.rowCount} row${page.rowCount === 1 ? "" : "s"} total, showing ` +
    `${page.rows.length} from offset ${offset}\ncolumns: ${page.columns.join(", ")}`
  if (page.rows.length === 0) return header
  const body = page.rows
    .map((row) => `rowid=${row.rowid}  ` + page.columns.map((column) => `${column}=${cell(row.values[column])}`).join("  "))
    .join("\n")
  // The header is OURS and stays outside the frame; only the stored values are labelled.
  return `${header}\n${SessionOrigin.externalContentFrame(FOREIGN_LABEL)}${body}`
}

const clamp = (value: number | undefined, fallback: number, max: number) => {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(max, Math.floor(value)))
}

/**
 * Run one op.
 *
 * ⚠️ `RegistryError` is a caller's mistake — an unknown table, a refused table, a constraint an
 * inserted row violates — so it becomes a `ToolFailure` the model reads and acts on, never a defect.
 * Everything below it in `DbRegistry` already `orDie`s the faults that are ours.
 */
export const run = Effect.fn("DbRegistryTool.run")(function* (input: typeof Input.Type) {
  switch (input.op) {
    case "tables": {
      const tables = yield* DbRegistry.tables()
      return {
        ok: true,
        message: [
          `${tables.length} table${tables.length === 1 ? "" : "s"}:`,
          ...tables.map((table) => `${String(table.rowCount).padStart(8)}  ${table.name}`),
        ].join("\n"),
      }
    }
    case "rows": {
      const offset = Math.max(0, Math.floor(input.offset ?? 0))
      const page = yield* DbRegistry.rows({
        table: input.table,
        limit: clamp(input.limit, DEFAULT_LIMIT, MAX_LIMIT),
        offset,
      })
      return { ok: true, message: formatPage(page, offset) }
    }
    case "insert": {
      yield* DbRegistry.insertRow({ table: input.table, values: input.values, writer: "agent" })
      return { ok: true, message: `Inserted one row into ${input.table}.` }
    }
    case "update": {
      yield* DbRegistry.updateRow({
        table: input.table,
        rowid: input.rowid,
        values: input.values,
        writer: "agent",
      })
      return { ok: true, message: `Updated rowid ${input.rowid} in ${input.table}.` }
    }
    case "delete": {
      yield* DbRegistry.deleteRow({ table: input.table, rowid: input.rowid, writer: "agent" })
      return { ok: true, message: `Deleted rowid ${input.rowid} from ${input.table}. Foreign keys cascaded.` }
    }
  }
})

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    // Acquired while the LAYER is constructed and captured by the executor — the house rule in
    // `tool/AGENTS.md`. Resolving it per call would make every op depend on the ambient graph.
    const database = yield* Database.Service
    yield* tools
      .register({
        [name]: Tool.withDeferred(
          Tool.make({
            description,
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: output.message }],
            execute: (input) =>
              run(input).pipe(
                Effect.provideService(Database.Service, database),
                Effect.catchTag("DbRegistry.RegistryError", (error) => new ToolFailure({ message: error.message })),
              ),
          }),
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({ name: "tool/db-registry", layer, deps: [ToolRegistry.node, Database.node] })
