export * as DbRegistryTool from "./db-registry"

import { ToolFailure } from "@novaclaw/llm"
import { Effect, Layer, Schema } from "effect"
import { ConfigProjection } from "../config-projection"
import { Database } from "../database/database"
import { DbRegistry } from "../db-registry"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
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
 *  · this tool writes as `agent`, and config-backed tables are REFUSED, pointing at `configure`,
 *    as are the two permission-kernel tables, which point at the chat.
 * ⚠️ That refusal is not tidiness. Every config key carries a tier (`config-tier.ts`) enforced at the
 * `configure` seam, so a raw `runtime_setting` row-write would let a model denied a privileged card
 * simply write the row instead. The one guard both writers share is the migration journal, because
 * corrupting it removes the instance's ability to boot and therefore to repair itself.
 *
 * ── a WRITE spends {@link WRITE_ACTION}; a read spends nothing ──────────────────────────────────
 *
 * 🔴 **A refusal list is not a price.** The refusals above close the *escalation* — an agent cannot
 * rewrite the tiers `configure` enforces, nor the verdicts the evaluator reads. They said nothing
 * about the other ~50 tables, so a raw agent write to `messenger_binding`, `community_contact`,
 * `agent_status` or `credential` cost **zero consent** while the same repair through a typed tool
 * would have been gated. That is ruling 4's *unclassified ⇒ privileged* read backwards: the widest
 * surface in the instance was the only one nobody had to be granted.
 *
 * ⚠️ **A SEPARATE action, not the registered tool name, and the split is the same one `configure`
 * draws.** `ToolRegistry.materialize` withdraws a tool when the last rule matching its REGISTERED
 * name reads `resource: "*"` + `deny` (`registry.ts` → `whollyDisabled`), so `{action: "registry",
 * effect: "deny"}` takes the whole surface off the horizon — reads included. That is a legitimate
 * thing for an operator to want and it is not the same decision as *"browse freely, do not write"*.
 * `registry_write` is the second one, exactly as `configure_privileged` is a second action so a rule
 * can grant the cheap tier without the expensive one.
 *
 * ⚠️ **`resources: [table]` and `save: [table]`, never `["*"]`** — `configure.ts` argues it for a
 * config key and the argument is unchanged here: `resources` doubles as the pattern a standing rule
 * matches, so a wildcard turns one decision about `agent_status` into a standing grant over
 * `credential`. A row's VALUES stay out of `resources` for the same reason they do there — a rule
 * matching one exact payload is a dead rule — and ride `metadata`.
 *
 * ⚠️ **NOT SPENT on a table this tool already refuses**, which is the double-charge the obvious
 * implementation makes. The kernel and config refusals are agent-specific verdicts with wording that
 * tells the model where the capability actually lives (`configure`, or the chat); charging permission
 * first would replace that with a generic denial and turn a settled refusal into something that
 * *looks* grantable. So the gate runs after them, deny-fast, and it reads {@link
 * DbRegistry.permissionKernelTables} / {@link DbRegistry.configBackedTables} rather than restating
 * their membership — a second copy of those sets here is the hand-kept list that goes stale silently.
 * The migration journal is deliberately NOT in that skip list: it is refused to BOTH writers, so it
 * is not a question about this agent's privilege, and either verdict refuses the write.
 *
 * ⚠️ **The read path stays ungated**, matching `configure.ts`'s stated invariant — *"`read` is
 * ungated precisely BECAUSE it is redacted"* — and the redaction below is what pays for it.
 *
 * ⚠️ **There is no consent card at the end of this.** `ask` was retired as an outcome (owner,
 * 2026-08-20): `evaluateInput`'s last arm converts an `ask` verdict into an immediate refusal
 * carrying {@link PermissionV2.GRANT_IN_ADVANCE}. Since `registry_write` is absent from
 * `AMBIENT_SAFE_BASELINE`, from every `MODE_RULES` overlay (`bypass` included) and from the compiled
 * agent floor, a default install refuses the write and names the standing rule that would allow it.
 * That fall-through is asserted over the shipped constants in `tool-db-registry-permission.test.ts`,
 * with the pre-B4c catch-all restored as the negative control — an inference from three constants is
 * exactly the shape that goes stale when one of them moves.
 *
 * ── the READ path is redacted, and that is a SECOND guard, not the same one ─────────────────────
 *
 * 🔴 **A refused write does not make a read safe, and for a while this module behaved as though it
 * did.** `assertWritable` is reached only from `insertRow`/`updateRow`/`deleteRow`; `DbRegistry.rows`
 * calls `assertTable`, which checks existence and nothing else — and the write refusal's own message
 * ends *"Browsing it is fine."* So `{op:"rows",table:"runtime_setting"}` returned `server.password`
 * (this instance's own incoming API token) and every `instances[].token` (ruling 5:
 * *account-equivalent*) in plaintext, one layer under the redaction `configure`'s `read` op applies —
 * whose header states the invariant verbatim: *"`read` is ungated precisely BECAUSE it is redacted."*
 *
 * ⚠️ **Redacted here, not in `core/db-registry.ts`.** The Developer-mode Registry app shares those
 * functions and must keep showing real values: a human repairing their own credential row needs to
 * see it, and ruling 5 makes the instance the trust boundary. The asymmetry is the same one the
 * write path already draws, at the same seam.
 *
 * ⚠️ **A CLASS, never one table.** {@link CONFIG_ROUTES} lifts each config-backed table's payload
 * back into the `Config.Info` shape `ConfigProjection.redact` walks, so the schema's own
 * `ConfigAnnotation.secret` markers are the single source of truth for those eight tables — no second
 * redactor to drift. {@link SECRET_COLUMNS} covers the four tables whose secrets are whole COLUMNS
 * rather than config values. `tool-db-registry.test.ts` is the ledger: every config-backed table must
 * have a route, and every column in the live schema whose NAME reads as a credential must be
 * declared — so a table or column added later fails a test instead of leaking quietly.
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
  "permission rules. The permission kernel's own tables (`permission`, `session_auto_grant`) are",
  "read-only too: if you need an action you do not have, ask for it in your reply. The",
  "schema-migration journal is read-only to everyone.",
  "Stored credentials come back redacted — passwords, API tokens, peer tokens and signing keys are",
  "replaced with a placeholder, so a value you read here is never one you can use.",
  "Browsing is free; each insert/update/delete spends the `registry_write` permission for the one",
  "table it names, so read first and write once.",
].join("\n")

// ── redaction ─────────────────────────────────────────────────────────────────────────────────

/**
 * The stand-in for a stored credential.
 *
 * ⚠️ **Deliberately NOT `ConfigProjection.REDACTED`**, which reads *"configure can WRITE this value,
 * it will not read one back"*. That sentence is true of a config key and false of `credential.value`
 * or `instance_identity.secret_key` — `configure` cannot write any of them — and ruling 2 forbids
 * describing a fault falsely. Two different facts get two sentences; the config tables below keep
 * `ConfigProjection.REDACTED` verbatim, so on that surface there is still exactly one vocabulary.
 */
export const SECRET_CELL = "(redacted — a stored credential; this tool will not read one back)"

/**
 * Tables whose secrets are whole COLUMNS rather than config values.
 *
 * Each entry is a decision, and the tables left OUT are decisions too:
 *  · `messenger_account` — its own schema header says it: *"Secrets NEVER live here: an account row
 *    points at the credential store via credential_id."* `settings` is driver configuration and
 *    `credential_id` is a reference, so redacting it would hide a repair target and protect nothing.
 *  · `community_peer` / `community_contact` — `routes` are ADDRESSES, and AGENTS.md accepts
 *    enumerability by name: *"Being findable is the price."* A peer's address is not a secret; the
 *    only secret in that subsystem is our own signing key, which is `instance_identity` below.
 *  · `instance_identity.public_key` / `sealing_public_key` — public halves, published by design.
 *
 * ⚠️ A hand-kept list like this goes stale silently, so it is not left to a comment: the ledger test
 * scans the LIVE schema and fails when a column whose name reads as a credential is not declared
 * here (see {@link SECRET_COLUMN_PATTERN}). `credential.value` is the entry that pattern cannot
 * find, which is precisely why the declaration exists as well as the scan.
 */
const SECRET_COLUMNS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["credential", new Set(["value"])],
  ["instance_identity", new Set(["secret_key", "sealing_secret_key"])],
  ["account", new Set(["access_token", "refresh_token"])],
  ["control_account", new Set(["access_token", "refresh_token"])],
])

/** Exported for the ledger test that scans the live schema against it. */
export const secretColumns = (): ReadonlyMap<string, ReadonlySet<string>> => SECRET_COLUMNS

/**
 * A column name that reads as a credential. The mechanical half of {@link SECRET_COLUMNS}: the
 * ledger test requires every LIVE column matching this to be declared above, so a new
 * `oauth_secret` on a new table fails a test rather than landing in a transcript.
 *
 * ⚠️ Narrow on purpose. `token` alone would match `tokens_input`, `tokens_reasoning` and
 * `token_expiry` — LLM accounting and an expiry stamp, none of them secret — and a ratchet that
 * cries wolf gets an allowlist bolted to it until it means nothing. It matches what it can name.
 */
export const SECRET_COLUMN_PATTERN =
  /(^|_)(secret|password|passwd|access_token|refresh_token|api_key|private_key|auth_token)(_|$)/

/**
 * How each config-backed table's payload lifts back into the `Config.Info` shape
 * `ConfigProjection.redact` walks. The lift is exact, not approximate:
 *  · `entry` — `(key, value)` rows ARE a `Config.Info` overlay one pair at a time; `{[key]: value}`
 *    is literally what `SettingsConfigStore.all()` hands `ConfigStoreWrite.overlay`, which is what
 *    `configure`'s `read` op redacts. Same bytes, same walk.
 *  · `layers` — `(name, layers[])` rows hold fragments of one record entry, so a layer of
 *    `catalog_provider` lifts to `{providers: {<id>: layer}}`, and `Config.Info.providers` is
 *    `Record<string, ConfigProvider.Info>`. That is the table that matters most: a provider's
 *    `request.headers` is where an Authorization token lives, and `request.body.apiKey` with it.
 *
 * `skill_config` is `(source, timestamps)` — there is no payload to walk, and `none` says so
 * explicitly rather than leaving the table unlisted, because an unlisted config table FAILS CLOSED
 * below and would strand a reader on a table that never held a secret.
 */
export type ConfigRoute =
  | { readonly kind: "entry"; readonly key: string; readonly value: string }
  | { readonly kind: "layers"; readonly name: string; readonly value: string; readonly field: string }
  | { readonly kind: "none" }

const CONFIG_ROUTES: ReadonlyMap<string, ConfigRoute> = new Map<string, ConfigRoute>([
  ["runtime_setting", { kind: "entry", key: "key", value: "value" }],
  ["catalog_setting", { kind: "entry", key: "key", value: "value" }],
  ["agent_setting", { kind: "entry", key: "key", value: "value" }],
  ["catalog_provider", { kind: "layers", name: "id", value: "layers", field: "providers" }],
  ["agent_config", { kind: "layers", name: "name", value: "layers", field: "agents" }],
  ["command_config", { kind: "layers", name: "name", value: "layers", field: "commands" }],
  ["reference_config", { kind: "layers", name: "name", value: "layers", field: "references" }],
  ["skill_config", { kind: "none" }],
])

/** Exported for the ledger test that pins this against `DbRegistry.configBackedTables()`. */
export const configRoutes = (): ReadonlyMap<string, ConfigRoute> => CONFIG_ROUTES

/**
 * The top-level config keys that carry a credential ANYWHERE beneath them, from the schema's own
 * markers. Used only for the fail-closed arm: a stored value that will not parse cannot be walked,
 * so under one of these keys it is blanked whole rather than passed through.
 *
 * Lazy, not a module constant: `config-projection.ts` records a real initialization-order fault at
 * its own head, and nothing here needs the answer before the first call.
 */
let secretKeyCache: ReadonlySet<string> | undefined
const secretTopLevelKeys = (): ReadonlySet<string> => {
  if (secretKeyCache === undefined)
    secretKeyCache = new Set(ConfigProjection.secretPaths().map((path) => path.split(".")[0]!))
  return secretKeyCache
}

const PARSE_FAILED = Symbol("parse-failed")
const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return PARSE_FAILED
  }
}

/** One `(key, value)` config row's value, redacted through the schema walk `configure` uses. */
const redactEntryCell = (key: unknown, raw: unknown): unknown => {
  if (typeof raw !== "string" || typeof key !== "string") return raw
  const parsed = parseJson(raw)
  // Fail CLOSED: an unparseable value under a key that declares a secret is blanked whole. Passing
  // it through would be the one case where "we could not tell" is answered by handing it over.
  if (parsed === PARSE_FAILED) return secretTopLevelKeys().has(key) ? ConfigProjection.REDACTED : raw
  const redacted = (ConfigProjection.redact({ [key]: parsed }) as Record<string, unknown>)[key]
  return JSON.stringify(redacted)
}

/** One `(name, layers[])` config row's layers, each lifted into its record slot and walked. */
const redactLayersCell = (field: string, name: unknown, raw: unknown): unknown => {
  if (typeof raw !== "string") return raw
  const parsed = parseJson(raw)
  if (parsed === PARSE_FAILED) return ConfigProjection.REDACTED
  const slot = typeof name === "string" ? name : "unnamed"
  const one = (layer: unknown): unknown => {
    const walked = ConfigProjection.redact({ [field]: { [slot]: layer } }) as Record<string, unknown>
    const record = walked[field]
    // The walk preserves keys, so the slot is always there. If it somehow is not, the shape this
    // function assumed is wrong and the honest answer is the blank, never the original bytes.
    if (record === null || typeof record !== "object") return ConfigProjection.REDACTED
    return (record as Record<string, unknown>)[slot] ?? ConfigProjection.REDACTED
  }
  return JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed))
}

/**
 * A page of rows with every stored credential replaced.
 *
 * Exported so the test asserts on the same value `formatPage` renders, rather than on a string it
 * has to parse back out of the model's message.
 */
export const redactPage = (page: DbRegistry.TablePage): DbRegistry.TablePage => {
  const columns = SECRET_COLUMNS.get(page.table)
  const route = CONFIG_ROUTES.get(page.table)
  if (columns === undefined && route === undefined) return page
  const rows = page.rows.map((row) => {
    const values = { ...row.values }
    if (columns !== undefined)
      for (const column of columns) if (column in values) values[column] = SECRET_CELL
    if (route?.kind === "entry") values[route.value] = redactEntryCell(values[route.key], values[route.value])
    if (route?.kind === "layers")
      values[route.value] = redactLayersCell(route.field, values[route.name], values[route.value])
    return DbRegistry.TableRow.make({ rowid: row.rowid, values })
  })
  return DbRegistry.TablePage.make({ table: page.table, columns: page.columns, rowCount: page.rowCount, rows })
}

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
      // FAIL CLOSED, before a single byte is read. A config-backed table with no redaction route is
      // a table whose secrets nothing here knows how to find, and the ledger test exists so this
      // arm never fires — but if a new store lands without a route, refusing to read it is the only
      // answer that is not a guess. `configure` reads the same bytes, redacted by the schema.
      if (DbRegistry.configBackedTables().has(input.table) && !CONFIG_ROUTES.has(input.table))
        return yield* new DbRegistry.RegistryError({
          message:
            `"${input.table}" holds configuration and this tool has no redaction route for it, so it ` +
            `will not read it back. Use \`configure\` — {"op":"read"} shows what this instance stores, ` +
            `with credentials redacted.`,
        })
      const page = yield* DbRegistry.rows({
        table: input.table,
        limit: clamp(input.limit, DEFAULT_LIMIT, MAX_LIMIT),
        offset,
      })
      return { ok: true, message: formatPage(redactPage(page), offset) }
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

// ── the write gate ────────────────────────────────────────────────────────────────────────────

/**
 * The permission action a row write spends. See the header for why it is not the tool's registered
 * name (`registry`), which the horizon filter reads and which therefore means *withdraw the whole
 * surface* rather than *do not write*.
 */
export const WRITE_ACTION = "registry_write"

/**
 * The table one call must be granted before it may write, or `undefined` when the call spends
 * nothing.
 *
 * Two shapes return `undefined` and they are different facts:
 *  · a READ (`tables`, `rows`) — ungated by design, paid for by the redaction below;
 *  · a table this tool already REFUSES to an agent — the refusal is the answer, and charging
 *    permission ahead of it would both hide that answer behind a generic denial and imply the write
 *    becomes possible once granted. It does not.
 *
 * Exported so the test drives the same predicate the executor does, rather than a copy of it.
 */
export const writeGate = (input: typeof Input.Type): string | undefined => {
  if (input.op === "tables" || input.op === "rows") return undefined
  // Read OFF the shared module's own sets. Restating them here is the hand-kept subset that goes
  // stale the first time a table is added to either one.
  if (DbRegistry.permissionKernelTables().has(input.table)) return undefined
  if (DbRegistry.configBackedTables().has(input.table)) return undefined
  return input.table
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
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
            execute: (input, context) =>
              Effect.gen(function* () {
                const table = writeGate(input)
                if (table !== undefined)
                  yield* permission.assert({
                    action: WRITE_ACTION,
                    // The ONE table, never `*`. `resources` is what a user's own
                    // `{action: "registry_write", resource: "credential"}` rule is matched against,
                    // so a wildcard here would make every rule an all-or-nothing one.
                    resources: [table],
                    // ⚠️ `save` is INERT today — retiring `ask` removed the only caller of
                    // `PermissionSaved.add`, so nothing a user can reach from a chat writes the
                    // saved-grant table (`permission.ts` → GRANT_IN_ADVANCE). It is scoped rather
                    // than omitted because the day it is live is not the day to remember why
                    // `configure.ts` argues `save: [key]`, never `save: ["*"]`.
                    save: [table],
                    metadata: { op: input.op, table },
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source: {
                      type: "tool" as const,
                      messageID: context.assistantMessageID,
                      callID: context.toolCallID,
                    },
                  })
                return yield* run(input)
              }).pipe(
                Effect.provideService(Database.Service, database),
                Effect.catchTag("DbRegistry.RegistryError", (error) => new ToolFailure({ message: error.message })),
                // A refusal must arrive AS a refusal — the deny-fast paragraph with the
                // grant-in-advance sentence, never a fallback line a model reads as transient and
                // retries (`absorb-ledger.test.ts`).
                Effect.mapError(Tool.absorb("Unable to reach the instance database")),
              ),
          }),
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/db-registry",
  layer,
  deps: [ToolRegistry.node, Database.node, PermissionV2.node],
})
