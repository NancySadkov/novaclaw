export * as DbRegistryView from "./db-registry-view"
import { ConfigProjection } from "./config-projection"
import { DbRegistry } from "./db-registry"

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
    if (columns !== undefined) for (const column of columns) if (column in values) values[column] = SECRET_CELL
    if (route?.kind === "entry") values[route.value] = redactEntryCell(values[route.key], values[route.value])
    if (route?.kind === "layers")
      values[route.value] = redactLayersCell(route.field, values[route.name], values[route.value])
    return DbRegistry.TableRow.make({ rowid: row.rowid, values })
  })
  return DbRegistry.TablePage.make({ table: page.table, columns: page.columns, rowCount: page.rowCount, rows })
}
