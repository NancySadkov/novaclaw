/**
 * `configure` — the agent-facing half of the self-healing law.
 *
 * AGENTS.md (*We promote self-healing: one working model can repair the system*): **"as long as at
 * least one working model remains, the system must be restorable to a working state by asking an
 * agent — never by hand-editing config files and never by rebuilding from source."** Every
 * operational fact an outage can hinge on already lives in a runtime-editable SQLite store behind
 * `ConfigStoreWrite`. Until this tool there was no path from a MODEL to that store: `PATCH /config`
 * is an HTTP surface, and nothing hands a session its own instance's URL or token
 * (`tool/bash.ts` injects `NOVACLAW_INSTANCE_<PEER>_*` for PEERS only). So the law was true of the
 * architecture and false of the product.
 *
 * ── WHY IN-PROCESS AND NOT OVER HTTP ───────────────────────────────────────────────────────────
 *
 * This calls `ConfigStoreWrite.apply` / `.overlay` directly. todo.md ruling 4 rules out the obvious
 * alternative by name — a self URL + token in the shell env — because it "converts a privileged
 * write into an uncontainable command string, and `egressEnv()` kills it in exactly the airgapped
 * case the law is written for". In-process also needs no port discovery and no listening server, so
 * it works in a headless CLI run and inside an airgap, which is where a repair is most likely needed.
 *
 * ── RULING 4: THE PRIVILEGE TIERS, AND WHAT ENFORCES THEM ──────────────────────────────────────
 *
 * *"Config writes are privilege-tiered — operational · consequential · privileged — enforced in the
 * permission evaluator's HARD arm behind an in-process `configure` tool, unclassified ⇒ privileged.
 * Tier-1 needs a fourth test beyond 'is it a value': no text that reaches a future session's prompt."*
 *
 * ⚠️ **The enforcement seam is the permission ACTION this tool spends, not the evaluator's hard arm,
 * and that is a correction to the ruling's wording rather than a shortcut.** The hard arm in
 * `permission.ts` is a pre-emptive DENY arm — checked before any allow is consulted, so nothing can
 * soften it. It can express one verdict. Tiering needs THREE (no card · a card · a card the user
 * cannot pre-grant with a single rule), and the machinery that already produces three verdicts from
 * an action name is the ordinary evaluator: the ambient-safe baseline, the agent ruleset, the mode
 * overlay and saved answers all key on `action`. Putting a table of config keys inside the evaluator
 * would also invert the layering — the permission kernel would have to import `Config.Info`.
 *
 * So the three tiers are three different asserts:
 *
 *  · **operational** — no assert at all. The key passes all three ambient-safe tests
 *    (`permission.ts` §AMBIENT-SAFE BASELINE: cannot mutate the host, cannot egress, cannot change
 *    what a later turn or session runs) AND ruling 4's fourth test (no text reaches a future
 *    session's prompt). A repair here costs the user nothing.
 *  · **consequential** — asserts `configure`. One card, `save` scoped to the KEY, so an "always"
 *    answer is a standing grant for that one key and for no other.
 *  · **privileged** — asserts `configure_privileged`. Same per-key `save`, but a SEPARATE action, so
 *    a user (or an agent config, or a saved "always") can grant every consequential write with one
 *    rule — `{action: "configure", resource: "*", effect: "allow"}` — while granting no privileged
 *    one. That is the whole mechanical difference between the two gated tiers, and it is the
 *    difference that matters: it is the only way to give an UNATTENDED run a repair capability
 *    without also giving it `plugins`, `mcp`, `shell` and `permissions`.
 *
 * Both actions are absent from `AMBIENT_SAFE_BASELINE`, so on a default install they fall through to
 * `evaluate`'s `ask`. Under an UNATTENDED chain that ask is converted to an immediate refusal by
 * `evaluateInput`'s last arm (`unattended-unanswerable`) — which is the correct answer and is
 * inherited for free: an unattended agent may make operational repairs, and needs a grant made in
 * advance for anything else.
 *
 * ⚠️ **`save: [key]`, never `save: ["*"]`.** `recipe.ts` argues this for a durable instance-global
 * write and the argument is stronger here: a wildcard "always" answered once for `tool_output` would
 * be a standing grant to rewrite `permissions` in every later session. Per-key is the honest price.
 *
 * ── WHERE THE TABLE LIVES ──────────────────────────────────────────────────────────────────────
 *
 * **`../config-tier.ts`** — `TIERS`, `TIER_ACTION`, `KEY_TIERS`, `tierOf` and `REDACTED`, re-exported
 * from here so this module's surface is unchanged. Read it for how a key is priced, why the
 * `Record<keyof Config.Info, Tier>` annotation is the ratchet, and why the operational tier is short.
 * It is a LEAF with no runtime import at all, and that is load-bearing rather than tidy: this tool
 * needs `config-projection.ts`, the projection needs the tiers, and while the two shared one file
 * that was an ESM cycle safe in only one import order — measured, and invisible to `tsgo`. The
 * ⚠️ at the head of `config-tier.ts` records the measurement; do not give that file a runtime import.
 *
 * ── WHAT THIS TOOL DELIBERATELY DOES NOT DO ────────────────────────────────────────────────────
 *
 * ⚠️ **`set` cannot DELETE a key, and that is now a ruling rather than a limitation** (item 4.3,
 * 2026-08-07). `ConfigStoreWrite` is patch-MERGE with no null-deletion, so a `null` SETS null; the
 * argument for refusing RFC-7396's tombstone is at the top of `merge-patch.ts`. Deletion is the
 * separate `remove` op below, over `ConfigStoreWrite.remove`. Saying which verb does what in the
 * description is ruling 2 — a model that believes it removed a setting and did not would report a
 * repair it never made, and before this op existed that was the only outcome available to it.
 *
 * ⚠️ **`read` redacts credentials and cannot un-redact them.** `overlay` returns everything the
 * settings store holds, including `server.password` (this instance's own incoming API token) and
 * every `instances[].token` (documented as granting a peer FULL API access, and ruling 5 calls the
 * peer token *account-equivalent*). Handing those to a model puts them in a transcript, a compaction
 * summary and possibly a messenger reply. `read` is ungated precisely BECAUSE it is redacted; if the
 * redaction is ever removed, the read op has to be gated in the same edit.
 *
 * ⚠️ **What DOES the redacting changed on 2026-08-07, and the old answer's cost was measured rather
 * than argued.** It was {@link redactSecrets} — a test over KEY NAMES — and half of this surface is
 * user-chosen record keys, so a name test cannot be right: `config-projection.test.ts` runs both
 * functions side by side over one document carrying a credential in every slot the schema declares
 * as one, and the name test **leaks three** (`mcp.servers.<n>.oauth.client_secret` and the values of
 * both `environment` maps) while **over-redacting** an MCP server a user happens to name `headers` —
 * handing its own `type` and `url` back as the redaction sentence, which makes that server's repair
 * unmakeable. `ConfigProjection.redact` walks the VALUE against the SCHEMA instead, so the
 * `ConfigAnnotation.secret` marker is the single source of truth and the ledger of what it covers is
 * pinned by name (`ConfigProjection.secretPaths()`). {@link redactSecrets} survives only as that
 * measurement's control — see its own note.
 *
 * ── THE `schema` OP: WHY A READ OF VALUES WAS NEVER ENOUGH ──────────────────────────────────────
 *
 * ⚠️ **This tool shipped telling the model "READ A KEY BEFORE YOU WRITE IT and follow the shape you
 * get back", and that instruction could not be followed.** `read` reports what the store HOLDS, so
 * the key a repair is most likely to target — one this instance has never set — reads back
 * `(not set)`, which is no shape at all; and where a value does exist it still cannot say which
 * fields are legal, which are required, or that `providers.<id>.api` is a union tagged on `type`
 * whose fragment decodes in no mode. That is AGENTS.md's own failure verbatim: *a repair path is only
 * real if someone has decoded it*, and a model told to copy a shape it cannot see is guessing.
 *
 * `{"op":"schema"}` is the other half — item 4.1's `ConfigProjection` made agent-reachable. It
 * describes the SCHEMA (meaning · legal values · constraints · declared defaults · `depends` · which
 * fields are secret · and the write shape, which is derived from the AST and re-decoded on every test
 * run rather than asserted). It asserts no permission for the same reason `read` does not — plus a
 * stronger one: it touches no stored value at all, so there is nothing in its reply to redact.
 *
 * ⚠️ **It is a new OP, never a new tool.** Reported degradation starts at 30–50
 * tools and we are past it; the closed-op-vocabulary shape (`kb`, `docs`) is the house pattern, and
 * `configure` is a DEFERRED core tool, so this costs **nothing** in the resident prompt — the
 * `location-layer.test.ts` ratchet measures the resident set and this is not in it.
 */
export * as ConfigureTool from "./configure"

import { ToolFailure } from "@novaclaw/llm"
import { Cause, Effect, Exit, Layer, Schema, SchemaIssue } from "effect"
import { AgentConfigStore } from "../agent-config-store"
import { CatalogStore } from "../catalog-store"
import { CommandConfigStore } from "../command-config-store"
import { Config } from "../config"
import { ConfigProjection } from "../config-projection"
import { ConfigStoreWrite } from "../config-store-write"
import { KEY_TIERS, REDACTED, TIER_ACTION, TIERS, tierOf, type Tier } from "../config-tier"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { CapabilityRegistry } from "../effect/capability-registry"
import { PermissionV2 } from "../permission"
import { ReferenceConfigStore } from "../reference-config-store"
import { SettingsConfigStore } from "../settings-config-store"
import { SkillConfigStore } from "../skill-config-store"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

/** ⚠️ The registered tool name is also the CONSEQUENTIAL tier's permission action
 *  (`ConfigTier.TIER_ACTION.consequential`), and those two literals now live in two files — the tier
 *  table is a leaf that may not import this module. `test/tool-configure.test.ts` pins the
 *  relationship in both directions, so a rename of either is a test failure rather than a silent
 *  split between the action a card asks for and the tool that spends it. */
export const name = "configure"

// ── the tiers ─────────────────────────────────────────────────────────────────────────────────

/**
 * Re-exported from `../config-tier.ts`, which OWNS them — see this file's header for why they had to
 * leave. Every existing `ConfigureTool.KEY_TIERS` / `.tierOf` / `.REDACTED` caller keeps working, and
 * a reader who lands here follows one hop to the table and its reasoning.
 */
export { KEY_TIERS, REDACTED, TIER_ACTION, TIERS, tierOf, type Tier }

/** Every key `Config.Info` declares, read off the schema rather than re-typed.
 *  A function, not a module-level constant: `config.ts` sits in an import cycle with the settings
 *  seed, and that file's own ⚠️ says every `Config.Info` derivation stays inside a function body. */
export const configKeys = (): string[] => Object.keys(Config.Info.fields)

// ── rendering (pure; unit-tested) ─────────────────────────────────────────────────────────────

/** Scalar fields whose value is a credential wherever it appears in a config document. */
const SECRET_FIELDS = new Set(["password", "token", "apikey", "api_key", "secret"])

/**
 * ⛔ **RETIRED FROM THE LIVE PATH 2026-08-07 (item 4.1). Do not call this from product code.** The
 * read op now redacts with `ConfigProjection.redact`, which walks the value against the SCHEMA.
 *
 * It is kept, exported, for exactly one reason: it is the **control** in the measurement that
 * licensed its own replacement. `config-projection.test.ts` runs both functions over one document and
 * records what each does — the marker hides every credential in it, this hides all but three
 * (`mcp.servers.<n>.oauth.client_secret`, and the values of both `environment` maps) and additionally
 * blanks the `type` and `url` of an MCP server a user named `headers`. Delete this function and that
 * comparison becomes a claim about a function nobody can run. **If it is ever deleted, the two lines
 * in `config-projection.test.ts` that import it go in the same edit** — a heuristic kept as a museum
 * piece with no test reading it is the cruft this repo names, and a control with no subject is worse.
 *
 * Why a name test cannot be repaired rather than replaced: half of this surface is USER-CHOSEN record
 * keys, so `mcp.servers.headers` (a server called "headers") and `mcp.servers.weather.headers` (a
 * bearer token) are the same string. The schema knows which is which; a string does not.
 */
export const redactSecrets = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactSecrets)
  if (value === null || typeof value !== "object") return value
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase()
    if (typeof entry === "string" && SECRET_FIELDS.has(lower)) {
      out[key] = REDACTED
      continue
    }
    // Request headers are the other place a user can park a bearer token by hand.
    if (lower === "headers" && entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      out[key] = Object.fromEntries(
        Object.entries(entry as Record<string, unknown>).map(([header, headerValue]) => [
          header,
          typeof headerValue === "string" ? REDACTED : redactSecrets(headerValue),
        ]),
      )
      continue
    }
    out[key] = redactSecrets(entry)
  }
  return out
}

/** Per-key value budget in the unfiltered read. A whole `providers` tree can be tens of kilobytes,
 *  and a repair loop that blows its own context on the survey never reaches the write. */
const SURVEY_LIMIT = 400
const DETAIL_LIMIT = 8_000

const render = (value: unknown, limit: number): string => {
  if (value === undefined) return "(not set)"
  const text = JSON.stringify(value) ?? String(value)
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}… (truncated — ask for this key on its own: {"op":"read","keys":["…"]})`
}

/** One line per key: what it is worth, and what it currently holds. */
export const formatRead = (input: {
  readonly keys: readonly string[]
  readonly values: Record<string, unknown>
  readonly filtered: boolean
}): string => {
  const limit = input.filtered ? DETAIL_LIMIT : SURVEY_LIMIT
  const lines = input.keys.map((key) => `${key} [${tierOf(key)}] = ${render(input.values[key], limit)}`)
  return [
    input.filtered
      ? "Requested configuration keys:"
      : `This instance's configuration — all ${input.keys.length} keys, with the privilege each write costs:`,
    ...lines,
    "",
    "operational = written without asking · consequential = one approval, per key · privileged = one approval, per key, and it cannot be pre-granted by a rule that covers consequential writes.",
    'Write with {"op":"set","config":{"<key>":<value>}}. Values MERGE (objects merge, arrays replace), so a null SETS null — delete with {"op":"remove","paths":[["<key>","<name>"]]}.',
  ].join("\n")
}

/** What actually landed. Ruling 2 — a key the router accepted and discarded is NOT reported as stored. */
export const formatWrite = (input: {
  readonly requested: readonly string[]
  readonly consumed: ReadonlySet<string>
}): string => {
  const stored = input.requested.filter((key) => input.consumed.has(key))
  const discarded = input.requested.filter((key) => !input.consumed.has(key))
  return [
    stored.length > 0
      ? `Saved to this instance's configuration: ${stored.join(", ")}. It is live now — no restart.`
      : "Nothing was stored.",
    discarded.length > 0
      ? `Accepted and DISCARDED (this instance stores no value for ${discarded.join(", ")}, so nothing changed there).`
      : "",
    'Read it back with {"op":"read","keys":["' + (stored[0] ?? input.requested[0] ?? "shell") + '"]}.',
  ]
    .filter(Boolean)
    .join("\n")
}

/** The refusal for a key `Config.Info` does not declare. The in-process twin of the wire's
 *  `rejectUnknownConfigKeys` 400, which names every offender rather than dropping them — because an
 *  agent that PATCHes a typo, is told nothing, re-reads and finds nothing cannot tell a typo from a
 *  broken instance, so it loops. */
export const unknownKeyMessage = (unknown: readonly string[], known: readonly string[]): string =>
  `Nothing was written. ${unknown.length === 1 ? "This is not a configuration key" : "These are not configuration keys"}: ` +
  `${unknown.map((key) => `"${key}"`).join(", ")}. ` +
  `The keys this instance has are: ${[...known].sort().join(", ")}. ` +
  `Call {"op":"read"} to see them with their current values.`

// ── the tool ──────────────────────────────────────────────────────────────────────────────────

/**
 * v0.2.0 item 4.1 — the DISCOVERY op. See the header for why a read of VALUES was never enough.
 *
 * `depth` is clamped rather than validated, because a model that asks for depth 40 has made a
 * harmless mistake and a refusal would cost it a turn to learn nothing. {@link MAX_SCHEMA_DEPTH} is a
 * budget, not a schema fact: the deepest key renders ~5.8 KB at depth 3 (measured 2026-08-07 over
 * every key), and past that the reply is larger than the repair.
 */
const MAX_SCHEMA_DEPTH = 4
const DEFAULT_SCHEMA_DEPTH = 1

/** The requested depth, made safe. A non-finite value falls back rather than propagating a `NaN`
 *  into `renderKey`, where it would silently render zero children and look like an empty schema. */
export const schemaDepth = (requested: number | undefined): number =>
  requested === undefined || !Number.isFinite(requested)
    ? DEFAULT_SCHEMA_DEPTH
    : Math.min(MAX_SCHEMA_DEPTH, Math.max(0, Math.trunc(requested)))

const SchemaOp = Schema.Struct({
  op: Schema.Literal("schema"),
  keys: Schema.Array(Schema.String)
    .pipe(Schema.optional)
    .annotate({
      description:
        'Configuration keys to describe in full, e.g. ["providers","mcp"]. Omit to survey every key, one ' +
        "line each.",
    }),
  depth: Schema.Number.pipe(Schema.optional).annotate({
    description:
      "How many levels of nested fields to expand under each requested key. Default 1, maximum 4; a " +
      "larger value is clamped, not refused. Only meaningful together with `keys`.",
  }),
})

const ReadOp = Schema.Struct({
  op: Schema.Literal("read"),
  keys: Schema.Array(Schema.String).pipe(Schema.optional).annotate({
    description:
      'Configuration keys to show in full, e.g. ["providers","model"]. Omit to survey every key (values abbreviated).',
  }),
})

const SetOp = Schema.Struct({
  op: Schema.Literal("set"),
  config: Schema.Record(Schema.String, Schema.Unknown).annotate({
    description:
      "A configuration patch: top-level configuration keys mapped to their new values, exactly the shape " +
      '`read` shows. Example: {"models":{"qwen":{"url":"http://192.168.1.5:8000/v1"}}}. ' +
      "Objects merge into what is stored; arrays replace wholesale. A key or a field this instance does " +
      "not have is refused and named, so read the key first if you are unsure of its shape.",
  }),
})

/**
 * v0.2.0 item 4.3 — the DELETE op. Until 2026-08-07 this tool could genuinely not remove anything
 * and said so; `ConfigStoreWrite.remove` is the verb that changed that, and leaving the tool without
 * it would have kept the self-healing law true only for whoever can reach raw HTTP.
 *
 * ⚠️ **Paths are SEGMENT ARRAYS, not dotted strings**, and this is the field a model is most likely
 * to get wrong. Config ids routinely contain dots and slashes (`holo3.1`, `openai/gpt-oss-120b`), so
 * a dotted path would name nothing — the description says so with the worked example, because the
 * shape a model copies is the shape it sees.
 */
const RemoveOp = Schema.Struct({
  op: Schema.Literal("remove"),
  paths: Schema.Array(Schema.Array(Schema.String)).annotate({
    description:
      "Configuration locations to delete, each an ARRAY OF SEGMENTS (never a dotted string — config " +
      'ids contain dots and slashes). Examples: ["mcp","servers","filesystem"] removes one MCP server; ' +
      '["providers","spark-holo","models","holo3.1"] removes one stale model and keeps its provider; ' +
      '["model"] clears the default model. Applied all-or-nothing: if any path names nothing, NOTHING ' +
      "is removed and the reply says which one.",
  }),
})

const RetryOp = Schema.Struct({
  op: Schema.Literal("retry"),
  capability: Schema.String.annotate({
    description:
      'The exact capability name from its unavailable notice, e.g. "memory" or "local-model". ' +
      "Retries one cached startup failure after its repair; it does not restart the instance.",
  }),
})

export const Input = Schema.Union([SchemaOp, ReadOp, SetOp, RemoveOp, RetryOp])

export const Output = Schema.Struct({
  op: Schema.Literals(["schema", "read", "set", "remove", "retry"]),
  message: Schema.String,
})
export type Output = typeof Output.Type

/**
 * ⚠️ **Every sentence here is a claim about what the tool does, and two of them had rotted** — the
 * defect class this file was corrected for twice on 2026-08-07 (the description said *"this tool
 * cannot DELETE a key"* after `remove` shipped, and *"READ A KEY BEFORE YOU WRITE IT and follow the
 * shape you get back"*, which `read` cannot supply for a key this instance has never set). When you
 * add an op, re-read all of this, not the line you are adding.
 */
export const description =
  "Repair or change THIS instance's own configuration — provider endpoints, models, presets, and every " +
  "instance setting — without editing files or restarting. Ops: " +
  '{"op":"schema"} — every configuration key in one line: what it is and what changing it costs · ' +
  '{"op":"schema","keys":["providers"],"depth":2} — one key\'s FIELDS: what each means, its legal ' +
  "values, and the exact shape a write must take · " +
  '{"op":"read"} — what this instance currently HOLDS, every key · ' +
  '{"op":"read","keys":["providers"]} — one key\'s current value in full · ' +
  '{"op":"set","config":{"models":{"qwen":{"url":"http://192.168.1.5:8000/v1"}}}} — write · ' +
  '{"op":"remove","paths":[["mcp","servers","filesystem"]]} — DELETE. ' +
  '{"op":"retry","capability":"memory"} — retry one cached capability failure after repairing it. ' +
  "ASK FOR THE SCHEMA BEFORE YOU WRITE A KEY YOU HAVE NOT WRITTEN BEFORE: `read` shows a VALUE and " +
  "shows nothing at all for a key that was never set, while `schema` always names the fields, says " +
  "which are required, and says whether a fragment is enough — some keys refuse a partial patch " +
  "outright, so a guessed fragment is rejected whole. A field name this instance does not have is " +
  "refused by name rather than quietly dropped. " +
  "Values MERGE into what is stored (objects merge, arrays replace wholesale), so `set` can never " +
  "remove anything — a null SETS null. Use `remove`, whose paths are ARRAYS OF SEGMENTS, never " +
  "dotted strings. Most writes ask the user first and say so before anything is stored; a write that " +
  "is refused changes nothing at all. Credentials are writable and never read back."

const failure = (message: string) => new ToolFailure({ message })

/**
 * ⚠️ `onExcessProperty: "error"`, which is a DELIBERATE divergence from every other decode of
 * `Config.Info` in the tree, and the reason is ruling 2.
 *
 * The unknown-key guard above only sees TOP-LEVEL keys — so does the wire's `rejectUnknownConfigKeys`
 * — which leaves a nested typo decoding to an EMPTY object, committing nothing, and answering
 * SUCCESS. Measured 2026-07-31 under the tree's usual lenient options: `{tool_output:{max_linez:5}}`
 * and `{mcp:{servers:{fs:{type:"local",command:["x"],enabled:true}}}}` (the field is `disabled`) both
 * report a saved write and store nothing that was asked for. That is the same silent-drop shape the
 * wire guard was written to close, one level down, and it is the shape a MODEL produces — it guesses
 * a field name far more often than it invents a top-level key.
 *
 * The two other decoders keep `"ignore"` for reasons that do not apply to a tool call: the SEED reads
 * a hand-authored file that may have been written for any version of NovaClaw and is applied at boot
 * with nobody to answer, and `settings-config-seed.ts` already argues that ignoring is the
 * recoverable behaviour THERE. A tool call is a deliberate mutation with a live caller who can act on
 * "that field does not exist" and cannot act on silence.
 *
 * ⚠️ Being stricter than `PATCH /config` is only defensible while the shapes the self-healing law
 * depends on still decode, so that was MEASURED before this was adopted rather than assumed: over 29
 * realistic patches, `"error"` and `"ignore"` differed on exactly three — and all three were invented
 * field names (`agents.*.temperature`, `mcp.*.enabled`, `resource_pressure.memory.*`), i.e. three for
 * three in the honest direction. The accepted shapes are pinned in `test/tool-configure.test.ts`
 * ("the endpoint repairs the self-healing law depends on are accepted verbatim"), so if this ever
 * refuses a real repair, THAT test fails and this option is what is wrong.
 */
const DECODE_OPTIONS = { errors: "all", onExcessProperty: "error", propertyOrder: "original" } as const

/**
 * A decode failure, as a sentence that names the FIELD.
 *
 * ⚠️ The path is the load-bearing half and it is not in `issue.message` — `settings-config-seed.ts`'s
 * `decodeFailureReason` joins the messages alone, which is right there (it already knows the key,
 * because it probes one key at a time and reports the key beside the reason) and useless here:
 * measured 2026-07-31, a `tool_output.max_linez` typo formats as *"Unexpected key with value 5"*,
 * which tells a repairing agent nothing it can act on. Rendering `path` turns it into
 * *"tool_output.max_linez: Unexpected key with value 5"*, which is the next tool call.
 */
const decodeReason = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause)
  if (Schema.isSchemaError(error)) {
    const issues = SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues.map((issue) => {
      const path = (issue.path ?? []).map((segment) => String(segment)).join(".")
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message
    })
    if (issues.length > 0) return issues.join("; ")
  }
  return String(error)
}

/**
 * Decode the model's object into a `Config.Info` patch, naming the OFFENDING KEY on failure.
 *
 * Whole-document first (the common case, and the only one that costs nothing), then a per-key probe
 * to attribute the failure — every `Config.Info` field is optional, so a single-key object is a valid
 * probe. That is `settings-config-seed.ts`'s salvage trick used for a different purpose: not to keep
 * the good keys, but so the message says WHICH key was wrong instead of dumping a union mismatch.
 */
export const decodePatch = (values: Record<string, unknown>): Effect.Effect<Config.Info, ToolFailure> =>
  Effect.suspend(() => {
    const whole = Schema.decodeUnknownExit(Config.Info)(values, DECODE_OPTIONS)
    if (Exit.isSuccess(whole)) return Effect.succeed(whole.value)
    const offenders: string[] = []
    for (const [key, value] of Object.entries(values)) {
      const one = Schema.decodeUnknownExit(Config.Info)({ [key]: value }, DECODE_OPTIONS)
      if (Exit.isFailure(one)) offenders.push(`"${key}" — ${decodeReason(one.cause)}`)
    }
    return Effect.fail(
      failure(
        `Nothing was written: the value does not fit the configuration schema. ${
          offenders.length > 0 ? offenders.join(" · ") : decodeReason(whole.cause)
        }. Call {"op":"read","keys":[…]} to see the shape this instance stores today.`,
      ),
    )
  })

export const metadata = { description, input: Input, output: Output } as const

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const capabilities = yield* CapabilityRegistry.Service
    // The stores `ConfigStoreWrite.apply`/`overlay` resolve at call time. Captured once here rather
    // than threaded per call, because `Tool.make`'s `execute` must have `R = never` — the same
    // capture `filesystem/watcher.ts` and `pty.ts` use for their callbacks. Listing the union
    // explicitly is what makes the node's `deps` below a checkable claim rather than a guess.
    const stores = yield* Effect.context<
      | Database.Service
      | SettingsConfigStore.Service
      | CatalogStore.Service
      | AgentConfigStore.Service
      | CommandConfigStore.Service
      | ReferenceConfigStore.Service
      | SkillConfigStore.Service
    >()

    yield* tools
      .register({
        [name]: Tool.withDeferred(
          Tool.make({
            ...metadata,
            toModelOutput: ({ output }) => [{ type: "text", text: output.message }],
            execute: (input, context) =>
              Effect.gen(function* () {
                const known = configKeys()

                if (input.op === "schema") {
                  // Same empty-array reading as `read`: an all-blank `keys` means "no filter", never
                  // "describe nothing" — a header promising a key's fields over zero lines would be a
                  // report that describes itself falsely.
                  const trimmed = input.keys?.map((key) => key.trim()).filter((key) => key.length > 0)
                  const requested = trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined
                  if (requested === undefined)
                    return {
                      op: "schema" as const,
                      message: [
                        ConfigProjection.renderOverview(),
                        'Ask for one key with {"op":"schema","keys":["providers"],"depth":2} to see its fields, ' +
                          "their legal values and the shape a write to it must take. " +
                          '`schema` describes the SHAPE; {"op":"read"} shows what this instance currently HOLDS.',
                      ].join("\n"),
                    }
                  const unknown = requested.filter((key) => !known.includes(key))
                  if (unknown.length > 0) return yield* failure(unknownKeyMessage(unknown, known))
                  const depth = schemaDepth(input.depth)
                  return {
                    op: "schema" as const,
                    message: [
                      ...requested.map((key) => ConfigProjection.renderKey(key, depth)),
                      // ⚠️ The projection's `remove:` line names `POST /api/config/remove`, because the
                      // projection also serves the HTTP surface. A MODEL cannot reach that — nothing
                      // hands a session its own instance's URL or token, which is the whole reason this
                      // tool is in-process (see the header). Naming the verb it CAN spend, right here,
                      // is ruling 2: an instruction the reader cannot follow is worse than none.
                      'From this tool the same delete is {"op":"remove","paths":[["<key>","<segment>"]]} — the ' +
                        'same segment arrays that line prints. Write with {"op":"set","config":{…}}, and read ' +
                        'the current value with {"op":"read","keys":[…]}.',
                    ].join("\n\n"),
                  }
                }

                if (input.op === "read") {
                  // An empty (or all-blank) `keys` array means "no filter" rather than "show nothing":
                  // rendering zero lines under a "Requested configuration keys:" header would be a
                  // report that describes itself falsely.
                  const trimmed = input.keys?.map((key) => key.trim()).filter((key) => key.length > 0)
                  const requested = trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined
                  if (requested !== undefined) {
                    const unknown = requested.filter((key) => !known.includes(key))
                    if (unknown.length > 0) return yield* failure(unknownKeyMessage(unknown, known))
                  }
                  const stored = yield* ConfigStoreWrite.overlay({}).pipe(Effect.provide(stores))
                  // Redact BEFORE anything can be rendered: `overlay` returns `server.password` and
                  // every peer token verbatim, and a model that has seen one has put it in a
                  // transcript. See the ⚠️ in this file's header.
                  //
                  // ⚠️ The redactor is the SCHEMA walk, not the name test this file used to carry —
                  // the swap is licensed by the side-by-side measurement in `config-projection.test.ts`
                  // rather than by the argument, and `redactSecrets` is retained only as its control.
                  const values = ConfigProjection.redact(stored) as Record<string, unknown>
                  return {
                    op: "read" as const,
                    message: formatRead({
                      keys: requested ?? known,
                      values,
                      filtered: requested !== undefined,
                    }),
                  }
                }

                if (input.op === "retry") {
                  const capability = input.capability.trim()
                  if (capability.length === 0)
                    return yield* failure(
                      "Nothing was retried: `capability` was blank. Copy the exact name from the unavailable notice.",
                    )
                  const status = yield* capabilities
                    .retry(capability)
                    .pipe(
                      Effect.catchTag("CapabilityRegistry.NotFoundError", () =>
                        capabilities
                          .inspect()
                          .pipe(
                            Effect.flatMap((declared) =>
                              Effect.fail(
                                failure(
                                  `Nothing was retried: this instance has no capability named "${capability}". ` +
                                    (declared.length === 0
                                      ? "This graph declares no optional capabilities."
                                      : `Available capabilities: ${declared.map((entry) => entry.name).join(", ")}.`),
                                ),
                              ),
                            ),
                          ),
                      ),
                    )
                  if (status.state === "unavailable")
                    return {
                      op: "retry" as const,
                      message:
                        `Capability "${capability}" is still unavailable after retry: ${status.reason.summary}` +
                        (status.reason.repair?.length
                          ? ` Repairable settings: ${status.reason.repair.join(", ")}.`
                          : ""),
                    }
                  if (status.state === "idle")
                    return {
                      op: "retry" as const,
                      message: `Capability "${capability}" has no cached failure to retry and remains idle.`,
                    }
                  return {
                    op: "retry" as const,
                    message: `Capability "${capability}" is ${status.state} after retry.`,
                  }
                }

                if (input.op === "remove") {
                  const paths = input.paths.filter((path) => path.length > 0)
                  if (paths.length === 0)
                    return yield* failure(
                      "Nothing was removed: `paths` was empty. Name at least one location, e.g. " +
                        '{"op":"remove","paths":[["mcp","servers","filesystem"]]}.',
                    )
                  // The first segment is the config key, so a removal is priced exactly like a write
                  // to that key — same `KEY_TIERS` table, same cards, same "answer before anything is
                  // written" ordering. Deleting `agents` is not cheaper than editing it.
                  const targets = [...new Set(paths.map((path) => path[0]!))]
                  const unknown = targets.filter((key) => !known.includes(key))
                  if (unknown.length > 0) return yield* failure(unknownKeyMessage(unknown, known))
                  for (const tier of ["consequential", "privileged"] as const) {
                    const keys = targets.filter((key) => tierOf(key) === tier)
                    if (keys.length === 0) continue
                    yield* permission.assert({
                      action: TIER_ACTION[tier],
                      resources: keys,
                      save: keys,
                      metadata: { tier, paths: paths.filter((path) => keys.includes(path[0]!)) },
                      sessionID: context.sessionID,
                      agent: context.agent,
                      source: {
                        type: "tool" as const,
                        messageID: context.assistantMessageID,
                        callID: context.toolCallID,
                      },
                    })
                  }
                  const outcome = yield* ConfigStoreWrite.remove(paths).pipe(Effect.provide(stores), Effect.exit)
                  if (Exit.isFailure(outcome))
                    // The refusal message already names every offending path and says the whole
                    // request rolled back — passing it through beats paraphrasing it into something
                    // the model cannot act on.
                    return yield* failure(`Nothing was removed. The kernel reported: ${decodeReason(outcome.cause)}`)
                  const cleared = outcome.value.cleared
                  return {
                    op: "remove" as const,
                    message: [
                      `Removed from this instance's configuration: ${paths
                        .map((path) => path.join(" → "))
                        .join(", ")}. It is live now — no restart.`,
                      cleared.length > 0
                        ? `Also cleared ${cleared.join(", ")}, which pointed at something just removed — a ` +
                          `default left dangling reads as configured and resolves to nothing. Set a new one.`
                        : "",
                      `Read it back with {"op":"read","keys":["${paths[0]![0]}"]}.`,
                    ]
                      .filter(Boolean)
                      .join("\n"),
                  }
                }

                const requested = Object.keys(input.config).filter((key) => input.config[key] !== undefined)
                if (requested.length === 0)
                  return yield* failure(
                    'Nothing was written: `config` was empty. Name at least one key, e.g. {"op":"set","config":{"shell":"bash"}}.',
                  )
                // Refuse an undeclared key BY NAME before anything else runs. The schema decode below
                // would silently drop it (`onExcessProperty: "ignore"`), which is precisely the ruling-2
                // violation the wire path closed with `rejectUnknownConfigKeys`.
                const unknown = requested.filter((key) => !known.includes(key))
                if (unknown.length > 0) return yield* failure(unknownKeyMessage(unknown, known))

                const patch = yield* decodePatch(input.config)

                // One assert per GATED tier, carrying only that tier's keys — so the card names what it
                // is really about, and a saved "always" is scoped to those keys and that tier's action.
                //
                // ⚠️ BOTH cards are answered BEFORE anything is written, which is the only arrangement
                // that matches `apply`'s all-or-nothing transaction: approving the consequential card
                // and refusing the privileged one writes NEITHER, rather than half the patch. A refused
                // second card leaves the store exactly as it was.
                //
                // ⚠️ And a `configure_privileged -> deny` rule does NOT withdraw the tool: the horizon
                // filter (`registry.ts` `whollyDisabled`) resolves the REGISTERED name, so it keys on
                // `configure`. That is the behaviour we want — denying privileged writes must leave
                // `read` and the operational tier working, since that is the half a locked-down
                // instance still needs. Denying `configure` itself withdraws the whole tool.
                const source = {
                  type: "tool" as const,
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                }
                for (const tier of ["consequential", "privileged"] as const) {
                  const keys = requested.filter((key) => tierOf(key) === tier)
                  if (keys.length === 0) continue
                  yield* permission.assert({
                    action: TIER_ACTION[tier],
                    resources: keys,
                    save: keys,
                    // The values are not in `resources` on purpose: `resources` doubles as the saved
                    // rule pattern, so a value there would make every "always" answer a dead rule that
                    // matches one exact string. They ride `metadata`, the channel the attachment
                    // protection already uses for "why is this being asked".
                    metadata: { tier, values: Object.fromEntries(keys.map((key) => [key, input.config[key]])) },
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                }

                const exit = yield* ConfigStoreWrite.apply(patch).pipe(Effect.provide(stores), Effect.exit)
                if (Exit.isFailure(exit)) {
                  // ⚠️ Ruling 2 IN BOTH DIRECTIONS, which is why this does not paraphrase. `apply` can
                  // fault two ways and they have opposite outcomes: an unrouted key rolls the whole
                  // write back, while a domain that could not re-materialise leaves the write COMMITTED
                  // and merely not live. Both messages are written for exactly this reader and both say
                  // which case they are, so the tool passes them through under a prefix that claims
                  // neither. Calling the second one "failed" would send the model to re-send a write
                  // that already landed.
                  return yield* failure(
                    `The configure write did not finish cleanly. The kernel reported: ${decodeReason(exit.cause)}`,
                  )
                }
                return { op: "set" as const, message: formatWrite({ requested, consumed: exit.value }) }
              }).pipe(
                Effect.mapError((error) => {
                  if (error instanceof ToolFailure) return error
                  // ⚠️ The verb matters, and this used to be "written" unconditionally. Telling a
                  // model that nothing was *written* when it asked to *remove* describes the outcome
                  // in the wrong vocabulary, and this tool's whole contract is that the model can
                  // trust what it is told about its own repair (ruling 2). The same argument covers
                  // the two reading ops: "nothing was written" after a failed `read`/`schema` invites
                  // a model to go looking for the write it never asked for.
                  const nothing = {
                    schema: "Nothing was described.",
                    read: "Nothing was read.",
                    set: "Nothing was written.",
                    remove: "Nothing was removed.",
                    retry: "Nothing was retried.",
                  }[input.op]
                  // A denial keeps its identity — including the unattended deny-fast wording, which is
                  // the one an unattended repair run actually needs to read.
                  const denial = PermissionV2.denialMessage(error)
                  if (denial) return failure(`${nothing} ${denial}`)
                  return failure(`configure failed: ${error instanceof Error ? error.message : String(error)}`)
                }),
              ),
          }),
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/configure",
  layer,
  deps: [
    ToolRegistry.node,
    PermissionV2.node,
    Database.node,
    SettingsConfigStore.node,
    CatalogStore.node,
    AgentConfigStore.node,
    CommandConfigStore.node,
    ReferenceConfigStore.node,
    SkillConfigStore.node,
    CapabilityRegistry.node,
  ],
})
